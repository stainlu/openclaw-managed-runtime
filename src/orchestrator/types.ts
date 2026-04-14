import { z } from "zod";

// ---------- Agent (reusable template) ----------

export const CreateAgentRequestSchema = z.object({
  model: z.string().min(1, "model is required"),
  tools: z.array(z.string()).default([]),
  instructions: z.string().default(""),
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

export type AgentConfig = {
  agentId: string;
  model: string;
  tools: string[];
  instructions: string;
  name?: string;
  createdAt: number;
  /** See CreateAgentRequestSchema.callableAgents. Always populated (empty array if none). */
  callableAgents: string[];
  /** See CreateAgentRequestSchema.maxSubagentDepth. Always populated (0 if not set). */
  maxSubagentDepth: number;
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
});

export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;

// ---------- Event (the interaction primitive) ----------

// Event types map 1:1 to what flows through Pi's AgentSession event bus, just
// projected onto our HTTP API. For Item 2 the orchestrator only materializes
// user.message (posted by the client), agent.message (the model's reply), and
// agent.error (an unrecoverable run failure). Richer event types — tool_call,
// thinking, compaction — are added when we wire up the streaming event bus.
export type EventType = "user.message" | "agent.message" | "agent.error";

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
