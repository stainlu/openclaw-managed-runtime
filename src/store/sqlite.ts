import Database from "better-sqlite3";
import { customAlphabet } from "nanoid";
import type {
  AgentConfig,
  CreateAgentRequest,
  CreateEnvironmentRequest,
  EnvironmentConfig,
  McpServers,
  Networking,
  Packages,
  PermissionPolicy,
  Quota,
  Session,
  SessionStatus,
  ThinkingLevel,
  UpdateAgentRequest,
} from "../orchestrator/types.js";
import type {
  AgentStore,
  AuditRecord,
  AuditStore,
  EnvironmentStore,
  QueuedEvent,
  QueueStore,
  RunUsage,
  SecretStore,
  SessionStore,
  Store,
} from "./types.js";

const nanoid = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 12);

// ---------- Row shapes ----------

type AgentRow = {
  agent_id: string;
  model: string;
  tools_json: string;
  instructions: string;
  permission_policy_json: string | null;
  name: string | null;
  created_at: number;
  updated_at: number | null;
  archived_at: number | null;
  version: number;
  callable_agents_json: string | null;
  max_subagent_depth: number;
  mcp_servers_json: string | null;
  quota_json: string | null;
  thinking_level: string | null;
};

type EnvironmentRow = {
  environment_id: string;
  name: string;
  packages_json: string | null;
  networking_json: string;
  created_at: number;
};

type SessionRow = {
  session_id: string;
  agent_id: string;
  environment_id: string | null;
  status: string;
  ephemeral: number;
  remaining_subagent_depth: number;
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
    permissionPolicy: r.permission_policy_json
      ? (JSON.parse(r.permission_policy_json) as PermissionPolicy)
      : { type: "always_allow" },
    name: r.name ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at ?? r.created_at,
    archivedAt: r.archived_at,
    version: r.version ?? 1,
    callableAgents: r.callable_agents_json
      ? (JSON.parse(r.callable_agents_json) as string[])
      : [],
    maxSubagentDepth: r.max_subagent_depth,
    mcpServers: r.mcp_servers_json
      ? (JSON.parse(r.mcp_servers_json) as McpServers)
      : {},
    quota: r.quota_json ? (JSON.parse(r.quota_json) as Quota) : undefined,
    thinkingLevel: (r.thinking_level as ThinkingLevel | null) ?? "off",
  };
}

function rowToEnvironment(r: EnvironmentRow): EnvironmentConfig {
  return {
    environmentId: r.environment_id,
    name: r.name,
    packages: r.packages_json ? (JSON.parse(r.packages_json) as Packages) : null,
    networking: JSON.parse(r.networking_json) as Networking,
    createdAt: r.created_at,
  };
}

function rowToSession(r: SessionRow): Session {
  return {
    sessionId: r.session_id,
    agentId: r.agent_id,
    environmentId: r.environment_id,
    status: r.status as SessionStatus,
    ephemeral: r.ephemeral === 1,
    remainingSubagentDepth: r.remaining_subagent_depth,
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
  created_at INTEGER NOT NULL,
  updated_at INTEGER,
  archived_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  callable_agents_json TEXT,
  max_subagent_depth INTEGER NOT NULL DEFAULT 0,
  mcp_servers_json TEXT,
  quota_json TEXT,
  thinking_level TEXT
);

CREATE TABLE IF NOT EXISTS agent_versions (
  agent_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  model TEXT NOT NULL,
  tools_json TEXT NOT NULL,
  instructions TEXT NOT NULL,
  permission_policy_json TEXT,
  name TEXT,
  callable_agents_json TEXT,
  max_subagent_depth INTEGER NOT NULL DEFAULT 0,
  mcp_servers_json TEXT,
  quota_json TEXT,
  thinking_level TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (agent_id, version)
);

CREATE TABLE IF NOT EXISTS environments (
  environment_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  packages_json TEXT,
  networking_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('idle', 'running', 'failed')),
  ephemeral INTEGER NOT NULL DEFAULT 0,
  remaining_subagent_depth INTEGER NOT NULL DEFAULT 0,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  error TEXT,
  created_at INTEGER NOT NULL,
  last_event_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_sessions_agent_id ON sessions(agent_id);

-- Small key/value table for orchestrator-private bytes. Today holds exactly
-- the ParentTokenMinter HMAC secret so subagent tokens survive restart.
-- Kept deliberately narrow — not a general config store.
CREATE TABLE IF NOT EXISTS kv_secrets (
  k TEXT PRIMARY KEY,
  v BLOB NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Durable event queue. When POST /v1/sessions/:id/events lands on a running
-- session, the payload is persisted here instead of held in a Map. The
-- router drains it between turns; the startup-drain pass in src/index.ts
-- resumes any work a crashed process left behind.
--
-- ROWID ordering gives us FIFO for free — SQLite's auto-INTEGER PRIMARY KEY
-- is monotonic within a database, so the lowest ROWID per session is the
-- head. No explicit per-session seq column needed.
CREATE TABLE IF NOT EXISTS queued_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  content TEXT NOT NULL,
  model TEXT,
  enqueued_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_queued_events_session ON queued_events(session_id, id);

-- Structured audit log. One row per mutating API call. See
-- src/audit.ts for the actor-extraction policy (token fingerprint, IP,
-- or "anonymous") and the list of actions written. Indexed by target
-- + ts so "what happened to agent X last month" is O(log n) not O(n).
CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  request_id TEXT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  outcome TEXT NOT NULL,
  metadata_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_target_ts ON audit_events(target, ts);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_events(ts);
CREATE INDEX IF NOT EXISTS idx_audit_action_ts ON audit_events(action, ts);
`;

// ---------- Agent store ----------

class SqliteAgentStore implements AgentStore {
  private readonly insertStmt: Database.Statement;
  private readonly insertVersionStmt: Database.Statement;
  private readonly getStmt: Database.Statement;
  private readonly listStmt: Database.Statement;
  private readonly deleteStmt: Database.Statement;
  private readonly deleteVersionsStmt: Database.Statement;
  private readonly updateStmt: Database.Statement;
  private readonly listVersionsStmt: Database.Statement;
  private readonly archiveStmt: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.insertStmt = db.prepare(
      `INSERT INTO agents (
        agent_id, model, tools_json, instructions, permission_policy_json,
        name, created_at, updated_at, archived_at, version,
        callable_agents_json, max_subagent_depth, mcp_servers_json, quota_json,
        thinking_level
       ) VALUES (
        @agent_id, @model, @tools_json, @instructions, @permission_policy_json,
        @name, @created_at, @updated_at, NULL, 1,
        @callable_agents_json, @max_subagent_depth, @mcp_servers_json, @quota_json,
        @thinking_level
       )`,
    );
    this.insertVersionStmt = db.prepare(
      `INSERT INTO agent_versions (
        agent_id, version, model, tools_json, instructions,
        permission_policy_json, name,
        callable_agents_json, max_subagent_depth, mcp_servers_json, quota_json,
        thinking_level, created_at
       ) VALUES (
        @agent_id, @version, @model, @tools_json, @instructions,
        @permission_policy_json, @name,
        @callable_agents_json, @max_subagent_depth, @mcp_servers_json, @quota_json,
        @thinking_level, @created_at
       )`,
    );
    this.getStmt = db.prepare(`SELECT * FROM agents WHERE agent_id = ?`);
    this.listStmt = db.prepare(`SELECT * FROM agents ORDER BY created_at ASC`);
    this.deleteStmt = db.prepare(`DELETE FROM agents WHERE agent_id = ?`);
    this.deleteVersionsStmt = db.prepare(`DELETE FROM agent_versions WHERE agent_id = ?`);
    this.updateStmt = db.prepare(
      `UPDATE agents SET
        model = @model, tools_json = @tools_json, instructions = @instructions,
        permission_policy_json = @permission_policy_json,
        name = @name, callable_agents_json = @callable_agents_json,
        max_subagent_depth = @max_subagent_depth,
        mcp_servers_json = @mcp_servers_json,
        quota_json = @quota_json,
        thinking_level = @thinking_level,
        version = @version, updated_at = @updated_at
       WHERE agent_id = @agent_id AND version = @prev_version`,
    );
    this.listVersionsStmt = db.prepare(
      `SELECT agent_id, version, model, tools_json, instructions,
              permission_policy_json, name,
              callable_agents_json, max_subagent_depth, mcp_servers_json,
              quota_json, thinking_level,
              created_at,
              created_at as updated_at, NULL as archived_at
       FROM agent_versions WHERE agent_id = ? ORDER BY version ASC`,
    );
    this.archiveStmt = db.prepare(
      `UPDATE agents SET archived_at = @now, updated_at = @now WHERE agent_id = @agent_id`,
    );
  }

  private agentToRow(agent: AgentConfig) {
    return {
      agent_id: agent.agentId,
      model: agent.model,
      tools_json: JSON.stringify(agent.tools),
      instructions: agent.instructions,
      permission_policy_json: agent.permissionPolicy.type !== "always_allow"
        ? JSON.stringify(agent.permissionPolicy)
        : null,
      name: agent.name ?? null,
      callable_agents_json: agent.callableAgents.length > 0
        ? JSON.stringify(agent.callableAgents)
        : null,
      max_subagent_depth: agent.maxSubagentDepth,
      mcp_servers_json:
        agent.mcpServers && Object.keys(agent.mcpServers).length > 0
          ? JSON.stringify(agent.mcpServers)
          : null,
      quota_json: agent.quota ? JSON.stringify(agent.quota) : null,
      thinking_level: agent.thinkingLevel === "off" ? null : agent.thinkingLevel,
    };
  }

  create(req: CreateAgentRequest): AgentConfig {
    const now = Date.now();
    const agent: AgentConfig = {
      agentId: `agt_${nanoid()}`,
      model: req.model,
      tools: req.tools,
      instructions: req.instructions,
      permissionPolicy: req.permissionPolicy,
      name: req.name,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      version: 1,
      callableAgents: req.callableAgents,
      maxSubagentDepth: req.maxSubagentDepth,
      mcpServers: req.mcpServers,
      quota: req.quota,
      thinkingLevel: req.thinkingLevel,
    };
    const row = this.agentToRow(agent);
    this.insertStmt.run({ ...row, created_at: now, updated_at: now });
    this.insertVersionStmt.run({ ...row, version: 1, created_at: now });
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
    this.deleteVersionsStmt.run(agentId);
    const info = this.deleteStmt.run(agentId);
    return info.changes > 0;
  }

  update(agentId: string, req: UpdateAgentRequest): AgentConfig | undefined {
    const current = this.get(agentId);
    if (!current || current.version !== req.version) return undefined;
    const now = Date.now();
    const updated: AgentConfig = {
      ...current,
      model: req.model ?? current.model,
      tools: req.tools === null ? [] : (req.tools ?? current.tools),
      instructions: req.instructions === null ? "" : (req.instructions ?? current.instructions),
      permissionPolicy: req.permissionPolicy ?? current.permissionPolicy,
      name: req.name === null ? undefined : (req.name ?? current.name),
      callableAgents: req.callableAgents === null ? [] : (req.callableAgents ?? current.callableAgents),
      maxSubagentDepth: req.maxSubagentDepth ?? current.maxSubagentDepth,
      mcpServers: req.mcpServers === null ? {} : (req.mcpServers ?? current.mcpServers),
      quota: req.quota === null ? undefined : (req.quota ?? current.quota),
      thinkingLevel: req.thinkingLevel ?? current.thinkingLevel,
      updatedAt: now,
      version: current.version + 1,
    };
    if (
      updated.model === current.model &&
      JSON.stringify(updated.tools) === JSON.stringify(current.tools) &&
      updated.instructions === current.instructions &&
      JSON.stringify(updated.permissionPolicy) === JSON.stringify(current.permissionPolicy) &&
      updated.name === current.name &&
      JSON.stringify(updated.callableAgents) === JSON.stringify(current.callableAgents) &&
      updated.maxSubagentDepth === current.maxSubagentDepth &&
      JSON.stringify(updated.mcpServers) === JSON.stringify(current.mcpServers) &&
      JSON.stringify(updated.quota) === JSON.stringify(current.quota) &&
      updated.thinkingLevel === current.thinkingLevel
    ) {
      return current;
    }
    const row = this.agentToRow(updated);
    const info = this.updateStmt.run({
      ...row,
      version: updated.version,
      updated_at: now,
      prev_version: req.version,
    });
    if (info.changes === 0) return undefined;
    this.insertVersionStmt.run({ ...row, version: updated.version, created_at: now });
    return updated;
  }

  listVersions(agentId: string): AgentConfig[] {
    const rows = this.listVersionsStmt.all(agentId) as AgentRow[];
    return rows.map(rowToAgent);
  }

  archive(agentId: string): AgentConfig | undefined {
    const now = Date.now();
    const info = this.archiveStmt.run({ agent_id: agentId, now });
    if (info.changes === 0) return undefined;
    return this.get(agentId);
  }
}

// ---------- Environment store ----------

class SqliteEnvironmentStore implements EnvironmentStore {
  private readonly insertStmt: Database.Statement;
  private readonly getStmt: Database.Statement;
  private readonly listStmt: Database.Statement;
  private readonly deleteStmt: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.insertStmt = db.prepare(
      `INSERT INTO environments (
        environment_id, name, packages_json, networking_json, created_at
       ) VALUES (
        @environment_id, @name, @packages_json, @networking_json, @created_at
       )`,
    );
    this.getStmt = db.prepare(`SELECT * FROM environments WHERE environment_id = ?`);
    this.listStmt = db.prepare(`SELECT * FROM environments ORDER BY created_at ASC`);
    this.deleteStmt = db.prepare(`DELETE FROM environments WHERE environment_id = ?`);
  }

  create(req: CreateEnvironmentRequest): EnvironmentConfig {
    const env: EnvironmentConfig = {
      environmentId: `env_${nanoid()}`,
      name: req.name,
      packages: req.packages ?? null,
      networking: req.networking,
      createdAt: Date.now(),
    };
    this.insertStmt.run({
      environment_id: env.environmentId,
      name: env.name,
      packages_json: env.packages ? JSON.stringify(env.packages) : null,
      networking_json: JSON.stringify(env.networking),
      created_at: env.createdAt,
    });
    return env;
  }

  get(environmentId: string): EnvironmentConfig | undefined {
    const row = this.getStmt.get(environmentId) as EnvironmentRow | undefined;
    return row ? rowToEnvironment(row) : undefined;
  }

  list(): EnvironmentConfig[] {
    const rows = this.listStmt.all() as EnvironmentRow[];
    return rows.map(rowToEnvironment);
  }

  delete(environmentId: string): boolean {
    const info = this.deleteStmt.run(environmentId);
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
        session_id, agent_id, environment_id, status, ephemeral,
        remaining_subagent_depth,
        tokens_in, tokens_out, cost_usd,
        error, created_at, last_event_at
       ) VALUES (
        @session_id, @agent_id, @environment_id, 'idle', @ephemeral,
        @remaining_subagent_depth,
        0, 0, 0, NULL, @created_at, NULL
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

  create(args: {
    agentId: string;
    sessionId?: string;
    environmentId?: string;
    ephemeral?: boolean;
    remainingSubagentDepth?: number;
  }): Session {
    const sessionId = args.sessionId ?? `ses_${nanoid()}`;
    const environmentId = args.environmentId ?? null;
    const ephemeral = args.ephemeral ?? false;
    const remainingSubagentDepth = args.remainingSubagentDepth ?? 0;
    const createdAt = Date.now();
    this.insertStmt.run({
      session_id: sessionId,
      agent_id: args.agentId,
      environment_id: environmentId,
      ephemeral: ephemeral ? 1 : 0,
      remaining_subagent_depth: remainingSubagentDepth,
      created_at: createdAt,
    });
    return {
      sessionId,
      agentId: args.agentId,
      environmentId,
      status: "idle",
      ephemeral,
      remainingSubagentDepth,
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

// ---------- Secret store ----------

class SqliteSecretStore implements SecretStore {
  private readonly getStmt: Database.Statement;
  private readonly upsertStmt: Database.Statement;

  constructor(db: Database.Database) {
    this.getStmt = db.prepare(`SELECT v FROM kv_secrets WHERE k = ?`);
    // INSERT OR REPLACE so set() is idempotent — callers don't need to
    // distinguish "first boot, generate" from "rotate, overwrite".
    this.upsertStmt = db.prepare(
      `INSERT INTO kv_secrets (k, v, updated_at) VALUES (@k, @v, @now)
       ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at`,
    );
  }

  get(key: string): Buffer | undefined {
    const row = this.getStmt.get(key) as { v: Buffer } | undefined;
    return row?.v;
  }

  set(key: string, value: Buffer): void {
    this.upsertStmt.run({ k: key, v: value, now: Date.now() });
  }
}

// ---------- Queue store ----------

class SqliteQueueStore implements QueueStore {
  private readonly insertStmt: Database.Statement;
  private readonly peekStmt: Database.Statement;
  private readonly deleteByIdStmt: Database.Statement;
  private readonly countStmt: Database.Statement;
  private readonly clearStmt: Database.Statement;
  private readonly listSessionsStmt: Database.Statement;

  constructor(db: Database.Database) {
    this.insertStmt = db.prepare(
      `INSERT INTO queued_events (session_id, content, model, enqueued_at)
       VALUES (@session_id, @content, @model, @enqueued_at)`,
    );
    // Head-of-queue is the lowest id for a session. Peek-then-delete is a
    // two-statement shift; both run inside the same sync better-sqlite3
    // call stack, so concurrent shifts from a single orchestrator process
    // are naturally serialized. Cross-process contention is out of scope
    // (the orchestrator is still single-process by design).
    this.peekStmt = db.prepare(
      `SELECT id, content, model, enqueued_at
       FROM queued_events WHERE session_id = ?
       ORDER BY id ASC LIMIT 1`,
    );
    this.deleteByIdStmt = db.prepare(`DELETE FROM queued_events WHERE id = ?`);
    this.countStmt = db.prepare(
      `SELECT COUNT(*) as n FROM queued_events WHERE session_id = ?`,
    );
    this.clearStmt = db.prepare(`DELETE FROM queued_events WHERE session_id = ?`);
    this.listSessionsStmt = db.prepare(
      `SELECT DISTINCT session_id FROM queued_events ORDER BY session_id ASC`,
    );
  }

  enqueue(sessionId: string, event: QueuedEvent): void {
    this.insertStmt.run({
      session_id: sessionId,
      content: event.content,
      model: event.model ?? null,
      enqueued_at: event.enqueuedAt,
    });
  }

  shift(sessionId: string): QueuedEvent | undefined {
    const row = this.peekStmt.get(sessionId) as
      | { id: number; content: string; model: string | null; enqueued_at: number }
      | undefined;
    if (!row) return undefined;
    this.deleteByIdStmt.run(row.id);
    return {
      content: row.content,
      model: row.model ?? undefined,
      enqueuedAt: row.enqueued_at,
    };
  }

  size(sessionId: string): number {
    const row = this.countStmt.get(sessionId) as { n: number };
    return row.n;
  }

  clear(sessionId: string): number {
    const info = this.clearStmt.run(sessionId);
    return info.changes;
  }

  listSessionsWithQueued(): string[] {
    const rows = this.listSessionsStmt.all() as Array<{ session_id: string }>;
    return rows.map((r) => r.session_id);
  }
}

// ---------- Audit store ----------

class SqliteAuditStore implements AuditStore {
  private readonly insertStmt: Database.Statement;
  private readonly baseSelect: string;
  private readonly deleteOlderThanStmt: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.insertStmt = db.prepare(
      `INSERT INTO audit_events (
        ts, request_id, actor, action, target, outcome, metadata_json
       ) VALUES (
        @ts, @request_id, @actor, @action, @target, @outcome, @metadata_json
       )`,
    );
    this.baseSelect = `SELECT id, ts, request_id, actor, action, target, outcome, metadata_json FROM audit_events`;
    this.deleteOlderThanStmt = db.prepare(
      `DELETE FROM audit_events WHERE ts < @before`,
    );
  }

  record(event: Omit<AuditRecord, "id">): void {
    this.insertStmt.run({
      ts: event.ts,
      request_id: event.requestId,
      actor: event.actor,
      action: event.action,
      target: event.target,
      outcome: event.outcome,
      metadata_json: event.metadata ? JSON.stringify(event.metadata) : null,
    });
  }

  list(filters: {
    since?: number;
    until?: number;
    action?: string;
    target?: string;
    limit?: number;
  }): AuditRecord[] {
    // Dynamic WHERE construction — keep each predicate a single named
    // parameter so the SQL stays parameterised (no injection risk even
    // though `action` filters are operator-supplied).
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};
    if (filters.since !== undefined) {
      conditions.push("ts >= @since");
      params.since = filters.since;
    }
    if (filters.until !== undefined) {
      conditions.push("ts <= @until");
      params.until = filters.until;
    }
    if (filters.action !== undefined) {
      // Support prefix match on action ("agent.*" etc.) via LIKE. If
      // the caller didn't include a wildcard we treat it as exact match.
      if (filters.action.includes("%")) {
        conditions.push("action LIKE @action");
        params.action = filters.action;
      } else {
        conditions.push("action = @action");
        params.action = filters.action;
      }
    }
    if (filters.target !== undefined) {
      conditions.push("target = @target");
      params.target = filters.target;
    }
    const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
    const limit = Math.min(Math.max(filters.limit ?? 100, 1), 1000);
    const sql = `${this.baseSelect}${where} ORDER BY ts DESC, id DESC LIMIT ${limit}`;
    const rows = this.db.prepare(sql).all(params) as Array<{
      id: number;
      ts: number;
      request_id: string | null;
      actor: string;
      action: string;
      target: string | null;
      outcome: string;
      metadata_json: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      requestId: r.request_id,
      actor: r.actor,
      action: r.action,
      target: r.target,
      outcome: r.outcome,
      metadata: r.metadata_json
        ? (JSON.parse(r.metadata_json) as Record<string, unknown>)
        : null,
    }));
  }

  deleteOlderThan(ts: number): number {
    const info = this.deleteOlderThanStmt.run({ before: ts });
    return info.changes;
  }
}

// ---------- Bundle ----------

export class SqliteStore implements Store {
  readonly agents: AgentStore;
  readonly environments: EnvironmentStore;
  readonly sessions: SessionStore;
  readonly secrets: SecretStore;
  readonly queue: QueueStore;
  readonly audit: AuditStore;
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

    // Additive migrations. CREATE TABLE IF NOT EXISTS above is a no-op for
    // existing databases, so columns added after the initial schema need
    // an explicit ALTER. Check existence via PRAGMA table_info before
    // running each migration so startup is idempotent.
    const sessionsCols = this.db.pragma("table_info(sessions)") as Array<{
      name: string;
    }>;
    if (!sessionsCols.some((c) => c.name === "environment_id")) {
      this.db.exec(
        "ALTER TABLE sessions ADD COLUMN environment_id TEXT",
      );
    }
    if (!sessionsCols.some((c) => c.name === "ephemeral")) {
      // Item 8: ephemeral sessions are auto-created by /v1/chat/completions
      // for keyless calls and reaped with their container. Rows that pre-date
      // Item 8 default to non-ephemeral (safe — they were never flagged for
      // cleanup and all explicit /v1/sessions creates are non-ephemeral).
      this.db.exec(
        "ALTER TABLE sessions ADD COLUMN ephemeral INTEGER NOT NULL DEFAULT 0",
      );
    }
    if (!sessionsCols.some((c) => c.name === "remaining_subagent_depth")) {
      // Item 12-14: per-session remaining subagent depth. Rows that predate
      // Item 12-14 default to 0 (no delegation allowed from existing
      // sessions, which is a safe no-op for the call_agent feature).
      this.db.exec(
        "ALTER TABLE sessions ADD COLUMN remaining_subagent_depth INTEGER NOT NULL DEFAULT 0",
      );
    }
    const agentsCols = this.db.pragma("table_info(agents)") as Array<{
      name: string;
    }>;
    if (!agentsCols.some((c) => c.name === "callable_agents_json")) {
      // Item 12-14: allowlist of agent IDs this template may invoke via
      // call_agent. NULL means no delegation (same as an empty array).
      this.db.exec("ALTER TABLE agents ADD COLUMN callable_agents_json TEXT");
    }
    if (!agentsCols.some((c) => c.name === "max_subagent_depth")) {
      this.db.exec(
        "ALTER TABLE agents ADD COLUMN max_subagent_depth INTEGER NOT NULL DEFAULT 0",
      );
    }
    if (!agentsCols.some((c) => c.name === "version")) {
      this.db.exec("ALTER TABLE agents ADD COLUMN version INTEGER NOT NULL DEFAULT 1");
    }
    if (!agentsCols.some((c) => c.name === "updated_at")) {
      this.db.exec("ALTER TABLE agents ADD COLUMN updated_at INTEGER");
    }
    if (!agentsCols.some((c) => c.name === "archived_at")) {
      this.db.exec("ALTER TABLE agents ADD COLUMN archived_at INTEGER");
    }
    if (!agentsCols.some((c) => c.name === "permission_policy_json")) {
      this.db.exec("ALTER TABLE agents ADD COLUMN permission_policy_json TEXT");
    }
    if (!agentsCols.some((c) => c.name === "mcp_servers_json")) {
      // A2: agent template declares MCP servers; forwarded to the
      // container as OPENCLAW_MCP_SERVERS_JSON. Pre-A2 rows default to
      // NULL (no MCP servers), which is the safe no-op — existing
      // sessions behave identically.
      this.db.exec("ALTER TABLE agents ADD COLUMN mcp_servers_json TEXT");
    }
    if (!agentsCols.some((c) => c.name === "quota_json")) {
      // B5: per-session quota caps (cost, tokens, wall duration).
      // Pre-B5 rows default to NULL = no caps, matching pre-B5 behavior.
      this.db.exec("ALTER TABLE agents ADD COLUMN quota_json TEXT");
    }
    if (!agentsCols.some((c) => c.name === "thinking_level")) {
      // D1: Pi extended-thinking level ("off" | "low" | "medium" | "high"
      // | "xhigh"). Pre-D1 rows default to NULL which rowToAgent maps to
      // "off", matching pre-D1 behavior (no thinking blocks emitted).
      this.db.exec("ALTER TABLE agents ADD COLUMN thinking_level TEXT");
    }
    const versionsCols = this.db.pragma("table_info(agent_versions)") as Array<{ name: string }>;
    if (versionsCols.length > 0 && !versionsCols.some((c) => c.name === "permission_policy_json")) {
      this.db.exec("ALTER TABLE agent_versions ADD COLUMN permission_policy_json TEXT");
    }
    if (versionsCols.length > 0 && !versionsCols.some((c) => c.name === "mcp_servers_json")) {
      this.db.exec("ALTER TABLE agent_versions ADD COLUMN mcp_servers_json TEXT");
    }
    if (versionsCols.length > 0 && !versionsCols.some((c) => c.name === "quota_json")) {
      this.db.exec("ALTER TABLE agent_versions ADD COLUMN quota_json TEXT");
    }
    if (versionsCols.length > 0 && !versionsCols.some((c) => c.name === "thinking_level")) {
      this.db.exec("ALTER TABLE agent_versions ADD COLUMN thinking_level TEXT");
    }

    this.agents = new SqliteAgentStore(this.db);
    this.environments = new SqliteEnvironmentStore(this.db);
    this.sessions = new SqliteSessionStore(this.db);
    this.secrets = new SqliteSecretStore(this.db);
    this.queue = new SqliteQueueStore(this.db);
    this.audit = new SqliteAuditStore(this.db);
  }

  close(): void {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }
}
