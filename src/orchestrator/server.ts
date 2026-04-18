import { randomBytes } from "node:crypto";
import { serve } from "@hono/node-server";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { streamSSE } from "hono/streaming";
import { createAuthMiddleware } from "../auth.js";
import { writeAudit } from "../audit.js";
import { addContext, getLogger, withContext } from "../log.js";
import { createRateLimitMiddleware } from "../rate-limit.js";
import {
  agentsCreatedTotal,
  httpRequestDurationSeconds,
  httpRequestsTotal,
  registry as metricsRegistry,
  sessionEventsTotal,
} from "../metrics.js";
import type { ParentTokenMinter } from "../runtime/parent-token.js";
import type { PiJsonlEventReader } from "../store/pi-jsonl.js";
import type {
  AgentStore,
  AuditStore,
  EnvironmentStore,
  SessionStore,
} from "../store/types.js";
import { portalHtml } from "./portal.js";
import { AgentRouter, RouterError } from "./router.js";
import {
  CreateAgentRequestSchema,
  CreateEnvironmentRequestSchema,
  CreateSessionRequestSchema,
  OpenAIChatCompletionRequestSchema,
  PostEventRequestSchema,
  RunAgentRequestSchema,
  UpdateAgentRequestSchema,
  type AgentConfig,
  type EnvironmentConfig,
  type Event,
  type Session,
} from "./types.js";

const log = getLogger("server");

function generateRequestId(): string {
  return `req_${randomBytes(8).toString("hex")}`;
}

/**
 * Per-request context middleware. Reads or generates an `x-request-id`,
 * echoes it on the response, and wraps the downstream handlers in an
 * AsyncLocalStorage scope so every log line picks it up automatically.
 * Also records the request duration + status histogram for /metrics.
 */
const observabilityMiddleware: MiddlewareHandler = async (c, next) => {
  const requestId = c.req.header("x-request-id") ?? generateRequestId();
  c.res.headers.set("x-request-id", requestId);

  // routePath prefers the matched pattern (e.g. "/v1/sessions/:sessionId"),
  // falling back to the raw path when no route matched. Keeps label
  // cardinality bounded — we never put user-supplied ids into metrics.
  const routePath = c.req.routePath || c.req.path;
  const endTimer = httpRequestDurationSeconds.startTimer({
    method: c.req.method,
    route: routePath,
  });

  await withContext({ requestId }, async () => {
    try {
      await next();
    } finally {
      const status = String(c.res.status);
      endTimer();
      httpRequestsTotal.inc({
        method: c.req.method,
        route: routePath,
        status,
      });
    }
  });
};

// Regex for client-supplied session keys on POST /v1/chat/completions. The
// key is used verbatim as the orchestrator session id AND as the directory
// component under the host mount, so we constrain it to safe characters.
// 128 chars is generous and still shorter than most filesystem limits.
const SESSION_KEY_RE = /^[a-zA-Z0-9_-]{1,128}$/;

// Polling config for /v1/chat/completions blocking wait. The cap matches
// the legacy runTimeoutMs default (10 minutes) — long enough for Moonshot's
// occasional 429 retry cascades, short enough to bound client timeouts.
const CHAT_COMPLETION_TIMEOUT_MS = 10 * 60_000;
const CHAT_COMPLETION_POLL_MS = 500;

export type ServerDeps = {
  agents: AgentStore;
  environments: EnvironmentStore;
  sessions: SessionStore;
  events: PiJsonlEventReader;
  audit: AuditStore;
  router: AgentRouter;
  /**
   * Baseline bearer-token auth. Undefined or empty string → auth
   * disabled (localhost dev default). Any non-empty string → every
   * route except /healthz and /metrics requires
   * `Authorization: Bearer <apiToken>`.
   */
  apiToken?: string;
  /**
   * Per-caller rate limit in requests-per-minute. 0 or undefined
   * disables rate limiting. Keyed by Bearer token when present, else
   * client IP (x-forwarded-for first entry, else peer). `/healthz`
   * and `/metrics` always bypass.
   */
  rateLimitRpm?: number;
  /**
   * Item 12-14: parent-token minter/verifier. POST /v1/sessions verifies
   * an optional X-OpenClaw-Parent-Token header against this minter when a
   * call originates from an in-container `call_agent` CLI tool, enforcing
   * the parent agent template's `callableAgents` allowlist and
   * `maxSubagentDepth` cap. Absent header = top-level client call,
   * allowed unconditionally (no tenant auth layer in v1).
   */
  tokenMinter: ParentTokenMinter;
  /** Semver from package.json, surfaced on GET /. */
  version: string;
};

function agentResponse(agent: AgentConfig) {
  return {
    agent_id: agent.agentId,
    model: agent.model,
    tools: agent.tools,
    instructions: agent.instructions,
    permission_policy: agent.permissionPolicy,
    name: agent.name,
    callable_agents: agent.callableAgents,
    max_subagent_depth: agent.maxSubagentDepth,
    mcp_servers: agent.mcpServers,
    quota: agent.quota,
    thinking_level: agent.thinkingLevel,
    version: agent.version,
    created_at: agent.createdAt,
    updated_at: agent.updatedAt,
    archived_at: agent.archivedAt,
  };
}

function environmentResponse(env: EnvironmentConfig) {
  return {
    environment_id: env.environmentId,
    name: env.name,
    packages: env.packages,
    networking: env.networking,
    created_at: env.createdAt,
  };
}

// Session response shape. `output` is a computed convenience: the content of
// the most recent agent.message in the session, or null if none yet. The
// event log lives in Pi's JSONL on the host mount — see PiJsonlEventReader.
function sessionResponse(session: Session, events: PiJsonlEventReader) {
  const latestAgent = events.latestAgentMessage(session.agentId, session.sessionId);
  return {
    session_id: session.sessionId,
    agent_id: session.agentId,
    environment_id: session.environmentId,
    status: session.status,
    output: latestAgent?.content ?? null,
    tokens: {
      input: session.tokensIn,
      output: session.tokensOut,
    },
    cost_usd: session.costUsd,
    error: session.error,
    created_at: session.createdAt,
    last_event_at: session.lastEventAt,
  };
}

function eventResponse(event: Event) {
  return {
    event_id: event.eventId,
    session_id: event.sessionId,
    type: event.type,
    content: event.content,
    created_at: event.createdAt,
    tokens:
      event.tokensIn !== undefined || event.tokensOut !== undefined
        ? { input: event.tokensIn ?? 0, output: event.tokensOut ?? 0 }
        : undefined,
    cost_usd: event.costUsd,
    model: event.model,
    tool_name: event.toolName,
    tool_call_id: event.toolCallId,
    tool_arguments: event.toolArguments,
    is_error: event.isError,
    approval_id: event.approvalId,
  };
}

function handleRouterError(err: unknown, c: Context): Response {
  if (err instanceof RouterError) {
    if (err.code === "agent_not_found" || err.code === "session_not_found") {
      return c.json({ error: err.code, message: err.message }, 404);
    }
    if (err.code === "agent_archived") {
      return c.json({ error: err.code, message: err.message }, 409);
    }
    if (err.code === "session_busy" || err.code === "session_not_running") {
      return c.json({ error: err.code, message: err.message }, 409);
    }
    if (err.code === "quota_exceeded") {
      return c.json({ error: err.code, message: err.message }, 429);
    }
    return c.json({ error: err.code, message: err.message }, 500);
  }
  const msg = err instanceof Error ? err.message : String(err);
  return c.json({ error: "internal", message: msg }, 500);
}

export function buildApp(deps: ServerDeps): Hono {
  const app = new Hono();

  // Register the observability middleware first so every downstream
  // handler (including SSE streams) runs inside the request-id scope
  // and contributes to http_requests_total / http_request_duration_seconds.
  // Rate limiting runs BEFORE auth so unauthenticated floods are capped
  // even while auth middleware cheaply rejects them — the attacker still
  // has to burn one request per rejection. Auth then runs so 401s still
  // show up in metrics (you want to see auth failures). `/healthz` and
  // `/metrics` are whitelisted by all three middlewares independently.
  app.use("*", observabilityMiddleware);
  app.use("*", createRateLimitMiddleware({ rpm: deps.rateLimitRpm ?? 0 }));
  app.use("*", createAuthMiddleware({ token: deps.apiToken }));

  // Prometheus scrape endpoint. Not auth-gated (matches /healthz) —
  // operators firewall :8080 if the metrics should not be public.
  app.get("/metrics", async (c) => {
    c.header("Content-Type", metricsRegistry.contentType);
    return c.body(await metricsRegistry.metrics());
  });

  // Self-documenting root. A developer landing on the orchestrator gets the
  // full endpoint map without needing to read docs first.
  //
  // Browsers (Accept: text/html) get the single-page console at the same
  // URL instead. No client-side routing — the portal lives entirely in
  // portal.ts and talks to the same /v1/* HTTP endpoints the SDKs use.
  app.get("/", (c) => {
    const accept = c.req.header("accept") ?? "";
    if (accept.includes("text/html")) {
      return c.html(portalHtml({ authRequired: Boolean(deps.apiToken), version: deps.version }));
    }
    return c.json({
      name: "OpenClaw Managed Agents",
      description: "The open alternative to Claude Managed Agents.",
      version: deps.version,
      docs: "https://github.com/stainlu/openclaw-managed-agents",
      auth: deps.apiToken
        ? "required (Authorization: Bearer <OPENCLAW_API_TOKEN>)"
        : "disabled (OPENCLAW_API_TOKEN unset — do NOT expose this port beyond loopback)",
      rate_limit: deps.rateLimitRpm
        ? `${deps.rateLimitRpm} req/min per caller (keyed by token, else IP)`
        : "disabled (OPENCLAW_RATE_LIMIT_RPM unset or 0)",
      endpoints: {
        agents: {
          create: "POST /v1/agents",
          list: "GET /v1/agents",
          get: "GET /v1/agents/:agentId",
          update: "PATCH /v1/agents/:agentId",
          delete: "DELETE /v1/agents/:agentId",
          list_versions: "GET /v1/agents/:agentId/versions",
          archive: "POST /v1/agents/:agentId/archive",
          run: "POST /v1/agents/:agentId/run",
        },
        environments: {
          create: "POST /v1/environments",
          list: "GET /v1/environments",
          get: "GET /v1/environments/:environmentId",
          delete: "DELETE /v1/environments/:environmentId",
        },
        sessions: {
          create: "POST /v1/sessions",
          list: "GET /v1/sessions",
          get: "GET /v1/sessions/:sessionId",
          delete: "DELETE /v1/sessions/:sessionId",
          post_event: "POST /v1/sessions/:sessionId/events",
          list_events: "GET /v1/sessions/:sessionId/events",
          stream_events: "GET /v1/sessions/:sessionId/events?stream=true",
          cancel: "POST /v1/sessions/:sessionId/cancel",
          compact: "POST /v1/sessions/:sessionId/compact",
        },
        openai_compat: {
          chat_completions: "POST /v1/chat/completions",
        },
        audit: {
          list: "GET /v1/audit?since=<ts>&action=<verb>&target=<id>&limit=<n>",
        },
        health: {
          liveness: "GET /healthz",
          metrics: "GET /metrics",
        },
      },
    });
  });

  app.get("/healthz", (c) => c.json({ ok: true, version: deps.version }));

  // ---------- Agents (reusable templates) ----------

  app.post("/v1/agents", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = CreateAgentRequestSchema.safeParse(body);
    if (!parsed.success) {
      writeAudit(deps.audit, c, {
        action: "agent.create",
        target: null,
        outcome: "invalid_request",
      });
      return c.json({ error: "invalid_request", details: parsed.error.format() }, 400);
    }
    const agent = deps.agents.create(parsed.data);
    agentsCreatedTotal.inc();
    addContext({ agentId: agent.agentId });
    writeAudit(deps.audit, c, {
      action: "agent.create",
      target: agent.agentId,
      outcome: "ok",
      metadata: { model: agent.model, name: agent.name },
    });
    // Pre-warm a container for this agent so the first session's cold-start
    // is eliminated. Fire-and-forget — failure is non-fatal.
    void deps.router.warmForAgent(agent.agentId).catch((err) => {
      log.warn({ err, agent_id: agent.agentId }, "warm-for-agent failed (non-fatal)");
    });
    return c.json(agentResponse(agent));
  });

  app.get("/v1/agents", (c) => {
    const agents = deps.agents.list().map(agentResponse);
    return c.json({ agents, count: agents.length });
  });

  app.get("/v1/agents/:agentId", (c) => {
    const agentId = c.req.param("agentId");
    const agent = deps.agents.get(agentId);
    if (!agent) {
      return c.json({ error: "agent_not_found" }, 404);
    }
    return c.json(agentResponse(agent));
  });

  app.delete("/v1/agents/:agentId", (c) => {
    const agentId = c.req.param("agentId");
    const existed = deps.agents.delete(agentId);
    writeAudit(deps.audit, c, {
      action: "agent.delete",
      target: agentId,
      outcome: existed ? "ok" : "agent_not_found",
    });
    if (!existed) {
      return c.json({ error: "agent_not_found" }, 404);
    }
    return c.json({ deleted: true });
  });

  app.patch("/v1/agents/:agentId", async (c) => {
    const agentId = c.req.param("agentId");
    const body = await c.req.json().catch(() => ({}));
    const parsed = UpdateAgentRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "invalid_request", details: parsed.error.format() }, 400);
    }
    const agent = deps.agents.get(agentId);
    if (!agent) return c.json({ error: "agent_not_found" }, 404);
    if (agent.archivedAt) return c.json({ error: "agent_archived", message: "archived agents cannot be updated" }, 409);
    if (agent.version !== parsed.data.version) {
      return c.json({ error: "version_conflict", message: `expected version ${agent.version}, got ${parsed.data.version}` }, 409);
    }
    const updated = deps.agents.update(agentId, parsed.data);
    if (!updated) {
      writeAudit(deps.audit, c, {
        action: "agent.update",
        target: agentId,
        outcome: "version_conflict",
      });
      return c.json({ error: "version_conflict" }, 409);
    }
    writeAudit(deps.audit, c, {
      action: "agent.update",
      target: agentId,
      outcome: "ok",
      metadata: { new_version: updated.version },
    });
    return c.json(agentResponse(updated));
  });

  app.get("/v1/agents/:agentId/versions", (c) => {
    const agentId = c.req.param("agentId");
    const agent = deps.agents.get(agentId);
    if (!agent) return c.json({ error: "agent_not_found" }, 404);
    const versions = deps.agents.listVersions(agentId).map(agentResponse);
    return c.json({ agent_id: agentId, versions, count: versions.length });
  });

  app.post("/v1/agents/:agentId/archive", (c) => {
    const agentId = c.req.param("agentId");
    const archived = deps.agents.archive(agentId);
    writeAudit(deps.audit, c, {
      action: "agent.archive",
      target: agentId,
      outcome: archived ? "ok" : "agent_not_found",
    });
    if (!archived) return c.json({ error: "agent_not_found" }, 404);
    return c.json(agentResponse(archived));
  });

  // ---------- Environments (container configuration templates) ----------

  app.post("/v1/environments", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = CreateEnvironmentRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "invalid_request", details: parsed.error.format() }, 400);
    }
    const env = deps.environments.create(parsed.data);
    return c.json(environmentResponse(env));
  });

  app.get("/v1/environments", (c) => {
    const envs = deps.environments.list().map(environmentResponse);
    return c.json({ environments: envs, count: envs.length });
  });

  app.get("/v1/environments/:environmentId", (c) => {
    const environmentId = c.req.param("environmentId");
    const env = deps.environments.get(environmentId);
    if (!env) {
      return c.json({ error: "environment_not_found" }, 404);
    }
    return c.json(environmentResponse(env));
  });

  app.delete("/v1/environments/:environmentId", (c) => {
    const environmentId = c.req.param("environmentId");
    const env = deps.environments.get(environmentId);
    if (!env) {
      return c.json({ error: "environment_not_found" }, 404);
    }
    const referencingSessions = deps.sessions.list().filter(
      (s) => s.environmentId === environmentId,
    );
    if (referencingSessions.length > 0) {
      return c.json({
        error: "environment_in_use",
        message: `${referencingSessions.length} session(s) reference this environment`,
      }, 409);
    }
    deps.environments.delete(environmentId);
    return c.json({ deleted: true });
  });

  // ---------- Sessions (long-lived, session-centric API) ----------

  app.post("/v1/sessions", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = CreateSessionRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "invalid_request", details: parsed.error.format() }, 400);
    }

    // Item 12-14: optional X-OpenClaw-Parent-Token header. Present when
    // the request originates from an in-container `call_agent` CLI tool.
    // Absent = top-level client call, permitted without a token check.
    // When present: verify the signature, check the target agentId is in
    // the parent token's allowlist, and ensure remaining depth > 0. The
    // new child session inherits `parent.remaining_depth - 1` as its own
    // remainingSubagentDepth, so if the parent allowed depth N, the child
    // will allow N-1 further spawns from its own container.
    const parentTokenHeader = c.req.header("x-openclaw-parent-token");
    let remainingSubagentDepthOverride: number | undefined;
    if (parentTokenHeader) {
      const payload = deps.tokenMinter.verify(parentTokenHeader);
      if (!payload) {
        return c.json(
          { error: "invalid_parent_token", message: "parent token failed verification" },
          403,
        );
      }
      if (!payload.allowlist.includes(parsed.data.agentId)) {
        return c.json(
          {
            error: "agent_not_in_allowlist",
            message: `parent agent ${payload.parentAgentId} is not permitted to spawn ${parsed.data.agentId}`,
          },
          403,
        );
      }
      if (payload.remainingDepth <= 0) {
        return c.json(
          {
            error: "max_subagent_depth_reached",
            message: `parent token has no remaining subagent depth (parent: ${payload.parentAgentId})`,
          },
          403,
        );
      }
      remainingSubagentDepthOverride = payload.remainingDepth - 1;
    }

    if (parsed.data.environmentId) {
      const env = deps.environments.get(parsed.data.environmentId);
      if (!env) {
        return c.json({ error: "environment_not_found", message: `environment ${parsed.data.environmentId} does not exist` }, 404);
      }
    }

    try {
      const session = deps.router.createSession(parsed.data.agentId, {
        environmentId: parsed.data.environmentId,
        remainingSubagentDepth: remainingSubagentDepthOverride,
      });
      // Proactive warm-up: start booting the container in the background
      // so it's ready (or nearly ready) by the time the first event arrives.
      // Fire-and-forget — failure is non-fatal; the first event cold-spawns.
      addContext({ agentId: parsed.data.agentId, sessionId: session.sessionId });
      writeAudit(deps.audit, c, {
        action: "session.create",
        target: session.sessionId,
        outcome: "ok",
        metadata: {
          agent_id: session.agentId,
          environment_id: session.environmentId,
          is_subagent: remainingSubagentDepthOverride !== undefined,
        },
      });
      void deps.router.warmSession(session.sessionId).catch((err) => {
        log.warn({ err, session_id: session.sessionId }, "background warm-up failed (non-fatal)");
      });
      return c.json(sessionResponse(session, deps.events));
    } catch (err) {
      writeAudit(deps.audit, c, {
        action: "session.create",
        target: null,
        outcome: err instanceof RouterError ? err.code : "error",
        metadata: { agent_id: parsed.data.agentId },
      });
      return handleRouterError(err, c);
    }
  });

  app.get("/v1/sessions", (c) => {
    const sessions = deps.sessions.list().map((s) => sessionResponse(s, deps.events));
    return c.json({ sessions, count: sessions.length });
  });

  app.get("/v1/sessions/:sessionId", (c) => {
    const sessionId = c.req.param("sessionId");
    const session = deps.sessions.get(sessionId);
    if (!session) {
      return c.json({ error: "session_not_found" }, 404);
    }
    return c.json(sessionResponse(session, deps.events));
  });

  app.delete("/v1/sessions/:sessionId", (c) => {
    const sessionId = c.req.param("sessionId");
    const session = deps.sessions.get(sessionId);
    if (!session) {
      writeAudit(deps.audit, c, {
        action: "session.delete",
        target: sessionId,
        outcome: "session_not_found",
      });
      return c.json({ error: "session_not_found" }, 404);
    }
    // Drop the Pi JSONL + sessions.json entry on disk first, then the
    // orchestrator-side metadata row.
    deps.events.deleteBySession(session.agentId, session.sessionId);
    deps.sessions.delete(sessionId);
    writeAudit(deps.audit, c, {
      action: "session.delete",
      target: sessionId,
      outcome: "ok",
      metadata: { agent_id: session.agentId },
    });
    return c.json({ deleted: true });
  });

  // ---------- Events (read from Pi's JSONL) ----------

  app.post("/v1/sessions/:sessionId/events", async (c) => {
    const sessionId = c.req.param("sessionId");
    const body = await c.req.json().catch(() => ({}));
    const parsed = PostEventRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "invalid_request", details: parsed.error.format() }, 400);
    }
    const event = parsed.data;
    addContext({ sessionId });
    sessionEventsTotal.inc({ type: event.type });

    // Tool confirmation flow — resolves a pending approval gate inside
    // the container when the agent template has always_ask policy.
    if (event.type === "user.tool_confirmation") {
      try {
        await deps.router.confirmTool(
          sessionId,
          event.toolUseId,
          event.result,
          event.denyMessage,
        );
        return c.json({ session_id: sessionId, confirmed: true });
      } catch (err) {
        return handleRouterError(err, c);
      }
    }

    // User message flow — triggers the agent loop.
    try {
      const result = await deps.router.runEvent({
        sessionId,
        content: event.content,
        model: event.model,
        thinkingLevel: event.thinkingLevel,
      });
      // The event id is Pi's — we don't know it until the JSONL is written.
      // Clients that need to correlate this response with the persisted
      // event should poll GET /v1/sessions/:sessionId/events once the
      // session flips back to idle.
      return c.json({
        session_id: result.session.sessionId,
        session_status: result.session.status,
        queued: result.queued,
      });
    } catch (err) {
      return handleRouterError(err, c);
    }
  });

  app.post("/v1/sessions/:sessionId/cancel", async (c) => {
    const sessionId = c.req.param("sessionId");
    try {
      const session = await deps.router.cancel(sessionId);
      writeAudit(deps.audit, c, {
        action: "session.cancel",
        target: sessionId,
        outcome: "ok",
      });
      return c.json({
        session_id: session.sessionId,
        session_status: session.status,
        cancelled: true,
      });
    } catch (err) {
      writeAudit(deps.audit, c, {
        action: "session.cancel",
        target: sessionId,
        outcome: err instanceof RouterError ? err.code : "error",
      });
      return handleRouterError(err, c);
    }
  });

  app.post("/v1/sessions/:sessionId/compact", async (c) => {
    const sessionId = c.req.param("sessionId");
    try {
      const session = await deps.router.compact(sessionId);
      writeAudit(deps.audit, c, {
        action: "session.compact",
        target: sessionId,
        outcome: "ok",
      });
      return c.json({
        session_id: session.sessionId,
        session_status: session.status,
        compacted: true,
      });
    } catch (err) {
      writeAudit(deps.audit, c, {
        action: "session.compact",
        target: sessionId,
        outcome: err instanceof RouterError ? err.code : "error",
      });
      return handleRouterError(err, c);
    }
  });

  app.get("/v1/sessions/:sessionId/events", (c) => {
    const sessionId = c.req.param("sessionId");
    const session = deps.sessions.get(sessionId);
    if (!session) {
      return c.json({ error: "session_not_found" }, 404);
    }

    // Two modes on the same URL: snapshot or live stream.
    //   ?stream=true  — SSE, catch up on existing events then tail-follow
    //                   the JSONL until the client disconnects or the
    //                   session goes idle for ~30s.
    //   default       — one-shot JSON array of every event in order.
    if (c.req.query("stream") === "true") {
      // Resume cursor for a reconnecting client. The browser's native
      // EventSource re-sends the last `id:` frame it saw as the
      // `Last-Event-ID` request header when it auto-reconnects after a
      // dropped socket. We ALSO accept `?after=<event_id>` for clients
      // (the Node + Python SDKs) that can't set a custom header on SSE
      // requests. `Last-Event-ID` header wins if both are present —
      // matches the SSE spec's intent.
      const afterEventId =
        c.req.header("last-event-id") || c.req.query("after") || undefined;
      return streamSSE(c, async (sse) => {
        // Propagate client-disconnect through an AbortController so the
        // follow generator can bail out of its poll loop.
        const abort = new AbortController();
        sse.onAbort(() => abort.abort());

        // Track session status so we can emit synthetic status events
        // when the session transitions between idle/running/failed.
        let lastEmittedStatus = session.status;
        const emitStatusEvent = async (status: string) => {
          if (sse.aborted || sse.closed) return;
          await sse.writeSSE({
            event: `session.status_${status}`,
            data: JSON.stringify({
              session_id: sessionId,
              status,
              ts: Date.now(),
            }),
          });
        };

        // Emit the initial session status so the client knows the
        // starting state without having to query GET /v1/sessions/:id.
        await emitStatusEvent(lastEmittedStatus);

        // Track emitted approval IDs to avoid duplicates.
        const emittedApprovalIds = new Set<string>();
        const emitPendingApprovals = async () => {
          if (sse.aborted || sse.closed) return;
          for (const approval of deps.router.getPendingApprovals(sessionId)) {
            if (emittedApprovalIds.has(approval.approvalId)) continue;
            emittedApprovalIds.add(approval.approvalId);
            await sse.writeSSE({
              event: "agent.tool_confirmation_request",
              id: approval.approvalId,
              data: JSON.stringify({
                event_id: approval.approvalId,
                session_id: sessionId,
                type: "agent.tool_confirmation_request",
                content: approval.description,
                created_at: approval.arrivedAt,
                tool_name: approval.toolName,
                approval_id: approval.approvalId,
              }),
            });
          }
        };

        // Heartbeats so intermediate proxies don't idle-kill the socket.
        // Every 15s we send a dedicated "heartbeat" event type; clients
        // that don't care can ignore it via addEventListener filtering.
        // Also check for session status transitions and pending approvals.
        const heartbeat = setInterval(() => {
          if (sse.aborted || sse.closed) return;
          const current = deps.sessions.get(sessionId);
          if (current && current.status !== lastEmittedStatus) {
            lastEmittedStatus = current.status;
            emitStatusEvent(lastEmittedStatus).catch(() => {
              /* best-effort */
            });
          }
          emitPendingApprovals().catch(() => { /* best-effort */ });
          sse
            .writeSSE({
              event: "heartbeat",
              data: JSON.stringify({ ts: Date.now() }),
            })
            .catch(() => {
              /* best-effort */
            });
        }, 15_000);

        try {
          for await (const event of deps.events.follow(
            session.agentId,
            session.sessionId,
            {
              signal: abort.signal,
              isSessionRunning: () =>
                deps.sessions.get(sessionId)?.status === "running",
              afterEventId,
            },
          )) {
            if (sse.aborted || sse.closed) break;

            // Check for status change and pending approvals on every
            // yielded event (more responsive than the 15s heartbeat).
            const current = deps.sessions.get(sessionId);
            if (current && current.status !== lastEmittedStatus) {
              lastEmittedStatus = current.status;
              await emitStatusEvent(lastEmittedStatus);
            }
            await emitPendingApprovals();

            await sse.writeSSE({
              event: event.type,
              id: event.eventId,
              data: JSON.stringify(eventResponse(event)),
            });
          }

          // follow() returned — either client disconnected, session went
          // idle past the grace period, or the abort signal fired. Emit
          // a final status event if it changed since last emission.
          const finalSession = deps.sessions.get(sessionId);
          if (finalSession && finalSession.status !== lastEmittedStatus) {
            await emitStatusEvent(finalSession.status);
          }
        } finally {
          clearInterval(heartbeat);
        }
      });
    }

    const events = deps.events
      .listBySession(session.agentId, session.sessionId)
      .map(eventResponse);
    return c.json({ session_id: sessionId, events, count: events.length });
  });

  // ---------- OpenAI-compat adapter ----------

  // Thin compatibility shim over the session/event API. Lets existing
  // OpenAI SDK integrations switch to the runtime by swapping their
  // base_url. Documented behavior (see README's "OpenAI SDK compatibility"):
  //
  //   - `x-openclaw-agent-id` header is REQUIRED; there is no default agent.
  //   - Body `model` field is IGNORED; the agent template's configured
  //     model wins. For per-session model override, use native
  //     POST /v1/sessions/:id/events with the `model` field (Item 7).
  //   - `role: "system"` messages are IGNORED; use the agent template's
  //     `instructions` (systemPromptOverride) instead.
  //   - Only the trailing `role: "user"` message is read. Pi's
  //     SessionManager owns history on sticky sessions; for ephemeral
  //     sessions only the final user message defines the turn.
  //   - `stream: true` pipes the container's real SSE chunks through to
  //     the caller byte-for-byte (OpenAI-compatible ChatCompletionChunk
  //     format, terminator `[DONE]`). The run cannot be queued in this
  //     mode: a busy session returns 409 `session_busy` and the client
  //     retries. Client disconnect aborts our relay but the container's
  //     turn continues server-side — Pi's JSONL retains truth, and the
  //     session is rolled back to idle so the next event isn't blocked.
  //
  // Session resolution:
  //   - `x-openclaw-session-key` header or body `user` field → sticky
  //     session. Reuse if it exists and matches the agent; auto-create
  //     with that exact key if not. Bound to the validated regex.
  //   - Neither → ephemeral session, auto-generated id, flagged for
  //     reap-time cleanup by the idle sweeper.
  //
  // Stale-detection: because the pool queues events when a session is
  // busy, a /v1/chat/completions call on a running session may wait for
  // both the in-flight run AND subsequent queued events to drain. The
  // handler snapshots the newest agent.message id BEFORE calling runEvent
  // and verifies the post-wait message is different — otherwise we'd
  // return a stale response from an earlier turn. Guards the race flagged
  // by the advisor.
  app.post("/v1/chat/completions", async (c) => {
    const agentId = c.req.header("x-openclaw-agent-id");
    if (!agentId) {
      return c.json(
        {
          error: {
            message: "missing x-openclaw-agent-id header",
            type: "invalid_request_error",
          },
        },
        400,
      );
    }
    const agent = deps.agents.get(agentId);
    if (!agent) {
      return c.json(
        {
          error: {
            message: `agent ${agentId} not found`,
            type: "invalid_request_error",
          },
        },
        404,
      );
    }

    const rawBody = await c.req.json().catch(() => ({}));
    const parsed = OpenAIChatCompletionRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json(
        {
          error: {
            message: "invalid request body",
            type: "invalid_request_error",
            details: parsed.error.format(),
          },
        },
        400,
      );
    }
    const body = parsed.data;

    // Extract the newest user message with non-empty string content.
    // Multimodal content arrays are not supported in Item 8.
    let lastUserContent: string | undefined;
    for (let i = body.messages.length - 1; i >= 0; i--) {
      const m = body.messages[i];
      if (
        m &&
        m.role === "user" &&
        typeof m.content === "string" &&
        m.content.length > 0
      ) {
        lastUserContent = m.content;
        break;
      }
    }
    if (lastUserContent === undefined) {
      return c.json(
        {
          error: {
            message:
              "no user message with non-empty string content found in messages[]",
            type: "invalid_request_error",
          },
        },
        400,
      );
    }

    // Session resolution.
    const headerSessionKey = c.req.header("x-openclaw-session-key");
    const sessionKey = headerSessionKey ?? body.user;
    let session: Session;
    let isEphemeral = false;

    if (sessionKey !== undefined && sessionKey !== "") {
      if (!SESSION_KEY_RE.test(sessionKey)) {
        return c.json(
          {
            error: {
              message:
                "session key format invalid — expected ^[a-zA-Z0-9_-]{1,128}$",
              type: "invalid_request_error",
            },
          },
          400,
        );
      }
      const existing = deps.sessions.get(sessionKey);
      if (existing) {
        if (existing.agentId !== agentId) {
          return c.json(
            {
              error: {
                message: `session ${sessionKey} is bound to a different agent (${existing.agentId})`,
                type: "invalid_request_error",
              },
            },
            409,
          );
        }
        session = existing;
      } else {
        // Client took ownership of this key; a named session is never
        // ephemeral. If the client wants auto-cleanup they should omit
        // the key entirely and let the handler generate one.
        //
        // Item 12-14: seed remainingSubagentDepth from the agent template.
        // chat.completions is a client-facing endpoint (no parent token
        // path), so the session is always a "top-level" session that gets
        // its max delegation depth from its agent template.
        session = deps.sessions.create({
          agentId,
          sessionId: sessionKey,
          ephemeral: false,
          remainingSubagentDepth: agent.maxSubagentDepth,
        });
      }
    } else {
      session = deps.sessions.create({
        agentId,
        ephemeral: true,
        remainingSubagentDepth: agent.maxSubagentDepth,
      });
      isEphemeral = true;
    }

    // Ephemeral cleanup on any error path. Explicitly NOT called on the
    // happy path — the session + its container live on in the pool and
    // are reaped together by the idle sweeper. Best-effort throughout:
    // a cleanup failure must not mask the original error the caller
    // actually cares about.
    const cleanupEphemeralOnError = (): void => {
      if (!isEphemeral) return;
      try {
        deps.events.deleteBySession(agentId, session.sessionId);
      } catch {
        /* best-effort */
      }
      try {
        deps.sessions.delete(session.sessionId);
      } catch {
        /* best-effort */
      }
    };

    // Streaming path: relay the container's SSE chunks to the caller
    // byte-for-byte (the inner payload is already an OpenAI-compatible
    // ChatCompletionChunk with `data: [DONE]` as terminator, so the
    // client sees exactly what it'd see from the OpenAI SDK). The
    // non-streaming path below keeps the run-in-background + poll
    // shape because callers of stream:false expect a single blocking
    // JSON response.
    if (body.stream === true) {
      let handle: Awaited<ReturnType<typeof deps.router.streamEvent>>;
      try {
        handle = await deps.router.streamEvent({
          sessionId: session.sessionId,
          content: lastUserContent,
        });
      } catch (err) {
        cleanupEphemeralOnError();
        if (err instanceof RouterError) {
          const status = err.code === "session_busy" ? 409 : 500;
          return c.json({ error: { message: err.message, type: err.code } }, status);
        }
        const msg = err instanceof Error ? err.message : String(err);
        return c.json({ error: { message: msg, type: "internal_error" } }, 500);
      }

      return streamSSE(c, async (sse) => {
        let finalized = false;
        try {
          for await (const data of handle.chunks) {
            if (sse.aborted || sse.closed) break;
            await sse.writeSSE({ data });
          }
          await handle.finalize({ ok: true });
          finalized = true;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await handle.finalize({ ok: false, error: msg });
          finalized = true;
          cleanupEphemeralOnError();
          if (!sse.aborted && !sse.closed) {
            try {
              await sse.writeSSE({
                event: "error",
                data: JSON.stringify({ error: { message: msg, type: "stream_error" } }),
              });
            } catch {
              /* client gone */
            }
          }
        } finally {
          if (!finalized) {
            // Client aborted mid-stream. The container's turn continues
            // server-side; we roll up whatever made it to the JSONL and
            // flip the session idle so subsequent events aren't blocked.
            await handle.finalize({ ok: true }).catch(() => {
              /* best-effort */
            });
          }
        }
      });
    }

    // Stale-detection snapshot (non-streaming path).
    const beforeMsg = deps.events.latestAgentMessage(agentId, session.sessionId);
    const beforeEventId = beforeMsg?.eventId;

    try {
      await deps.router.runEvent({
        sessionId: session.sessionId,
        content: lastUserContent,
      });
    } catch (err) {
      cleanupEphemeralOnError();
      if (err instanceof RouterError) {
        return c.json(
          {
            error: { message: err.message, type: err.code },
          },
          500,
        );
      }
      const msg = err instanceof Error ? err.message : String(err);
      return c.json(
        {
          error: { message: msg, type: "internal_error" },
        },
        500,
      );
    }

    // Poll for completion. Item 7's queue-drain keeps status=running
    // across the whole chain so this naturally waits for queued events
    // to finish before returning.
    const pollStart = Date.now();
    let finalSession: Session | undefined;
    while (Date.now() - pollStart < CHAT_COMPLETION_TIMEOUT_MS) {
      const current = deps.sessions.get(session.sessionId);
      if (!current) {
        cleanupEphemeralOnError();
        return c.json(
          {
            error: {
              message: "session disappeared during run",
              type: "internal_error",
            },
          },
          500,
        );
      }
      if (current.status !== "running") {
        finalSession = current;
        break;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, CHAT_COMPLETION_POLL_MS),
      );
    }

    if (!finalSession) {
      cleanupEphemeralOnError();
      return c.json(
        {
          error: {
            message: `run timed out after ${CHAT_COMPLETION_TIMEOUT_MS}ms`,
            type: "timeout",
          },
        },
        504,
      );
    }

    if (finalSession.status === "failed") {
      cleanupEphemeralOnError();
      return c.json(
        {
          error: {
            message: finalSession.error ?? "session failed",
            type: "run_failed",
          },
        },
        500,
      );
    }

    // Read post-run message and verify it's different from the snapshot.
    const afterMsg = deps.events.latestAgentMessage(agentId, session.sessionId);
    if (!afterMsg || afterMsg.eventId === beforeEventId) {
      cleanupEphemeralOnError();
      return c.json(
        {
          error: {
            message: "run finished but no new agent.message was written",
            type: "internal_error",
          },
        },
        500,
      );
    }

    // Build the response. Prefer the model actually used (from the event)
    // over the agent template's configured model so any session-level
    // override surfaces in the response.
    const responseModel = afterMsg.model ?? agent.model;
    const createdUnix = Math.floor(afterMsg.createdAt / 1000);
    const responseId = `chatcmpl-${afterMsg.eventId}`;
    const usage = {
      prompt_tokens: afterMsg.tokensIn ?? 0,
      completion_tokens: afterMsg.tokensOut ?? 0,
      total_tokens: (afterMsg.tokensIn ?? 0) + (afterMsg.tokensOut ?? 0),
    };

    return c.json({
      id: responseId,
      object: "chat.completion",
      created: createdUnix,
      model: responseModel,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: afterMsg.content },
          finish_reason: "stop",
        },
      ],
      usage,
    });
  });

  // ---------- Audit log ----------

  // Filtered list of audit events. Useful for ops questions like "which
  // caller deleted agt_X last Tuesday" or "show me every session
  // created against agent Y". Auth-gated by the same bearer token as
  // the rest of the API — operators with access to mutating routes
  // can already do anything, so there's no point putting a second
  // authentication surface in front of read-only audit.
  app.get("/v1/audit", (c) => {
    const sinceStr = c.req.query("since");
    const untilStr = c.req.query("until");
    const limitStr = c.req.query("limit");
    const action = c.req.query("action") ?? undefined;
    const target = c.req.query("target") ?? undefined;
    const since = sinceStr ? Number.parseInt(sinceStr, 10) : undefined;
    const until = untilStr ? Number.parseInt(untilStr, 10) : undefined;
    const limit = limitStr ? Number.parseInt(limitStr, 10) : undefined;
    if (
      (since !== undefined && Number.isNaN(since)) ||
      (until !== undefined && Number.isNaN(until)) ||
      (limit !== undefined && Number.isNaN(limit))
    ) {
      return c.json(
        {
          error: "invalid_request",
          message: "since, until, and limit must be integers",
        },
        400,
      );
    }
    const events = deps.audit.list({ since, until, action, target, limit });
    return c.json({
      events: events.map((e) => ({
        id: e.id,
        ts: e.ts,
        request_id: e.requestId,
        actor: e.actor,
        action: e.action,
        target: e.target,
        outcome: e.outcome,
        metadata: e.metadata,
      })),
      count: events.length,
    });
  });

  // ---------- Backwards-compat /run adapter ----------

  // Retained so that OpenAI-style one-shot callers keep working. Maps
  // { task, sessionId? } onto createSession + runEvent.
  app.post("/v1/agents/:agentId/run", async (c) => {
    const agentId = c.req.param("agentId");
    const body = await c.req.json().catch(() => ({}));
    const parsed = RunAgentRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "invalid_request", details: parsed.error.format() }, 400);
    }
    try {
      let session: Session;
      if (parsed.data.sessionId) {
        const existing = deps.sessions.get(parsed.data.sessionId);
        if (!existing) {
          return c.json({ error: "session_not_found" }, 404);
        }
        if (existing.agentId !== agentId) {
          return c.json({ error: "session_agent_mismatch" }, 400);
        }
        session = existing;
      } else {
        session = deps.router.createSession(agentId);
      }
      const result = await deps.router.runEvent({
        sessionId: session.sessionId,
        content: parsed.data.task,
      });
      return c.json({
        session_id: session.sessionId,
        agent_id: agentId,
        status: result.session.status,
        started_at: result.session.lastEventAt ?? result.session.createdAt,
      });
    } catch (err) {
      return handleRouterError(err, c);
    }
  });

  return app;
}

export type ListenOptions = {
  port: number;
};

export async function startServer(deps: ServerDeps, opts: ListenOptions): Promise<void> {
  const app = buildApp(deps);
  serve({ fetch: app.fetch, port: opts.port });
  log.info({ port: opts.port, url: `http://0.0.0.0:${opts.port}` }, "orchestrator listening");
}
