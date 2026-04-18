import { z } from "zod";

// ---------- Agent (reusable template) ----------

export const PermissionPolicySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("always_allow") }),
  z.object({
    type: z.literal("deny"),
    tools: z.array(z.string().min(1)).min(1),
  }),
  z.object({
    type: z.literal("always_ask"),
    /** Tools that require client confirmation before execution.
     *  If omitted, ALL tools require confirmation.  */
    tools: z.array(z.string().min(1)).optional(),
  }),
]);

export type PermissionPolicy = z.infer<typeof PermissionPolicySchema>;

// Per-session quotas attached to an agent template. Enforced by the
// router BEFORE each turn (runEvent + streamEvent): cost is checked
// against the session's rolling cost_usd, tokens against the combined
// input+output totals, and duration against wall time since
// session.createdAt. A session that trips any quota rejects with
// `quota_exceeded` and must be recreated. Left undefined = no cap.
// Values are per-session, not per-agent: the agent template defines
// the limits, every session derived from it gets its own budget.
export const QuotaSchema = z
  .object({
    maxCostUsdPerSession: z.number().positive().optional(),
    maxTokensPerSession: z.number().int().positive().optional(),
    maxWallDurationMs: z.number().int().positive().optional(),
  })
  .strict();

export type Quota = z.infer<typeof QuotaSchema>;

// MCP server declaration attached to an agent template. Shape passes
// through to openclaw's mcp.servers block verbatim (see
// openclaw/src/config/zod-schema.ts:209 McpServerSchema). We accept
// both stdio (command + args + env) and streamable-HTTP (url +
// headers) transports. `passthrough()` so upstream can add new
// transport fields without requiring a release on our side.
export const McpServerConfigSchema = z
  .object({
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: z
      .record(
        z.string(),
        z.union([z.string(), z.number(), z.boolean()]),
      )
      .optional(),
    cwd: z.string().optional(),
    url: z.string().url().optional(),
    headers: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();

export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;
export type McpServers = Record<string, McpServerConfig>;

/**
 * Pi's extended-thinking levels. "off" suppresses thinking output even on
 * reasoning-capable models; "low" through "xhigh" allocate increasing
 * thinking budget. Accepted verbatim by openclaw.json's
 * agents.list[].thinkingLevel field — see pi-mono's agent runtime for
 * budget semantics. Providers that don't support thinking ignore this
 * field (no error), so it's safe to set on any agent.
 */
export const ThinkingLevelSchema = z.enum(["off", "low", "medium", "high", "xhigh"]);
export type ThinkingLevel = z.infer<typeof ThinkingLevelSchema>;

export const CreateAgentRequestSchema = z.object({
  model: z.string().min(1, "model is required"),
  tools: z.array(z.string()).default([]),
  instructions: z.string().default(""),
  permissionPolicy: PermissionPolicySchema.default({ type: "always_allow" }),
  /** Optional stable display name for UI/logging. */
  name: z.string().optional(),
  /**
   * Default Pi thinking budget for this agent. Passed to openclaw.json as
   * agents.list[].thinkingLevel. Per-turn override available via
   * PostUserMessage.thinkingLevel. Defaults to "off" matching Pi's
   * default for non-reasoning usage.
   */
  thinkingLevel: ThinkingLevelSchema.default("off"),
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
  /**
   * Object of MCP servers this agent exposes to Claude. Keyed by server
   * name — the key is what the agent refers to the server as in tool
   * calls. Value is the transport-specific config. Empty object = no
   * MCP servers (default). Forwarded verbatim to the container via
   * OPENCLAW_MCP_SERVERS_JSON, which the entrypoint writes into
   * openclaw.json's `mcp.servers` block.
   */
  mcpServers: z.record(z.string(), McpServerConfigSchema).default({}),
  /** Optional per-session budget caps. Absent = no cap. */
  quota: QuotaSchema.optional(),
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
  mcpServers: z
    .record(z.string(), McpServerConfigSchema)
    .nullable()
    .optional(),
  quota: QuotaSchema.nullable().optional(),
  thinkingLevel: ThinkingLevelSchema.optional(),
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
  mcpServers: McpServers;
  quota?: Quota;
  thinkingLevel: ThinkingLevel;
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

// Egress networking policy.
//
// - "unrestricted" (default): agent container joins the shared bridge
//   network and can reach any host on the internet. Legacy behavior.
//
// - "limited": agent container is spawned on a --internal Docker
//   network (no direct egress) paired with an egress-proxy sidecar
//   that filters outbound connections against `allowedHosts`. Proxy-
//   layer check on HTTP/HTTPS + DNS-layer check on UDP 53, so raw-
//   socket and DNS exfiltration paths are both closed. Enforcement
//   is at the Docker bridge / sidecar level, not inside the agent
//   container — the agent cannot bypass it even with arbitrary code
//   execution. See `docs/designs/networking-limited.md` for the full
//   design and `test/e2e-networking.sh` for the 9-case enforcement
//   proof (run on native Linux in CI).
//
// Allowed-hosts format:
//   - Plain hostname: "api.openai.com"
//   - Wildcard prefix: "*.googleapis.com" matches any hostname ending
//     in ".googleapis.com" (at any depth). `googleapis.com` bare is
//     NOT matched — list it separately.
//   - No IPs, no CIDRs, no ports, no schemes. Hostnames only.
const HOSTNAME_PATTERN_RE = /^[a-z0-9*](?:[a-z0-9.*-]{0,253}[a-z0-9])?$/i;
// IPv4 literals are rejected — a real hostname has at least one
// non-digit character in at least one label, so anything matching
// `\d+(\.\d+)*` is unambiguously an IP.
const IPV4_LIKE_RE = /^\d+(\.\d+)*$/;
export const NetworkingSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("unrestricted") }),
  z.object({
    type: z.literal("limited"),
    allowedHosts: z
      .array(
        z
          .string()
          .min(1)
          .max(253, "allowedHost entry must be <= 253 characters")
          .regex(
            HOSTNAME_PATTERN_RE,
            'allowedHost entries must be hostnames (e.g. "api.example.com" or "*.example.com"); IPs, ports, and URL schemes are not allowed',
          )
          .refine((v) => !IPV4_LIKE_RE.test(v), {
            message: "allowedHost entries must be hostnames, not IP literals",
          }),
      )
      .min(1, "allowedHosts must contain at least one entry")
      .max(256, "allowedHosts supports at most 256 entries"),
  }),
]);

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
  | "agent.tool_confirmation_request"
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
  /** Approval request id — populated on agent.tool_confirmation_request.
   *  The client must include this in `user.tool_confirmation.toolUseId`. */
  approvalId?: string;
};

// Clients post events to sessions. The two event types are:
//
//   user.message — a conversation turn (the common case). Triggers
//     the agent loop inside the container.
//
//   user.tool_confirmation — response to an `agent.tool_confirmation_request`
//     SSE event. Resolves a pending tool-approval gate when the agent
//     template has `permissionPolicy: { type: "always_ask" }`. The
//     container's hook blocks until the confirmation is resolved.
//
// Item 7 added the optional `model` field on user.message. `interrupt:
// true` (Pi steer) is intentionally NOT exposed yet — see the docstring
// on AgentRouter.runEvent for the design constraint.

export const PostUserMessageSchema = z.object({
  type: z.literal("user.message").default("user.message"),
  content: z.string().min(1, "content is required"),
  /**
   * Optional model override applied via WS sessions.patch before this
   * event is processed. Pi's setModel is session-scoped, so the new
   * model persists for this and subsequent events on this session
   * until changed again.
   */
  model: z.string().min(1).optional(),
  /**
   * Optional per-turn thinking level override. Applied via WS
   * sessions.patch before the chat completion runs. Session-scoped like
   * `model` — persists for subsequent events until changed. Use "off"
   * to explicitly suppress thinking on a reasoning-capable model for
   * one turn.
   */
  thinkingLevel: ThinkingLevelSchema.optional(),
});

export const PostToolConfirmationSchema = z.object({
  type: z.literal("user.tool_confirmation"),
  /** The approval request ID from the `agent.tool_confirmation_request` SSE event. */
  toolUseId: z.string().min(1, "toolUseId is required"),
  /** "allow" proceeds with execution; "deny" blocks it (with optional message). */
  result: z.enum(["allow", "deny"]),
  /** Optional explanation when denying (forwarded to the agent). */
  denyMessage: z.string().optional(),
});

// Parse with .default() so that a bare `{ content }` is treated as user.message.
export const PostEventRequestSchema = z.union([
  PostUserMessageSchema,
  PostToolConfirmationSchema,
]);

export type PostEventRequest = z.infer<typeof PostEventRequestSchema>;
export type PostUserMessage = z.infer<typeof PostUserMessageSchema>;
export type PostToolConfirmation = z.infer<typeof PostToolConfirmationSchema>;

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
