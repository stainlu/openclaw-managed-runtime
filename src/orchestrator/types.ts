import { z } from "zod";

// ---------- Agent (reusable template) ----------

export const CreateAgentRequestSchema = z.object({
  model: z.string().min(1, "model is required"),
  tools: z.array(z.string()).default([]),
  instructions: z.string().default(""),
  /** Optional stable display name for UI/logging. */
  name: z.string().optional(),
});

export type CreateAgentRequest = z.infer<typeof CreateAgentRequestSchema>;

export type AgentConfig = {
  agentId: string;
  model: string;
  tools: string[];
  instructions: string;
  name?: string;
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
  status: SessionStatus;
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
