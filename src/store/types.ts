import type {
  AgentConfig,
  CreateAgentRequest,
  CreateEnvironmentRequest,
  EnvironmentConfig,
  Session,
  UpdateAgentRequest,
} from "../orchestrator/types.js";

// All store methods are synchronous. The two concrete backends (in-memory and
// better-sqlite3) are both sync. If a future backend needs async I/O — a
// remote Postgres, a hosted KV — the interface will migrate to async at that
// point. Don't introduce speculative async today.
//
// Events are NOT part of the store. They live in OpenClaw's per-session
// JSONL on the host mount, written by OpenClaw's SessionManager. The
// orchestrator reads them via PiJsonlEventReader (src/store/pi-jsonl.ts) at
// query time; there is no orchestrator-side event log to keep in sync.

/**
 * Structured audit log. One row per mutating API call. Written
 * synchronously from the server handler (via src/audit.ts) so an entry
 * exists on durable storage before the response is returned.
 *
 * Scope: actor (token fingerprint / IP), action verb, target resource
 * id, outcome (ok / error code), optional metadata JSON. Retention is
 * operator-controlled via OPENCLAW_AUDIT_RETENTION_DAYS; a periodic
 * pass deletes rows older than the window.
 *
 * Query surface: GET /v1/audit?since=<ts>&action=<prefix>&target=<id>.
 * Intended for operators auditing "who changed agent X last month" or
 * "which sessions did this API token create".
 */
export type AuditRecord = {
  id: number;
  ts: number;
  /** Correlation id from the HTTP request (x-request-id). */
  requestId: string | null;
  /** Token fingerprint (first 8 hex chars of sha256) or "ip:<addr>" or "anonymous". */
  actor: string;
  /** Verb like "agent.create", "session.cancel", "session.post_event". */
  action: string;
  /** Primary resource id this action targeted (agent id, session id, etc.). */
  target: string | null;
  /** "ok" for 2xx, or the RouterError / HTTP status code for failures. */
  outcome: string;
  /** Optional JSON payload with action-specific context. */
  metadata: Record<string, unknown> | null;
};

export interface AuditStore {
  record(event: Omit<AuditRecord, "id">): void;
  list(filters: {
    since?: number;
    until?: number;
    action?: string;
    target?: string;
    limit?: number;
  }): AuditRecord[];
  /** Delete rows older than the given timestamp. Returns the number removed. */
  deleteOlderThan(ts: number): number;
}

/**
 * Small orchestrator-private key/value store. Today this has exactly one
 * caller: the HMAC secret for `ParentTokenMinter` must survive restart so
 * subagent delegation chains can run across deploys without 403-ing.
 * Kept narrow on purpose — if a second use case appears, re-evaluate
 * whether it belongs here or in its own table.
 */
export interface SecretStore {
  /** Return the bytes stored under `key`, or undefined if unset. */
  get(key: string): Buffer | undefined;
  /** Overwrite (or insert) the bytes stored under `key`. */
  set(key: string, value: Buffer): void;
}

/**
 * End-user credential bundle. Scoped to a single user in the developer's
 * app (identified by `userId` — arbitrary opaque string the developer
 * owns). Contains zero or more credentials that get injected into MCP
 * server requests at session spawn time when the vault is bound.
 *
 * Single-tenant-by-deployment: a vault lives in this orchestrator's
 * SQLite. No cross-orchestrator vault lookup. Cloud-provider OEMs
 * implementing their own multi-tenant SKU layer their identity stack on
 * top (one orchestrator per customer).
 */
export type Vault = {
  vaultId: string;
  userId: string;
  name: string;
  createdAt: number;
  updatedAt: number;
};

/**
 * One credential inside a vault. Discriminated by `type`:
 *
 *   - `static_bearer` — plain token, injected as
 *     `Authorization: Bearer <token>`. Never rotates; rotate by
 *     delete + re-add.
 *
 *   - `mcp_oauth` — OAuth 2.0 credential with auto-refresh. Stores
 *     access + refresh tokens, expiry, and the refresh endpoint /
 *     client_id / client_secret needed to refresh. At session spawn,
 *     the orchestrator refreshes if expiry is within 60s and updates
 *     the stored credential with the new tokens before injecting
 *     `Authorization: Bearer <accessToken>`.
 *
 * Shape matches Claude MA's vault so migration is a rename. Secret
 * fields (`token`, `accessToken`, `refreshToken`, `clientSecret`) are
 * NEVER returned by the API — responses strip them to
 * `VaultCredentialPublic`.
 */
export type VaultCredential = VaultCredentialStaticBearer | VaultCredentialMcpOAuth;

export type VaultCredentialStaticBearer = {
  credentialId: string;
  vaultId: string;
  name: string;
  type: "static_bearer";
  matchUrl: string;
  /** Secret. */
  token: string;
  createdAt: number;
  updatedAt: number;
};

export type VaultCredentialMcpOAuth = {
  credentialId: string;
  vaultId: string;
  name: string;
  type: "mcp_oauth";
  matchUrl: string;
  /** Current access token. Rotated in place on refresh. Secret. */
  accessToken: string;
  /** Refresh token. Rotated in place if the provider issues a new one
   *  on refresh (e.g., GitHub rotates refresh tokens). Secret. */
  refreshToken: string;
  /** Unix ms when `accessToken` expires. Orchestrator refreshes when
   *  `expiresAt - 60_000 < Date.now()`. */
  expiresAt: number;
  /** OAuth 2.0 token endpoint (e.g.,
   *  `https://github.com/login/oauth/access_token`). */
  tokenEndpoint: string;
  /** OAuth app client id. Public metadata — returned in API responses. */
  clientId: string;
  /** OAuth app client secret. Secret — never returned. */
  clientSecret: string;
  /** Optional scopes granted at the initial OAuth dance. Kept for
   *  audit/display; not sent on refresh. */
  scopes?: string[];
  createdAt: number;
  updatedAt: number;
};

/**
 * Shape returned by the HTTP API for a credential — all secret fields
 * stripped. Consumers never see `token`, `accessToken`, `refreshToken`,
 * or `clientSecret`. The only path that reads plaintext secrets is the
 * spawn-time injection internal to the router.
 */
export type VaultCredentialPublic =
  | (Omit<VaultCredentialStaticBearer, "token">)
  | (Omit<VaultCredentialMcpOAuth, "accessToken" | "refreshToken" | "clientSecret">);

/** Legacy alias kept for callers that used the old name. */
export type VaultCredentialSansSecret = VaultCredentialPublic;

/** Discriminated union of credential-creation inputs, passed to
 *  VaultStore.addCredential. Shape matches the HTTP request body. */
export type AddCredentialInput =
  | {
      vaultId: string;
      name: string;
      type: "static_bearer";
      matchUrl: string;
      token: string;
    }
  | {
      vaultId: string;
      name: string;
      type: "mcp_oauth";
      matchUrl: string;
      accessToken: string;
      refreshToken: string;
      expiresAt: number;
      tokenEndpoint: string;
      clientId: string;
      clientSecret: string;
      scopes?: string[];
    };

export interface VaultStore {
  createVault(args: { userId: string; name: string }): Vault;
  getVault(vaultId: string): Vault | undefined;
  listVaults(filter?: { userId?: string }): Vault[];
  deleteVault(vaultId: string): boolean;

  addCredential(args: AddCredentialInput): VaultCredential | undefined;
  getCredential(credentialId: string): VaultCredential | undefined;
  listCredentials(vaultId: string): VaultCredential[];
  deleteCredential(credentialId: string): boolean;

  /** Update an mcp_oauth credential's tokens in place after a refresh
   *  round-trip. Updates `accessToken`, optionally `refreshToken`,
   *  `expiresAt`, and `updatedAt`. Returns the updated credential or
   *  undefined if the credentialId doesn't exist or isn't mcp_oauth. */
  updateOAuthTokens(
    credentialId: string,
    args: { accessToken: string; refreshToken?: string; expiresAt: number },
  ): VaultCredentialMcpOAuth | undefined;
}

export interface AgentStore {
  create(req: CreateAgentRequest): AgentConfig;
  get(agentId: string): AgentConfig | undefined;
  list(): AgentConfig[];
  delete(agentId: string): boolean;
  update(agentId: string, req: UpdateAgentRequest): AgentConfig | undefined;
  listVersions(agentId: string): AgentConfig[];
  archive(agentId: string): AgentConfig | undefined;
}

export interface EnvironmentStore {
  create(req: CreateEnvironmentRequest): EnvironmentConfig;
  get(environmentId: string): EnvironmentConfig | undefined;
  list(): EnvironmentConfig[];
  delete(environmentId: string): boolean;
}

export type RunUsage = {
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
};

export interface SessionStore {
  /**
   * Create a session bound to an agent.
   *
   * - `sessionId` (optional): client-supplied session id. Used by the
   *   OpenAI-compat adapter (POST /v1/chat/completions) when the client
   *   passes an `x-openclaw-session-key` header or `user` body field and
   *   no existing session matches it. When omitted, the store generates
   *   a fresh `ses_` id.
   * - `ephemeral` (optional, default false): mark the session for
   *   reap-time cleanup. The pool's idle sweeper deletes ephemeral
   *   sessions (SQLite row + Pi JSONL) when their container is reaped,
   *   so one-shot OpenAI-style calls don't accumulate forever. Named
   *   sessions (POST /v1/sessions, or chat.completions with a session
   *   key) should never be ephemeral — the client took ownership of
   *   the key and is responsible for lifecycle.
   * - `remainingSubagentDepth` (optional, default 0): how many more
   *   levels of subagent spawning this session is allowed. For a
   *   top-level session (no parent token), initialized from the
   *   agent template's `maxSubagentDepth`. For a child session
   *   (created with X-OpenClaw-Parent-Token), initialized from
   *   `parent.remaining_depth - 1`. Persisted so container
   *   respawn mints tokens with the correct scope.
   */
  create(args: {
    agentId: string;
    sessionId?: string;
    environmentId?: string;
    ephemeral?: boolean;
    remainingSubagentDepth?: number;
    vaultId?: string;
  }): Session;
  get(sessionId: string): Session | undefined;
  list(): Session[];
  delete(sessionId: string): boolean;
  beginRun(sessionId: string): Session | undefined;
  endRunSuccess(sessionId: string, usage: RunUsage): Session | undefined;
  endRunFailure(sessionId: string, error: string): Session | undefined;
  /**
   * Reset a running session back to "idle" without recording an error.
   * Intended for cancellation: the operator stopped the run, but it's not
   * a failure of the agent — clients should see a clean idle ready for
   * the next event.
   */
  endRunCancelled(sessionId: string): Session | undefined;
  /**
   * Add usage metrics to the rollups WITHOUT changing status or error.
   * Used by the queue-drain path: when one run completes and a queued run
   * is about to start, we don't want to flip status to idle (which would
   * create a brief window where polling clients could see "done" between
   * two queued runs). addUsage rolls the metrics up and leaves status
   * untouched so the caller can call beginRun for the next iteration.
   */
  addUsage(sessionId: string, usage: RunUsage): Session | undefined;
  /**
   * Transition every session currently in "running" state to "failed" with
   * the given error. Intended for post-restart rehydration: any run that was
   * mid-flight when the orchestrator died is by definition orphaned (its
   * container was either torn down on restart or is no longer tracked by
   * this process). Returns the number of sessions that were transitioned.
   */
  failRunningSessions(reason: string): number;
}

/**
 * The bundled store. buildStore() returns one of these; the router and server
 * receive the two leaves individually so they stay agnostic of which backend
 * is in use.
 */
export interface Store {
  readonly agents: AgentStore;
  readonly environments: EnvironmentStore;
  readonly sessions: SessionStore;
  readonly secrets: SecretStore;
  readonly vaults: VaultStore;
  /** Queue backend — durable on SQLite, in-memory on memory. */
  readonly queue: QueueStore;
  readonly audit: AuditStore;
  /** Persistent session ↔ container mapping for restart-safe reattach. */
  readonly sessionContainers: SessionContainerStore;
  /** Closes any backing file handles or connections. Safe to call more than once. */
  close(): void;
}

/**
 * Persistent record of which Docker container serves which session.
 *
 * Lives in SQLite so that, after an orchestrator restart, adoption can
 * reconnect to existing containers even when their Docker labels are
 * stale (claimed warm containers still carry `orchestrator-session-id
 * =__warm__` as a label because Docker labels are immutable post-create
 * — the in-memory pool moved them from warm→active without updating
 * any label, and there's no Docker API to update labels on a running
 * container). The SQLite table is the authoritative source of truth;
 * Docker labels are kept only as a best-effort hint for ops tooling.
 *
 * Populated the instant a container becomes session-owned (fresh
 * spawn or warm claim). Cleared when the container is reaped or the
 * session is evicted. No schema migration at rest — plain durability.
 */
export type SessionContainer = {
  sessionId: string;
  agentId: string;
  containerId: string;
  containerName: string;
  containerPort: number;
  /** Per-container auth token. Required for WS reconnect after restart. */
  gatewayToken: string;
  claimedAt: number;
  /**
   * Wall-clock milliseconds the pool spent acquiring this container from
   * the caller's perspective. Definition varies by `poolSource`:
   *   - "cold" / "limited" — full spawn duration (create + /readyz + WS).
   *   - "warm" — 0 (container was already ready when the session claimed it).
   *   - "adopt" — null (the orchestrator did not spawn it).
   * Drives the inspector's "boot 4.1s" sub-label and the
   * container_boot_duration_seconds histogram.
   */
  bootMs: number | null;
  /**
   * Where this session's container came from. One of:
   *   - "cold"    — fresh spawn (no warm entry available, no limited networking).
   *   - "warm"    — claimed a pre-warmed container from the warm pool.
   *   - "limited" — fresh spawn with egress-proxy sidecar (networking:limited).
   *   - "adopt"   — adopted on orchestrator restart from an already-running container.
   */
  poolSource: "cold" | "warm" | "limited" | "adopt";
};

export interface SessionContainerStore {
  /** Upsert; overwrites any prior mapping for the session. */
  put(entry: SessionContainer): void;
  /** Look up by session. Returns undefined if no mapping is recorded. */
  get(sessionId: string): SessionContainer | undefined;
  /** Remove a session's mapping. Idempotent. */
  delete(sessionId: string): void;
  /** Enumerate every mapping. Used at adoption time. */
  list(): SessionContainer[];
}

/**
 * Backing store for the session event queue. Returned from buildStore so the
 * queue shares SQLite durability with agents/sessions on the default backend,
 * or stays in-memory for the test backend. Callers (router, startup drain)
 * use only this surface — the queue's identity as "durable" lives in the
 * store backend choice, not in router logic.
 */
export interface QueueStore {
  /** Append an event to the given session's queue. Ordered by enqueue time. */
  enqueue(sessionId: string, event: QueuedEvent): void;
  /** Remove and return the head event for the session, or undefined if empty. */
  shift(sessionId: string): QueuedEvent | undefined;
  /** Non-destructive count of queued events for a session. */
  size(sessionId: string): number;
  /** Remove every queued event for a session. Returns the number removed. */
  clear(sessionId: string): number;
  /**
   * Return every session id that currently has at least one queued event.
   * Used at orchestrator startup to resume interrupted drain loops.
   */
  listSessionsWithQueued(): string[];
}

/**
 * In-flight event payload — what a client POSTed while the session was busy.
 * The router shapes it; the store persists it verbatim.
 */
export type QueuedEvent = {
  content: string;
  /** Optional per-event model override. */
  model?: string;
  /** Optional per-event thinking-level override. */
  thinkingLevel?: string;
  enqueuedAt: number;
};
