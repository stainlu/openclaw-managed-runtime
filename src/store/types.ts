import type {
  AgentConfig,
  CreateAgentRequest,
  Event,
  EventType,
  Session,
} from "../orchestrator/types.js";

// All store methods are synchronous. The two concrete backends (in-memory and
// better-sqlite3) are both sync. If a future backend needs async I/O — a
// remote Postgres, a hosted KV — the interface will migrate to async at that
// point. Don't introduce speculative async today.

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
  create(args: { agentId: string; sessionId?: string }): Session;
  get(sessionId: string): Session | undefined;
  list(): Session[];
  delete(sessionId: string): boolean;
  beginRun(sessionId: string): Session | undefined;
  endRunSuccess(sessionId: string, usage: RunUsage): Session | undefined;
  endRunFailure(sessionId: string, error: string): Session | undefined;
  /**
   * Transition every session currently in "running" state to "failed" with
   * the given error. Intended for post-restart rehydration: any run that was
   * mid-flight when the orchestrator died is by definition orphaned (its
   * container was either torn down on restart or is no longer tracked by
   * this process). Returns the number of sessions that were transitioned.
   */
  failRunningSessions(reason: string): number;
}

export interface AppendEventInput {
  sessionId: string;
  type: EventType;
  content: string;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  model?: string;
}

export interface EventStore {
  append(input: AppendEventInput): Event;
  listBySession(sessionId: string): Event[];
  latestAgentMessage(sessionId: string): Event | undefined;
  deleteBySession(sessionId: string): void;
}

/**
 * The bundled store. buildStore() returns one of these; the router and server
 * receive the three leaves individually so they stay agnostic of which backend
 * is in use.
 */
export interface Store {
  readonly agents: AgentStore;
  readonly sessions: SessionStore;
  readonly events: EventStore;
  /** Closes any backing file handles or connections. Safe to call more than once. */
  close(): void;
}
