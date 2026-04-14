import Database from "better-sqlite3";
import { customAlphabet } from "nanoid";
import type {
  AgentConfig,
  CreateAgentRequest,
  Session,
  SessionStatus,
} from "../orchestrator/types.js";
import type { AgentStore, RunUsage, SessionStore, Store } from "./types.js";

const nanoid = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 12);

// ---------- Row shapes ----------

type AgentRow = {
  agent_id: string;
  model: string;
  tools_json: string;
  instructions: string;
  name: string | null;
  created_at: number;
};

type SessionRow = {
  session_id: string;
  agent_id: string;
  status: string;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  error: string | null;
  created_at: number;
  last_event_at: number | null;
};

function rowToAgent(r: AgentRow): AgentConfig {
  return {
    agentId: r.agent_id,
    model: r.model,
    tools: JSON.parse(r.tools_json) as string[],
    instructions: r.instructions,
    name: r.name ?? undefined,
    createdAt: r.created_at,
  };
}

function rowToSession(r: SessionRow): Session {
  return {
    sessionId: r.session_id,
    agentId: r.agent_id,
    status: r.status as SessionStatus,
    tokensIn: r.tokens_in,
    tokensOut: r.tokens_out,
    costUsd: r.cost_usd,
    error: r.error,
    createdAt: r.created_at,
    lastEventAt: r.last_event_at,
  };
}

// ---------- Schema bootstrap ----------

// Applied once per database. Idempotent — every CREATE uses IF NOT EXISTS.
// When the schema needs to evolve, introduce explicit migrations; this block
// is intentionally not migration-aware because the MVP has no deployed data.
//
// Events are intentionally NOT a SQLite table. The source of truth for events
// is OpenClaw's per-session JSONL on the host mount, written by the pi-ai
// SessionManager. PiJsonlEventReader (src/store/pi-jsonl.ts) reads them at
// query time. If you find an `events` table in an older SQLite file, it is
// a vestigial Item 3 artifact that this file no longer touches.
//
// Cascade choice:
//   sessions -> agents : NO CASCADE. Sessions outlive their template. An
//                        agent template is a factory — once a session is
//                        created, the session carries all the config it
//                        needs (via its event history on disk and its
//                        tokens rollup), so deleting the template does
//                        not invalidate past sessions.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  agent_id TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  tools_json TEXT NOT NULL,
  instructions TEXT NOT NULL,
  name TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('idle', 'running', 'failed')),
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  error TEXT,
  created_at INTEGER NOT NULL,
  last_event_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_sessions_agent_id ON sessions(agent_id);
`;

// ---------- Agent store ----------

class SqliteAgentStore implements AgentStore {
  private readonly insertStmt: Database.Statement;
  private readonly getStmt: Database.Statement;
  private readonly listStmt: Database.Statement;
  private readonly deleteStmt: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.insertStmt = db.prepare(
      `INSERT INTO agents (agent_id, model, tools_json, instructions, name, created_at)
       VALUES (@agent_id, @model, @tools_json, @instructions, @name, @created_at)`,
    );
    this.getStmt = db.prepare(`SELECT * FROM agents WHERE agent_id = ?`);
    this.listStmt = db.prepare(`SELECT * FROM agents ORDER BY created_at ASC`);
    this.deleteStmt = db.prepare(`DELETE FROM agents WHERE agent_id = ?`);
  }

  create(req: CreateAgentRequest): AgentConfig {
    const agent: AgentConfig = {
      agentId: `agt_${nanoid()}`,
      model: req.model,
      tools: req.tools,
      instructions: req.instructions,
      name: req.name,
      createdAt: Date.now(),
    };
    this.insertStmt.run({
      agent_id: agent.agentId,
      model: agent.model,
      tools_json: JSON.stringify(agent.tools),
      instructions: agent.instructions,
      name: agent.name ?? null,
      created_at: agent.createdAt,
    });
    return agent;
  }

  get(agentId: string): AgentConfig | undefined {
    const row = this.getStmt.get(agentId) as AgentRow | undefined;
    return row ? rowToAgent(row) : undefined;
  }

  list(): AgentConfig[] {
    const rows = this.listStmt.all() as AgentRow[];
    return rows.map(rowToAgent);
  }

  delete(agentId: string): boolean {
    const info = this.deleteStmt.run(agentId);
    return info.changes > 0;
  }
}

// ---------- Session store ----------

class SqliteSessionStore implements SessionStore {
  private readonly insertStmt: Database.Statement;
  private readonly getStmt: Database.Statement;
  private readonly listStmt: Database.Statement;
  private readonly deleteStmt: Database.Statement;
  private readonly beginRunStmt: Database.Statement;
  private readonly endSuccessStmt: Database.Statement;
  private readonly endFailureStmt: Database.Statement;
  private readonly endCancelledStmt: Database.Statement;
  private readonly addUsageStmt: Database.Statement;
  private readonly failRunningStmt: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.insertStmt = db.prepare(
      `INSERT INTO sessions (
        session_id, agent_id, status, tokens_in, tokens_out, cost_usd,
        error, created_at, last_event_at
       ) VALUES (
        @session_id, @agent_id, 'idle', 0, 0, 0, NULL, @created_at, NULL
       )`,
    );
    this.getStmt = db.prepare(`SELECT * FROM sessions WHERE session_id = ?`);
    this.listStmt = db.prepare(`SELECT * FROM sessions ORDER BY created_at ASC`);
    this.deleteStmt = db.prepare(`DELETE FROM sessions WHERE session_id = ?`);
    this.beginRunStmt = db.prepare(
      `UPDATE sessions
       SET status = 'running', error = NULL, last_event_at = @now
       WHERE session_id = @session_id`,
    );
    this.endSuccessStmt = db.prepare(
      `UPDATE sessions
       SET status = 'idle',
           tokens_in = tokens_in + @ti,
           tokens_out = tokens_out + @to,
           cost_usd = cost_usd + @cost,
           last_event_at = @now
       WHERE session_id = @session_id`,
    );
    this.endFailureStmt = db.prepare(
      `UPDATE sessions
       SET status = 'failed', error = @error, last_event_at = @now
       WHERE session_id = @session_id`,
    );
    this.endCancelledStmt = db.prepare(
      `UPDATE sessions
       SET status = 'idle', error = NULL, last_event_at = @now
       WHERE session_id = @session_id`,
    );
    this.addUsageStmt = db.prepare(
      `UPDATE sessions
       SET tokens_in = tokens_in + @ti,
           tokens_out = tokens_out + @to,
           cost_usd = cost_usd + @cost,
           last_event_at = @now
       WHERE session_id = @session_id`,
    );
    this.failRunningStmt = db.prepare(
      `UPDATE sessions
       SET status = 'failed', error = @reason, last_event_at = @now
       WHERE status = 'running'`,
    );
  }

  create(args: { agentId: string; sessionId?: string }): Session {
    const sessionId = args.sessionId ?? `ses_${nanoid()}`;
    const createdAt = Date.now();
    this.insertStmt.run({
      session_id: sessionId,
      agent_id: args.agentId,
      created_at: createdAt,
    });
    return {
      sessionId,
      agentId: args.agentId,
      status: "idle",
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      error: null,
      createdAt,
      lastEventAt: null,
    };
  }

  get(sessionId: string): Session | undefined {
    const row = this.getStmt.get(sessionId) as SessionRow | undefined;
    return row ? rowToSession(row) : undefined;
  }

  list(): Session[] {
    const rows = this.listStmt.all() as SessionRow[];
    return rows.map(rowToSession);
  }

  delete(sessionId: string): boolean {
    const info = this.deleteStmt.run(sessionId);
    return info.changes > 0;
  }

  beginRun(sessionId: string): Session | undefined {
    const info = this.beginRunStmt.run({ session_id: sessionId, now: Date.now() });
    if (info.changes === 0) return undefined;
    return this.get(sessionId);
  }

  endRunSuccess(sessionId: string, usage: RunUsage): Session | undefined {
    const info = this.endSuccessStmt.run({
      session_id: sessionId,
      ti: usage.tokensIn,
      to: usage.tokensOut,
      cost: usage.costUsd,
      now: Date.now(),
    });
    if (info.changes === 0) return undefined;
    return this.get(sessionId);
  }

  endRunFailure(sessionId: string, error: string): Session | undefined {
    const info = this.endFailureStmt.run({
      session_id: sessionId,
      error,
      now: Date.now(),
    });
    if (info.changes === 0) return undefined;
    return this.get(sessionId);
  }

  endRunCancelled(sessionId: string): Session | undefined {
    const info = this.endCancelledStmt.run({
      session_id: sessionId,
      now: Date.now(),
    });
    if (info.changes === 0) return undefined;
    return this.get(sessionId);
  }

  addUsage(sessionId: string, usage: RunUsage): Session | undefined {
    const info = this.addUsageStmt.run({
      session_id: sessionId,
      ti: usage.tokensIn,
      to: usage.tokensOut,
      cost: usage.costUsd,
      now: Date.now(),
    });
    if (info.changes === 0) return undefined;
    return this.get(sessionId);
  }

  failRunningSessions(reason: string): number {
    const info = this.failRunningStmt.run({ reason, now: Date.now() });
    return info.changes;
  }
}

// ---------- Bundle ----------

export class SqliteStore implements Store {
  readonly agents: AgentStore;
  readonly sessions: SessionStore;
  private readonly db: Database.Database;
  private closed = false;

  constructor(path: string) {
    this.db = new Database(path);
    // WAL gives concurrent readers while one writer is active, which matters
    // as soon as more than one orchestrator thread/worker is introduced.
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    // Enforce foreign-key constraints at the SQLite level so cascading
    // deletes and referential integrity actually happen.
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA);

    this.agents = new SqliteAgentStore(this.db);
    this.sessions = new SqliteSessionStore(this.db);
  }

  close(): void {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }
}
