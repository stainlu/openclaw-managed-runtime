import { z } from "zod";

// ---------- Agent (reusable template) ----------

export const PermissionPolicySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("always_allow") }),
  z.object({
    type: z.literal("deny"),
    tools: z.array(z.string().min(1)).min(1),
  }),
]);

export type PermissionPolicy = z.infer<typeof PermissionPolicySchema>;

export const CreateAgentRequestSchema = z.object({
  model: z.string().min(1, "model is required"),
  tools: z.array(z.string()).default([]),
  instructions: z.string().default(""),
  permissionPolicy: PermissionPolicySchema.default({ type: "always_allow" }),
  /** Optional stable display name for UI/logging. */
  name: z.string().optional(),
  /**
   * Item 12-14: list of agent IDs this agent is permitted to invoke via
   * the in-container `call_agent` tool. Default empty = no delegation.
   * Enforced both inside the call_agent tool (fast rejection) AND
   * orchestrator-side on POST /v1/sessions via X-OpenClaw-Parent-Token
   * verification (defense in depth).
   */
  callableAgents: z.array(z.string()).default([]),
  /**
   * Item 12-14: maximum recursion depth for subagent chains rooted at
   * this agent. Default 0 = this agent cannot spawn any subagents even
   * if callableAgents is non-empty. Each spawn decrements the parent
   * token's remaining_depth counter; at zero the orchestrator rejects
   * further POST /v1/sessions calls carrying that token.
   */
  maxSubagentDepth: z.number().int().min(0).default(0),
});

export type CreateAgentRequest = z.infer<typeof CreateAgentRequestSchema>;

export const UpdateAgentRequestSchema = z.object({
  version: z.number().int().min(1, "version is required for optimistic concurrency"),
  model: z.string().min(1).optional(),
  tools: z.array(z.string()).nullable().optional(),
  instructions: z.string().nullable().optional(),
  permissionPolicy: PermissionPolicySchema.optional(),
  name: z.string().nullable().optional(),
  callableAgents: z.array(z.string()).nullable().optional(),
  maxSubagentDepth: z.number().int().min(0).optional(),
});

export type UpdateAgentRequest = z.infer<typeof UpdateAgentRequestSchema>;

export type AgentConfig = {
  agentId: string;
  model: string;
  tools: string[];
  instructions: string;
  permissionPolicy: PermissionPolicy;
  name?: string;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  version: number;
  callableAgents: string[];
  maxSubagentDepth: number;
};

// ---------- Environment (container configuration template) ----------

// An environment defines WHAT the container provides: packages, networking,
// optionally a custom image. Agents define WHAT the brain does; environments
// define WHAT it runs in. Sessions compose both at creation time.

export const PackagesSchema = z
  .object({
    pip: z.array(z.string()).optional(),
    apt: z.array(z.string()).optional(),
    npm: z.array(z.string()).optional(),
  })
  .strict();

// v1: only unrestricted networking. "limited" mode (allowedHosts) requires
// per-container Docker network rules (iptables) which are non-trivial to
// implement correctly across VPS providers. Accepting "limited" without
// enforcement would give false security. Expand when enforcement is built.
export const NetworkingSchema = z.object({
  type: z.literal("unrestricted"),
});

export const CreateEnvironmentRequestSchema = z.object({
  name: z.string().min(1, "name is required"),
  packages: PackagesSchema.optional(),
  networking: NetworkingSchema.default({ type: "unrestricted" }),
});

export type CreateEnvironmentRequest = z.infer<
  typeof CreateEnvironmentRequestSchema
>;

export type Packages = z.infer<typeof PackagesSchema>;
export type Networking = z.infer<typeof NetworkingSchema>;

export type EnvironmentConfig = {
  environmentId: string;
  name: string;
  packages: Packages | null;
  networking: Networking;
  createdAt: number;
};

// ---------- Session (long-lived, one per conversation) ----------

// Sessions are durable and outlive individual turns. A session is idle when
// no run is in flight, running while a container is processing an event, and
// failed only when a run hit an unrecoverable error. A session never enters
// a terminal "completed" state; individual events can complete, the session
// stays open.
export type SessionStatus = "idle" | "running" | "failed";

export type Session = {
  sessionId: string;
  agentId: string;
  environmentId: string | null;
  status: SessionStatus;
  /**
   * True when the session was auto-created by POST /v1/chat/completions
   * without a client-supplied session key. The pool's idle sweeper deletes
   * ephemeral sessions (JSONL + store row) when their container is reaped,
   * so one-shot OpenAI-style calls don't accumulate forever. Explicitly
   * named sessions (POST /v1/sessions, or chat.completions with a session
   * key) are never ephemeral.
   */
  ephemeral: boolean;
  /**
   * Item 12-14: remaining subagent spawns allowed from this session's
   * container via the in-container `call_agent` tool. Initialized at
   * session creation time from either the agent template's
   * `maxSubagentDepth` (top-level sessions) or from the parent token's
   * `remaining_depth - 1` (child sessions, created with
   * X-OpenClaw-Parent-Token). Persisted so that when the pool respawns a
   * container for this session, the orchestrator mints a parent token
   * with the correct remaining depth.
   */
  remainingSubagentDepth: number;
  /** Rolling sum of agent.message event tokens since the session was created. */
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  /** Error from the most recent failed run. Cleared when the next run starts. */
  error: string | null;
  createdAt: number;
  /** Updated whenever any event is appended. Null for an empty session. */
  lastEventAt: number | null;
};

export const CreateSessionRequestSchema = z.object({
  agentId: z.string().min(1, "agentId is required"),
  environmentId: z.string().min(1).optional(),
});

export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;

// ---------- Event (the interaction primitive) ----------

// Event types projected from Pi's JSONL session file onto our HTTP API.
// Agent-level events (message, tool_use, tool_result, thinking) come from
// Pi's message entries. Session-level events (model_change,
// thinking_level_change, compaction) come from Pi's metadata entries.
// session.status_* events are synthetic — emitted by the orchestrator in
// the SSE stream, not read from the JSONL.
export type EventType =
  | "user.message"
  | "agent.message"
  | "agent.error"
  | "agent.tool_use"
  | "agent.tool_result"
  | "agent.thinking"
  | "session.model_change"
  | "session.thinking_level_change"
  | "session.compaction";

export type Event = {
  eventId: string;
  sessionId: string;
  type: EventType;
  content: string;
  createdAt: number;
  /** Per-run usage. Populated on agent.message; undefined on user.message. */
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  /** Actual model used for this turn, when known. Informational. */
  model?: string;
  /** Tool call fields — populated on agent.tool_use and agent.tool_result. */
  toolName?: string;
  toolCallId?: string;
  toolArguments?: Record<string, unknown>;
  isError?: boolean;
};

// Clients can only post user events. Agent events are emitted by the runtime.
// The type field is optional with a default so trivial clients can send just
// `{ content }` and still get the correct tagging.
//
// Item 7 added the optional `model` field. `interrupt: true` (Pi steer) is
// intentionally NOT exposed yet — see the docstring on AgentRouter.runEvent
// for the design constraint that pushed it to a follow-up. Cancel + queue
// + model are sufficient for the first cut of control endpoints.
export const PostEventRequestSchema = z.object({
  type: z.literal("user.message").default("user.message"),
  content: z.string().min(1, "content is required"),
  /**
   * Optional model override applied via WS sessions.patch before this
   * event is processed. Pi's setModel is session-scoped, so the new
   * model persists for this and subsequent events on this session
   * until changed again.
   */
  model: z.string().min(1).optional(),
});

export type PostEventRequest = z.infer<typeof PostEventRequestSchema>;

// ---------- Backwards-compat adapter ----------

// Retained so that existing OpenAI-style callers keep working after the
// session-centric rewrite. server.ts maps this onto createSession + runEvent
// under the hood.
export const RunAgentRequestSchema = z.object({
  task: z.string().min(1, "task is required"),
  /** Reuse an existing session instead of creating a fresh one. */
  sessionId: z.string().optional(),
});

export type RunAgentRequest = z.infer<typeof RunAgentRequestSchema>;

// ---------- OpenAI-compat adapter ----------

// POST /v1/chat/completions accepts the OpenAI ChatCompletionRequest shape
// as a thin compatibility shim over the session/event API. Every field we
// don't explicitly use is deliberately ignored (.passthrough()) so
// clients migrating from OpenAI SDKs don't need to strip anything.
//
// Documented ignored fields:
//   - model: the agent template's configured model wins. To override the
//     model, use native POST /v1/sessions/:id/events with the `model` field.
//   - messages entries other than the trailing role=user: Pi's
//     SessionManager owns history on sticky sessions; for ephemeral
//     sessions only the final user message defines the turn.
//   - role="system" messages: use the agent template's instructions
//     (which becomes systemPromptOverride) instead.
//   - temperature, top_p, max_tokens, n, logprobs, stop, tools, functions,
//     response_format, seed, tool_choice, etc.: silently ignored.
//
// The shape is permissive at parse time; the handler validates that at
// least one user message with non-empty string content exists after the
// schema passes.
export const OpenAIChatMessageSchema = z
  .object({
    role: z.string().min(1),
    content: z.unknown().optional(),
  })
  .passthrough();

export const OpenAIChatCompletionRequestSchema = z
  .object({
    model: z.string().optional(),
    messages: z.array(OpenAIChatMessageSchema).min(1),
    stream: z.boolean().optional(),
    user: z.string().optional(),
  })
  .passthrough();

export type OpenAIChatCompletionRequest = z.infer<
  typeof OpenAIChatCompletionRequestSchema
>;
