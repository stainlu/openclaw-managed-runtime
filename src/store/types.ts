import type {
  AgentConfig,
  CreateAgentRequest,
  Session,
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

export interface AgentStore {
  create(req: CreateAgentRequest): AgentConfig;
  get(agentId: string): AgentConfig | undefined;
  list(): AgentConfig[];
  delete(agentId: string): boolean;
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
   */
  create(args: {
    agentId: string;
    sessionId?: string;
    ephemeral?: boolean;
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
  readonly sessions: SessionStore;
  /** Closes any backing file handles or connections. Safe to call more than once. */
  close(): void;
}
