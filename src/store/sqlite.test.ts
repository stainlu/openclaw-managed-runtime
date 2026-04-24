import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SqliteStore } from "./sqlite.js";

// These tests target the ALTER TABLE migration dispatch that runs in
// SqliteStore's constructor. A pre-migration DB is constructed by
// writing the *old* schema (the shape that predated a given migration),
// inserting data, closing the handle, and then opening it again through
// SqliteStore — which should add the missing columns in place without
// corrupting existing rows.
//
// Why this matters: long-lived deploys carry DB files across orchestrator
// releases. If a migration is wrong, every next restart silently breaks
// production. Unit-tested here because the cost of regressing is
// catastrophic (data loss or startup crash) and the cost of testing is
// tiny (a temp SQLite file per case).

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "sqlite-migrations-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function newDbPath(name = "test.db"): string {
  return join(tmpDir, name);
}

/** Column name set for a given table in a raw DB handle. */
function columns(db: Database.Database, table: string): Set<string> {
  const rows = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

describe("SqliteStore — fresh-DB schema", () => {
  it("creates every table and every current column on a brand new file", () => {
    const path = newDbPath();
    const store = new SqliteStore(path);
    const agent = store.agents.create({
      model: "m",
      tools: [],
      instructions: "",
      permissionPolicy: { type: "always_allow" },
      callableAgents: [],
      maxSubagentDepth: 0,
    });
    const session = store.sessions.create({ agentId: agent.agentId });
    store.sessions.beginRun(session.sessionId);
    expect(store.sessions.get(session.sessionId)?.status).toBe("starting");
    // Read via a second handle so we can snapshot the schema without
    // going through the ORM-shaped methods.
    const probe = new Database(path, { readonly: true });
    const agents = columns(probe, "agents");
    const sessions = columns(probe, "sessions");
    const envs = columns(probe, "environments");
    const versions = columns(probe, "agent_versions");
    probe.close();
    store.close();

    // Agents — every column documented on AgentConfig is present.
    for (const col of [
      "agent_id",
      "model",
      "tools_json",
      "instructions",
      "permission_policy_json",
      "name",
      "created_at",
      "updated_at",
      "archived_at",
      "version",
      "callable_agents_json",
      "max_subagent_depth",
      "mcp_servers_json",
      "quota_json",
    ]) {
      expect(agents, `agents missing ${col}`).toContain(col);
    }

    // Sessions — all three additive columns present on fresh create.
    for (const col of [
      "session_id",
      "agent_id",
      "status",
      "ephemeral",
      "remaining_subagent_depth",
      "environment_id",
      "tokens_in",
      "tokens_out",
      "cost_usd",
      "error",
      "created_at",
      "last_event_at",
    ]) {
      expect(sessions, `sessions missing ${col}`).toContain(col);
    }

    expect(envs).toContain("environment_id");
    expect(envs).toContain("networking_json");

    expect(versions).toContain("permission_policy_json");
  });
});

describe("SqliteStore — additive migrations on pre-existing DBs", () => {
  it("adds sessions columns (environment_id, ephemeral, remaining_subagent_depth) when opening a legacy DB", () => {
    const path = newDbPath();
    // Pre-migration shape of the sessions table — no environment_id,
    // no ephemeral, no remaining_subagent_depth.
    const seed = new Database(path);
    seed.exec(`
      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('idle','running','failed')),
        tokens_in INTEGER NOT NULL DEFAULT 0,
        tokens_out INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        error TEXT,
        created_at INTEGER NOT NULL,
        last_event_at INTEGER
      );
    `);
    seed.prepare(
      `INSERT INTO sessions (session_id, agent_id, status, created_at)
       VALUES (?, ?, 'idle', ?)`,
    ).run("ses_old", "agt_old", 1000);
    seed.close();

    // Open through SqliteStore — migrations fire during the constructor.
    const store = new SqliteStore(path);
    store.close();

    const probe = new Database(path, { readonly: true });
    const cols = columns(probe, "sessions");
    expect(cols).toContain("environment_id");
    expect(cols).toContain("ephemeral");
    expect(cols).toContain("remaining_subagent_depth");

    // Pre-existing row survived the migration and got the NOT-NULL
    // defaults for the new integer columns.
    const row = probe.prepare(
      `SELECT session_id, ephemeral, remaining_subagent_depth, environment_id
       FROM sessions WHERE session_id = 'ses_old'`,
    ).get() as {
      session_id: string;
      ephemeral: number;
      remaining_subagent_depth: number;
      environment_id: string | null;
    };
    probe.close();
    expect(row.session_id).toBe("ses_old");
    expect(row.ephemeral).toBe(0); // safe default (not ephemeral)
    expect(row.remaining_subagent_depth).toBe(0); // safe default (no subagents)
    expect(row.environment_id).toBeNull(); // nullable column
  });

  it("upgrades the sessions status constraint in place and preserves session_container foreign keys", () => {
    const path = newDbPath();
    const seed = new Database(path);
    seed.pragma("foreign_keys = ON");
    seed.exec(`
      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        environment_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('idle','running','failed')),
        ephemeral INTEGER NOT NULL DEFAULT 0,
        remaining_subagent_depth INTEGER NOT NULL DEFAULT 0,
        turns INTEGER NOT NULL DEFAULT 0,
        tokens_in INTEGER NOT NULL DEFAULT 0,
        tokens_out INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        error TEXT,
        created_at INTEGER NOT NULL,
        last_event_at INTEGER,
        vault_id TEXT,
        parent_session_id TEXT,
        user_id TEXT
      );
      CREATE TABLE session_containers (
        session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL,
        container_id TEXT NOT NULL,
        container_name TEXT NOT NULL,
        container_port INTEGER NOT NULL,
        gateway_token TEXT NOT NULL,
        claimed_at INTEGER NOT NULL,
        boot_ms INTEGER,
        pool_source TEXT
      );
      CREATE INDEX idx_session_containers_container ON session_containers(container_id);
    `);
    seed.prepare(
      `INSERT INTO sessions (
        session_id, agent_id, environment_id, status, ephemeral,
        remaining_subagent_depth, turns, tokens_in, tokens_out, cost_usd,
        error, created_at, last_event_at, vault_id, parent_session_id, user_id
      ) VALUES (
        ?, ?, NULL, 'idle', 0,
        0, 0, 0, 0, 0,
        NULL, ?, NULL, NULL, NULL, NULL
      )`,
    ).run("ses_old", "agt_old", 1000);
    seed.prepare(
      `INSERT INTO session_containers (
        session_id, agent_id, container_id, container_name, container_port,
        gateway_token, claimed_at, boot_ms, pool_source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "ses_old",
      "agt_old",
      "cid_old",
      "openclaw-agt-old",
      18789,
      "tok_old",
      1001,
      250,
      "warm",
    );
    seed.close();

    const store = new SqliteStore(path);
    store.sessions.beginRun("ses_old");
    expect(store.sessions.get("ses_old")?.status).toBe("starting");
    expect(store.sessions.delete("ses_old")).toBe(true);
    store.close();

    const probe = new Database(path, { readonly: true });
    const fk = probe.pragma("foreign_key_list(session_containers)") as Array<{
      table: string;
    }>;
    const remainingContainers = probe
      .prepare(`SELECT COUNT(*) as count FROM session_containers`)
      .get() as { count: number };
    const sessionsSql = probe
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sessions'`)
      .get() as { sql: string };
    probe.close();

    expect(fk[0]?.table).toBe("sessions");
    expect(remainingContainers.count).toBe(0);
    expect(sessionsSql.sql).toContain("'starting'");
  });

  it("adds every agents migration column when opening a v1-era DB", () => {
    // Pre-migration agents table: only the fields that existed before
    // Items 12-14, 17, 19 landed. Minimum viable shape.
    const path = newDbPath();
    const seed = new Database(path);
    seed.exec(`
      CREATE TABLE agents (
        agent_id TEXT PRIMARY KEY,
        model TEXT NOT NULL,
        tools_json TEXT NOT NULL,
        instructions TEXT NOT NULL,
        name TEXT,
        created_at INTEGER NOT NULL
      );
    `);
    seed.prepare(
      `INSERT INTO agents (agent_id, model, tools_json, instructions, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("agt_old", "moonshot/kimi-k2.5", "[]", "", 1000);
    seed.close();

    const store = new SqliteStore(path);
    store.close();

    const probe = new Database(path, { readonly: true });
    const cols = columns(probe, "agents");
    // Every column the latest code expects to be able to read from.
    for (const col of [
      "callable_agents_json",
      "max_subagent_depth",
      "version",
      "updated_at",
      "archived_at",
      "permission_policy_json",
    ]) {
      expect(cols, `missing ${col} after migration`).toContain(col);
    }

    const row = probe.prepare(
      `SELECT agent_id, max_subagent_depth, version, callable_agents_json,
              permission_policy_json, updated_at, archived_at
       FROM agents WHERE agent_id = 'agt_old'`,
    ).get() as {
      agent_id: string;
      max_subagent_depth: number;
      version: number;
      callable_agents_json: string | null;
      permission_policy_json: string | null;
      updated_at: number | null;
      archived_at: number | null;
    };
    probe.close();
    expect(row.agent_id).toBe("agt_old");
    expect(row.max_subagent_depth).toBe(0); // safe default (no delegation)
    expect(row.version).toBe(1); // safe default (legacy rows start at v1)
    expect(row.callable_agents_json).toBeNull();
    expect(row.permission_policy_json).toBeNull();
    expect(row.updated_at).toBeNull();
    expect(row.archived_at).toBeNull();
  });

  it("adds permission_policy_json to agent_versions when opening a pre-Item-19 DB", () => {
    const path = newDbPath();
    const seed = new Database(path);
    // agent_versions as it existed before Item 19 (no permission_policy_json column).
    seed.exec(`
      CREATE TABLE agent_versions (
        agent_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        model TEXT NOT NULL,
        tools_json TEXT NOT NULL,
        instructions TEXT NOT NULL,
        name TEXT,
        callable_agents_json TEXT,
        max_subagent_depth INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (agent_id, version)
      );
    `);
    seed.prepare(
      `INSERT INTO agent_versions
        (agent_id, version, model, tools_json, instructions, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("agt_old", 1, "m", "[]", "", 1000);
    seed.close();

    const store = new SqliteStore(path);
    store.close();

    const probe = new Database(path, { readonly: true });
    expect(columns(probe, "agent_versions")).toContain("permission_policy_json");
    probe.close();
  });

  it("is idempotent — opening an already-migrated DB is a no-op", () => {
    const path = newDbPath();
    // First open: creates tables and runs all migrations as no-ops.
    new SqliteStore(path).close();
    // Second open: every migration guard sees the column already present
    // and short-circuits. Must NOT throw. This is the production-critical
    // invariant — every restart of every deploy re-runs this code path.
    expect(() => {
      const store = new SqliteStore(path);
      store.close();
    }).not.toThrow();
  });

  it("preserves data written through one migration cycle across a restart", () => {
    // End-to-end: create a session through the live store, close it,
    // reopen it, and verify the session round-trips. Proves the
    // prepared-statement SELECT shape matches the latest schema on a
    // DB that was originally created by the same latest schema — no
    // silent column-type mismatches.
    const path = newDbPath();
    let store = new SqliteStore(path);
    const agent = store.agents.create({
      model: "m",
      tools: [],
      instructions: "",
      permissionPolicy: { type: "always_allow" },
      callableAgents: [],
      maxSubagentDepth: 0,
    });
    const session = store.sessions.create({ agentId: agent.agentId });
    store.close();

    store = new SqliteStore(path);
    const loaded = store.sessions.get(session.sessionId);
    expect(loaded?.sessionId).toBe(session.sessionId);
    expect(loaded?.status).toBe("idle");
    const loadedAgent = store.agents.get(agent.agentId);
    expect(loadedAgent?.version).toBe(1);
    expect(loadedAgent?.callableAgents).toEqual([]);
    store.close();
  });
});
