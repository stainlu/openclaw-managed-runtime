import { serve } from "@hono/node-server";
import { type Context, Hono } from "hono";
import type { ContainerRuntime } from "../runtime/container.js";
import type { AgentStore, EventStore, SessionStore } from "../store/types.js";
import { AgentRouter, RouterError } from "./router.js";
import {
  CreateAgentRequestSchema,
  CreateSessionRequestSchema,
  PostEventRequestSchema,
  RunAgentRequestSchema,
  type AgentConfig,
  type Event,
  type Session,
} from "./types.js";

export type ServerDeps = {
  agents: AgentStore;
  sessions: SessionStore;
  events: EventStore;
  router: AgentRouter;
  runtime: ContainerRuntime;
  /** Semver from package.json, surfaced on GET /. */
  version: string;
};

function agentResponse(agent: AgentConfig) {
  return {
    agent_id: agent.agentId,
    model: agent.model,
    tools: agent.tools,
    instructions: agent.instructions,
    name: agent.name,
    created_at: agent.createdAt,
  };
}

// Session response shape. `output` is a computed convenience: the content of
// the most recent agent.message event in the session, or null if none yet.
// Clients that need the full event history read GET /v1/sessions/:id/events.
function sessionResponse(session: Session, events: EventStore) {
  const latestAgent = events.latestAgentMessage(session.sessionId);
  return {
    session_id: session.sessionId,
    agent_id: session.agentId,
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
  };
}

function handleRouterError(err: unknown, c: Context): Response {
  if (err instanceof RouterError) {
    if (err.code === "agent_not_found" || err.code === "session_not_found") {
      return c.json({ error: err.code, message: err.message }, 404);
    }
    if (err.code === "session_busy") {
      return c.json({ error: err.code, message: err.message }, 409);
    }
    return c.json({ error: err.code, message: err.message }, 500);
  }
  const msg = err instanceof Error ? err.message : String(err);
  return c.json({ error: "internal", message: msg }, 500);
}

export function buildApp(deps: ServerDeps): Hono {
  const app = new Hono();

  // Self-documenting root. A developer landing on the orchestrator gets the
  // full endpoint map without needing to read docs first.
  app.get("/", (c) =>
    c.json({
      name: "OpenClaw Managed Runtime",
      description: "The open alternative to Claude Managed Agents.",
      version: deps.version,
      docs: "https://github.com/stainlu/openclaw-managed-runtime",
      endpoints: {
        agents: {
          create: "POST /v1/agents",
          list: "GET /v1/agents",
          get: "GET /v1/agents/:agentId",
          delete: "DELETE /v1/agents/:agentId",
          run: "POST /v1/agents/:agentId/run",
        },
        sessions: {
          create: "POST /v1/sessions",
          list: "GET /v1/sessions",
          get: "GET /v1/sessions/:sessionId",
          delete: "DELETE /v1/sessions/:sessionId",
          post_event: "POST /v1/sessions/:sessionId/events",
          list_events: "GET /v1/sessions/:sessionId/events",
        },
        health: {
          liveness: "GET /healthz",
        },
      },
    }),
  );

  app.get("/healthz", (c) => c.json({ ok: true, version: deps.version }));

  // ---------- Agents (reusable templates) ----------

  app.post("/v1/agents", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = CreateAgentRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "invalid_request", details: parsed.error.format() }, 400);
    }
    const agent = deps.agents.create(parsed.data);
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
    if (!existed) {
      return c.json({ error: "agent_not_found" }, 404);
    }
    return c.json({ deleted: true });
  });

  // ---------- Sessions (long-lived, session-centric API) ----------

  app.post("/v1/sessions", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = CreateSessionRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "invalid_request", details: parsed.error.format() }, 400);
    }
    try {
      const session = deps.router.createSession(parsed.data.agentId);
      return c.json(sessionResponse(session, deps.events));
    } catch (err) {
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
    const existed = deps.sessions.delete(sessionId);
    if (!existed) {
      return c.json({ error: "session_not_found" }, 404);
    }
    deps.events.deleteBySession(sessionId);
    return c.json({ deleted: true });
  });

  // ---------- Events (the interaction primitive) ----------

  app.post("/v1/sessions/:sessionId/events", async (c) => {
    const sessionId = c.req.param("sessionId");
    const body = await c.req.json().catch(() => ({}));
    const parsed = PostEventRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "invalid_request", details: parsed.error.format() }, 400);
    }
    try {
      const { session, event } = deps.router.runEvent({
        sessionId,
        content: parsed.data.content,
      });
      return c.json({
        ...eventResponse(event),
        session_status: session.status,
      });
    } catch (err) {
      return handleRouterError(err, c);
    }
  });

  app.get("/v1/sessions/:sessionId/events", (c) => {
    const sessionId = c.req.param("sessionId");
    const session = deps.sessions.get(sessionId);
    if (!session) {
      return c.json({ error: "session_not_found" }, 404);
    }
    const events = deps.events.listBySession(sessionId).map(eventResponse);
    return c.json({ session_id: sessionId, events, count: events.length });
  });

  // ---------- Backwards-compat /run adapter ----------

  // Retained so that OpenAI-style one-shot callers keep working after the
  // session-centric rewrite. Maps { task, sessionId? } onto the session-centric
  // primitives: resolve-or-create a session, then post the task as a single
  // user.message event.
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
      const { event } = deps.router.runEvent({
        sessionId: session.sessionId,
        content: parsed.data.task,
      });
      return c.json({
        session_id: session.sessionId,
        agent_id: agentId,
        status: "running",
        started_at: event.createdAt,
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
  console.log(`[orchestrator] listening on http://0.0.0.0:${opts.port}`);
}
