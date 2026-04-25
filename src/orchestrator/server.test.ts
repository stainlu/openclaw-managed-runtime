import { describe, expect, it } from "vitest";

import { ParentTokenMinter } from "../runtime/parent-token.js";
import { InMemoryStore } from "../store/memory.js";
import { RouterError } from "./router.js";
import { buildApp, type ServerDeps } from "./server.js";
import { clearZenMuxCatalogCache } from "./zenmux-pricing.js";
import type { Event, Session } from "./types.js";

function makeApp(opts: {
  passthroughEnv?: Record<string, string>;
  routerOverrides?: Partial<ServerDeps["router"]>;
} = {}) {
  const store = new InMemoryStore();
  const eventsBySession = new Map<string, Event[]>();
  const routerCalls = {
    warmForAgent: [] as string[],
    dropWarmForAgent: [] as string[],
    disposeSessionRuntime: [] as string[],
  };
  let eventCounter = 0;

  function appendEvent(event: Event): void {
    const existing = eventsBySession.get(event.sessionId) ?? [];
    existing.push(event);
    eventsBySession.set(event.sessionId, existing);
  }

  function latestAgentMessageFor(sessionId: string): Event | undefined {
    const existing = eventsBySession.get(sessionId) ?? [];
    for (let i = existing.length - 1; i >= 0; i--) {
      const event = existing[i];
      if (event?.type === "agent.message") return event;
    }
    return undefined;
  }

  function latestAgentOutcomeFor(sessionId: string): Event | undefined {
    const existing = eventsBySession.get(sessionId) ?? [];
    for (let i = existing.length - 1; i >= 0; i--) {
      const event = existing[i];
      if (!event) continue;
      if (event.type === "agent.message" || event.type === "agent.tool_result") {
        return event;
      }
    }
    return undefined;
  }

  const events = {
    latestAgentMessage(_agentId: string, sessionId: string) {
      return latestAgentMessageFor(sessionId);
    },
    latestAgentOutcome(_agentId: string, sessionId: string) {
      return latestAgentOutcomeFor(sessionId);
    },
    listBySession(_agentId: string, sessionId: string) {
      return [...(eventsBySession.get(sessionId) ?? [])];
    },
    deleteBySession(_agentId: string, sessionId: string) {
      eventsBySession.delete(sessionId);
    },
    countUserTurns(_agentId: string, sessionId: string) {
      return (eventsBySession.get(sessionId) ?? []).filter((event) => event.type === "user.message").length;
    },
    statJsonl() {
      return undefined;
    },
    async *follow() {
      return;
    },
  };

  const routerBase = {
    createSession(
      agentId: string,
      opts?: {
        environmentId?: string;
        remainingSubagentDepth?: number;
        vaultId?: string;
        parentSessionId?: string;
        userId?: string;
      },
    ) {
      return store.sessions.create({
        agentId,
        environmentId: opts?.environmentId,
        remainingSubagentDepth: opts?.remainingSubagentDepth,
        vaultId: opts?.vaultId,
        parentSessionId: opts?.parentSessionId,
        userId: opts?.userId,
      });
    },
    async warmSession() {
      return;
    },
    async warmForAgent(agentId: string) {
      routerCalls.warmForAgent.push(agentId);
      return;
    },
    async dropWarmForAgent(agentId: string) {
      routerCalls.dropWarmForAgent.push(agentId);
      return;
    },
    async disposeSessionRuntime(sessionId: string) {
      routerCalls.disposeSessionRuntime.push(sessionId);
      return;
    },
    async runEvent(args: { sessionId: string; content: string }) {
      const started = store.sessions.beginRun(args.sessionId);
      if (!started) {
        throw new RouterError("session_not_found", `session ${args.sessionId} does not exist`);
      }
      store.sessions.markRunning(args.sessionId);
      const now = Date.now();
      eventCounter += 1;
      appendEvent({
        eventId: `evt_user_${args.sessionId}_${eventCounter}`,
        sessionId: args.sessionId,
        type: "user.message",
        content: args.content,
        createdAt: now,
      });
      appendEvent({
        eventId: `evt_agent_${args.sessionId}_${eventCounter}`,
        sessionId: args.sessionId,
        type: "agent.message",
        content: `reply:${args.content}`,
        createdAt: now,
        tokensIn: 1,
        tokensOut: 1,
        costUsd: 0.01,
        model: "test-model",
      });
      const session = store.sessions.endRunSuccess(args.sessionId, {
        tokensIn: 1,
        tokensOut: 1,
        costUsd: 0.01,
      });
      if (!session) {
        throw new RouterError("session_not_found", `session ${args.sessionId} disappeared`);
      }
      return { session, queued: false };
    },
    async streamEvent() {
      throw new Error("streamEvent not implemented in tests");
    },
    async cancel(sessionId: string) {
      const session = store.sessions.endRunCancelled(sessionId);
      if (!session) {
        throw new RouterError("session_not_found", `session ${sessionId} does not exist`);
      }
      return session;
    },
    async logs() {
      return "";
    },
    async compact(sessionId: string) {
      const session = store.sessions.get(sessionId);
      if (!session) {
        throw new RouterError("session_not_found", `session ${sessionId} does not exist`);
      }
      return session;
    },
    getPendingApprovals() {
      return [];
    },
    async confirmTool() {
      return;
    },
    async listFiles() {
      return [];
    },
    async readFile() {
      return Buffer.alloc(0);
    },
    async writeFile() {
      return { path: "", size: 0 };
    },
    async deleteFile() {
      return;
    },
  };
  const router = {
    ...routerBase,
    ...(opts.routerOverrides ?? {}),
  };

  const deps: ServerDeps = {
    agents: store.agents,
    environments: store.environments,
    sessions: store.sessions,
    events: events as ServerDeps["events"],
    audit: store.audit,
    vaults: store.vaults,
    router: router as ServerDeps["router"],
    apiToken: "admin-secret",
    users: store.users,
    tokenMinter: new ParentTokenMinter(),
    version: "test",
    sessionContainers: store.sessionContainers,
    startTs: Date.now(),
    maxWarmContainers: 0,
    maxActiveContainers: 0,
    passthroughEnv: opts.passthroughEnv,
  };

  return {
    app: buildApp(deps),
    store,
    routerCalls,
    eventsBySession,
    appendEvent,
  };
}

function createAgent(store: InMemoryStore) {
  return store.agents.create({
    model: "moonshot/kimi-k2.5",
    tools: [],
    instructions: "",
    permissionPolicy: { type: "always_allow" },
    callableAgents: [],
    maxSubagentDepth: 0,
  });
}

async function req(
  app: ReturnType<typeof buildApp>,
  path: string,
  opts: {
    method?: string;
    token?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res = await app.request(path, {
    method: opts.method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : text;
  } catch {
    // keep raw text
  }
  return { status: res.status, body };
}

describe("model catalog API", () => {
  it("serves safe fallback examples when ZenMux is not configured", async () => {
    const { app } = makeApp();

    const res = await req(app, "/v1/models", { token: "admin-secret" });
    const body = res.body as {
      source?: string;
      count?: number;
      models?: Array<{ id: string; provider: string }>;
    };

    expect(res.status).toBe(200);
    expect(body.source).toBe("fallback");
    expect(body.count).toBe(18);
    expect(body.models?.map((m) => m.id)).toEqual([
      "deepseek/deepseek-v4-pro",
      "deepseek/deepseek-v4-flash",
      "openai/gpt-5.5",
      "openai/gpt-5.4",
      "anthropic/claude-opus-4.7",
      "anthropic/claude-opus-4.6",
      "google/gemini-3.1-pro-preview",
      "google/gemini-3.1-flash-lite-preview",
      "qwen/qwen3.6-plus",
      "qwen/qwen3.5-flash",
      "z-ai/glm-5.1",
      "minimax/minimax-m2.7",
      "minimax/minimax-m2.7-highspeed",
      "moonshotai/kimi-k2.6",
      "stepfun/step-3.5-flash",
      "tencent/hy3-preview",
      "xiaomi/mimo-v2.5-pro",
      "mistralai/mistral-large-2512",
    ]);
  });

  it("serves only the curated ZenMux model catalog when configured", async () => {
    clearZenMuxCatalogCache();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "https://zenmux.ai/api/v1/models") {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "anthropic/claude-opus-4.7",
                name: "Claude Opus Live",
                context_length: 200000,
                input_modalities: ["text", "image"],
              },
              {
                id: "openai/gpt-5.4",
                provider: "openai",
              },
              {
                id: "deepseek/deepseek-v4-flash",
                provider: "deepseek",
              },
              { id: "moonshotai/kimi-k2.6", provider: "moonshotai" },
              { id: "anthropic/claude-sonnet-old" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    try {
      const { app } = makeApp({
        passthroughEnv: { ZENMUX_API_KEY: "sk-test" },
      });

      const res = await req(app, "/v1/models", { token: "admin-secret" });
      const body = res.body as {
        source?: string;
        count?: number;
        models?: Array<{
          id: string;
          provider: string;
          name?: string;
          context_length?: number;
          input_modalities?: string[];
        }>;
      };

      expect(res.status).toBe(200);
      expect(body.source).toBe("zenmux");
      expect(body.count).toBe(4);
      expect(body.models).toEqual([
        {
          id: "deepseek/deepseek-v4-flash",
          provider: "deepseek",
          name: "DeepSeek V4 Flash",
        },
        {
          id: "openai/gpt-5.4",
          provider: "openai",
          name: "GPT-5.4",
        },
        {
          id: "anthropic/claude-opus-4.7",
          provider: "anthropic",
          name: "Claude Opus Live",
          context_length: 200000,
          input_modalities: ["text", "image"],
        },
        {
          id: "moonshotai/kimi-k2.6",
          provider: "moonshotai",
          name: "Kimi K2.6",
        },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
      clearZenMuxCatalogCache();
    }
  });

  it("canonicalizes legacy ZenMux model aliases when creating agents", async () => {
    clearZenMuxCatalogCache();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "https://zenmux.ai/api/v1/models") {
        return new Response(
          JSON.stringify({
            data: [
              { id: "anthropic/claude-opus-4.7" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    try {
      const { app } = makeApp({
        passthroughEnv: { ZENMUX_API_KEY: "sk-test" },
      });

      const res = await req(app, "/v1/agents", {
        method: "POST",
        token: "admin-secret",
        body: {
          model: "anthropic/claude-opus-4-7",
          tools: [],
          instructions: "",
          permissionPolicy: { type: "always_allow" },
        },
      });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        model: "anthropic/claude-opus-4.7",
      });
    } finally {
      globalThis.fetch = originalFetch;
      clearZenMuxCatalogCache();
    }
  });

  it("rejects invalid ZenMux models when creating agents", async () => {
    clearZenMuxCatalogCache();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "https://zenmux.ai/api/v1/models") {
        return new Response(
          JSON.stringify({
            data: [
              { id: "anthropic/claude-opus-4.7" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    try {
      const { app, store } = makeApp({
        passthroughEnv: { ZENMUX_API_KEY: "sk-test" },
      });

      const res = await req(app, "/v1/agents", {
        method: "POST",
        token: "admin-secret",
        body: {
          model: "anthropic/does-not-exist",
          tools: [],
          instructions: "",
          permissionPolicy: { type: "always_allow" },
        },
      });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        error: "invalid_model",
        model: "anthropic/does-not-exist",
      });
      expect(store.agents.list()).toHaveLength(0);
    } finally {
      globalThis.fetch = originalFetch;
      clearZenMuxCatalogCache();
    }
  });
});

describe("session ownership in the HTTP API", () => {
  it("deduplicates POST /events when Idempotency-Key repeats", async () => {
    let calls = 0;
    let releaseFirst: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const { app, store } = makeApp({
      routerOverrides: {
        async runEvent(args: { sessionId: string }) {
          calls += 1;
          if (calls === 1) {
            await firstStarted;
          }
          const session = store.sessions.get(args.sessionId);
          if (!session) {
            throw new RouterError("session_not_found", `session ${args.sessionId} does not exist`);
          }
          return { session, queued: false };
        },
      } as Partial<ServerDeps["router"]>,
    });
    const agent = createAgent(store);
    const session = store.sessions.create({
      agentId: agent.agentId,
      userId: null,
    });

    const headers = { "Idempotency-Key": "evt_same_turn" };
    const p1 = req(app, `/v1/sessions/${session.sessionId}/events`, {
      method: "POST",
      token: "admin-secret",
      headers,
      body: { type: "user.message", content: "hi" },
    });
    const p2 = req(app, `/v1/sessions/${session.sessionId}/events`, {
      method: "POST",
      token: "admin-secret",
      headers,
      body: { type: "user.message", content: "hi" },
    });

    releaseFirst?.();
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r1.body).toEqual(r2.body);
    expect(calls).toBe(1);

    const r3 = await req(app, `/v1/sessions/${session.sessionId}/events`, {
      method: "POST",
      token: "admin-secret",
      headers,
      body: { type: "user.message", content: "hi" },
    });
    expect(r3.status).toBe(200);
    expect(r3.body).toEqual(r1.body);
    expect(calls).toBe(1);

    const r4 = await req(app, `/v1/sessions/${session.sessionId}/events`, {
      method: "POST",
      token: "admin-secret",
      headers: { "Idempotency-Key": "evt_distinct_turn" },
      body: { type: "user.message", content: "hi" },
    });
    expect(r4.status).toBe(200);
    expect(calls).toBe(2);
  });

  it("hides per-session reads and writes from other user tokens", async () => {
    const { app, store } = makeApp();
    const agent = createAgent(store);
    const alice = store.users.create({ tier: "github" });
    const bob = store.users.create({ tier: "github" });
    const session = store.sessions.create({
      agentId: agent.agentId,
      userId: alice.userId,
    });

    expect((await req(app, `/v1/sessions/${session.sessionId}`, { token: alice.apiToken })).status).toBe(200);
    expect((await req(app, `/v1/sessions/${session.sessionId}`, { token: bob.apiToken })).status).toBe(404);
    expect(
      (
        await req(app, `/v1/sessions/${session.sessionId}/events`, {
          method: "POST",
          token: bob.apiToken,
          body: { type: "user.message", content: "hi" },
        })
      ).status,
    ).toBe(404);
  });

  it("keeps admin-token access global", async () => {
    const { app, store } = makeApp();
    const agent = createAgent(store);
    const alice = store.users.create({ tier: "github" });
    const session = store.sessions.create({
      agentId: agent.agentId,
      userId: alice.userId,
    });

    expect((await req(app, `/v1/sessions/${session.sessionId}`, { token: "admin-secret" })).status).toBe(200);
  });

  it("binds legacy /run sessions to the authenticated user", async () => {
    const { app, store } = makeApp();
    const agent = createAgent(store);
    const alice = store.users.create({ tier: "github" });

    const res = await req(app, `/v1/agents/${agent.agentId}/run`, {
      method: "POST",
      token: alice.apiToken,
      body: { task: "hello" },
    });

    expect(res.status).toBe(200);
    const sessionId = (res.body as { session_id: string }).session_id;
    expect(store.sessions.get(sessionId)?.userId).toBe(alice.userId);
  });

  it("falls back to transcript usage for session reads when stored totals are sparse", async () => {
    const { app, store, appendEvent } = makeApp();
    const agent = createAgent(store);
    const session = store.sessions.create({
      agentId: agent.agentId,
      userId: null,
    });
    const now = Date.now();
    appendEvent({
      eventId: `evt_${session.sessionId}_${now}`,
      sessionId: session.sessionId,
      type: "agent.message",
      content: "reply:hi",
      createdAt: now,
      tokensIn: 321,
      tokensOut: 45,
      costUsd: 0.42,
      model: "zenmux/openai/gpt-5.4",
    });

    const res = await req(app, `/v1/sessions/${session.sessionId}`, {
      token: "admin-secret",
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      session_id: session.sessionId,
      tokens: { input: 321, output: 45 },
      cost_usd: 0.42,
      output: "reply:hi",
    });
  });

  it("estimates ZenMux cost for session reads when transcript cost is missing", async () => {
    clearZenMuxCatalogCache();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "https://zenmux.ai/api/v1/models") {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "openai/gpt-5.4",
                pricings: {
                  prompt: [{ value: 2.5, unit: "perMTokens", currency: "USD" }],
                  completion: [{ value: 10, unit: "perMTokens", currency: "USD" }],
                  request: [{ value: 0.01, unit: "perCount", currency: "USD" }],
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;
    try {
      const { app, store, appendEvent } = makeApp({
        passthroughEnv: { ZENMUX_API_KEY: "sk-test" },
      });
      const agent = store.agents.create({
        model: "openai/gpt-5.4",
        tools: [],
        instructions: "",
        permissionPolicy: { type: "always_allow" },
        callableAgents: [],
        maxSubagentDepth: 0,
      });
      const session = store.sessions.create({
        agentId: agent.agentId,
        userId: null,
      });
      const now = Date.now();
      appendEvent({
        eventId: `evt_${session.sessionId}_${now}`,
        sessionId: session.sessionId,
        type: "agent.message",
        content: "reply:hi",
        createdAt: now,
        tokensIn: 321,
        tokensOut: 45,
        model: "zenmux/openai/gpt-5.4",
      });

      const res = await req(app, `/v1/sessions/${session.sessionId}`, {
        token: "admin-secret",
      });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        session_id: session.sessionId,
        tokens: { input: 321, output: 45 },
        cost_usd: 0.0112525,
      });
    } finally {
      globalThis.fetch = originalFetch;
      clearZenMuxCatalogCache();
    }
  });

  it("does not let another user reuse a named chat-completions session key", async () => {
    const { app, store } = makeApp();
    const agent = createAgent(store);
    const alice = store.users.create({ tier: "github" });
    const bob = store.users.create({ tier: "github" });

    const first = await req(app, "/v1/chat/completions", {
      method: "POST",
      token: alice.apiToken,
      headers: { "x-openclaw-agent-id": agent.agentId },
      body: {
        model: agent.agentId,
        user: "shared-key",
        messages: [{ role: "user", content: "hello" }],
      },
    });
    expect(first.status).toBe(200);
    expect(store.sessions.get("shared-key")?.userId).toBe(alice.userId);

    const second = await req(app, "/v1/chat/completions", {
      method: "POST",
      token: bob.apiToken,
      headers: { "x-openclaw-agent-id": agent.agentId },
      body: {
        model: agent.agentId,
        user: "shared-key",
        messages: [{ role: "user", content: "hello again" }],
      },
    });
    expect(second.status).toBe(404);
  });

  it("rejects invalid named chat-completions session keys", async () => {
    const { app, store } = makeApp();
    const agent = createAgent(store);

    const res = await req(app, "/v1/chat/completions", {
      method: "POST",
      token: "admin-secret",
      headers: { "x-openclaw-agent-id": agent.agentId },
      body: {
        model: agent.agentId,
        user: "bad/key",
        messages: [{ role: "user", content: "hello" }],
      },
    });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error: {
        type: "invalid_request_error",
      },
    });
  });

  it("rejects reusing a named session key with a different agent", async () => {
    const { app, store } = makeApp();
    const firstAgent = createAgent(store);
    const secondAgent = createAgent(store);

    const first = await req(app, "/v1/chat/completions", {
      method: "POST",
      token: "admin-secret",
      headers: { "x-openclaw-agent-id": firstAgent.agentId },
      body: {
        model: firstAgent.agentId,
        user: "shared-session",
        messages: [{ role: "user", content: "hello" }],
      },
    });
    expect(first.status).toBe(200);

    const second = await req(app, "/v1/chat/completions", {
      method: "POST",
      token: "admin-secret",
      headers: { "x-openclaw-agent-id": secondAgent.agentId },
      body: {
        model: secondAgent.agentId,
        user: "shared-session",
        messages: [{ role: "user", content: "hello again" }],
      },
    });

    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({
      error: {
        type: "invalid_request_error",
      },
    });
  });

  it("streams container attach telemetry for a running session", async () => {
    const { app, store } = makeApp();
    const agent = createAgent(store);
    const session = store.sessions.create({
      agentId: agent.agentId,
      userId: null,
    });
    store.sessions.beginRun(session.sessionId);
    store.sessions.markRunning(session.sessionId);
    store.sessionContainers.put({
      sessionId: session.sessionId,
      agentId: agent.agentId,
      containerId: "ctr_live_123",
      containerName: "openclaw-agt-live123",
      containerPort: 18789,
      gatewayToken: "gw_test",
      claimedAt: 1_777_000_000_000,
      configSignature: "sig_test",
      spawnedAt: 1_777_000_000_000,
      bootMs: 4321,
      poolSource: "cold",
    });

    const res = await app.request(
      `/v1/sessions/${session.sessionId}/events?stream=true`,
      {
        headers: {
          authorization: "Bearer admin-secret",
        },
      },
    );

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("event: session.status_running");
    expect(text).toContain("event: session.container_attached");
    expect(text).toContain('"container_id":"ctr_live_123"');
    expect(text).toContain('"container_name":"openclaw-agt-live123"');
    expect(text).toContain('"pool_source":"cold"');
    expect(text).toContain('"boot_ms":4321');
  });

  it("rebuilds the warm template container after an agent update", async () => {
    const { app, store, routerCalls } = makeApp();
    const agent = createAgent(store);

    const res = await req(app, `/v1/agents/${agent.agentId}`, {
      method: "PATCH",
      token: "admin-secret",
      body: {
        version: agent.version,
        model: "openai/gpt-5.4",
      },
    });

    expect(res.status).toBe(200);
    expect(routerCalls.dropWarmForAgent).toEqual([agent.agentId]);
    expect(routerCalls.warmForAgent).toContain(agent.agentId);
    expect(store.agents.get(agent.agentId)?.model).toBe("openai/gpt-5.4");
  });

  it("evicts live runtime state before deleting a session", async () => {
    const { app, store, routerCalls } = makeApp();
    const agent = createAgent(store);
    const session = store.sessions.create({
      agentId: agent.agentId,
      userId: null,
    });

    const res = await req(app, `/v1/sessions/${session.sessionId}`, {
      method: "DELETE",
      token: "admin-secret",
    });

    expect(res.status).toBe(200);
    expect(routerCalls.disposeSessionRuntime).toEqual([session.sessionId]);
    expect(store.sessions.get(session.sessionId)).toBeUndefined();
  });

  it("reuses a named chat-completions session across multiple turns for the same caller", async () => {
    const { app, store, eventsBySession } = makeApp();
    const agent = createAgent(store);
    const alice = store.users.create({ tier: "github" });

    const first = await req(app, "/v1/chat/completions", {
      method: "POST",
      token: alice.apiToken,
      headers: { "x-openclaw-agent-id": agent.agentId },
      body: {
        model: agent.agentId,
        user: "sticky-turns",
        messages: [{ role: "user", content: "hello" }],
      },
    });
    expect(first.status).toBe(200);

    const second = await req(app, "/v1/chat/completions", {
      method: "POST",
      token: alice.apiToken,
      headers: { "x-openclaw-agent-id": agent.agentId },
      body: {
        model: agent.agentId,
        user: "sticky-turns",
        messages: [{ role: "user", content: "deploy it" }],
      },
    });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({
      model: "test-model",
      choices: [{ message: { role: "assistant", content: "reply:deploy it" } }],
      usage: {
        prompt_tokens: 1,
        completion_tokens: 1,
        total_tokens: 2,
      },
    });

    const session = store.sessions.get("sticky-turns");
    expect(session?.userId).toBe(alice.userId);
    expect(eventsBySession.get("sticky-turns")?.map((event) => event.type)).toEqual([
      "user.message",
      "agent.message",
      "user.message",
      "agent.message",
    ]);
  });

  it("accepts a tool-only chat-completions turn without a final agent.message", async () => {
    const { app, store, appendEvent } = makeApp({
      routerOverrides: {
        async runEvent(args: { sessionId: string; content: string }) {
          const started = store.sessions.beginRun(args.sessionId);
          if (!started) {
            throw new RouterError("session_not_found", `session ${args.sessionId} does not exist`);
          }
          store.sessions.markRunning(args.sessionId);
          const now = Date.now();
          appendEvent({
            eventId: `evt_user_${args.sessionId}_${now}`,
            sessionId: args.sessionId,
            type: "user.message",
            content: args.content,
            createdAt: now,
          });
          appendEvent({
            eventId: `evt_tool_result_${args.sessionId}_${now}`,
            sessionId: args.sessionId,
            type: "agent.tool_result",
            content: "Fri Apr 24 17:58:01 UTC 2026",
            createdAt: now + 1,
            toolName: "exec",
            toolCallId: "call-date",
          });
          const session = store.sessions.endRunSuccess(args.sessionId, {
            tokensIn: 11,
            tokensOut: 7,
            costUsd: 0.03,
          });
          if (!session) {
            throw new RouterError("session_not_found", `session ${args.sessionId} disappeared`);
          }
          return { session, queued: false };
        },
      } as Partial<ServerDeps["router"]>,
    });
    const agent = createAgent(store);

    const res = await req(app, "/v1/chat/completions", {
      method: "POST",
      token: "admin-secret",
      headers: { "x-openclaw-agent-id": agent.agentId },
      body: {
        model: agent.agentId,
        user: "tool-only-turn",
        messages: [{ role: "user", content: "what time is it?" }],
      },
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      model: agent.model,
      choices: [{ message: { role: "assistant", content: "" } }],
      usage: {
        prompt_tokens: 11,
        completion_tokens: 7,
        total_tokens: 18,
      },
    });
  });

  it("returns 409 for busy non-streaming chat-completions instead of queueing", async () => {
    let sawRejectIfBusy = false;
    const { app, store } = makeApp({
      routerOverrides: {
        async runEvent(args: { rejectIfBusy?: boolean }) {
          sawRejectIfBusy = args.rejectIfBusy === true;
          throw new RouterError("session_busy", "session sticky-busy is busy");
        },
      } as Partial<ServerDeps["router"]>,
    });
    const agent = createAgent(store);
    store.sessions.create({
      agentId: agent.agentId,
      sessionId: "sticky-busy",
      userId: null,
    });

    const res = await req(app, "/v1/chat/completions", {
      method: "POST",
      token: "admin-secret",
      headers: { "x-openclaw-agent-id": agent.agentId },
      body: {
        model: agent.agentId,
        user: "sticky-busy",
        messages: [{ role: "user", content: "hello" }],
      },
    });

    expect(res.status).toBe(409);
    expect(sawRejectIfBusy).toBe(true);
    expect(res.body).toMatchObject({
      error: { type: "session_busy" },
    });
  });

  it("cleans up ephemeral chat-completions sessions on run failure", async () => {
    const { app, store, eventsBySession } = makeApp({
      routerOverrides: {
        async runEvent(args: { sessionId: string; content: string }) {
          store.sessions.beginRun(args.sessionId);
          store.sessions.markRunning(args.sessionId);
          throw new RouterError("chat_completions_failed", "simulated upstream failure");
        },
      } as Partial<ServerDeps["router"]>,
    });
    const agent = createAgent(store);

    const res = await req(app, "/v1/chat/completions", {
      method: "POST",
      token: "admin-secret",
      headers: { "x-openclaw-agent-id": agent.agentId },
      body: {
        model: agent.agentId,
        messages: [{ role: "user", content: "hello" }],
      },
    });

    expect(res.status).toBe(500);
    expect(store.sessions.list()).toHaveLength(0);
    expect(eventsBySession.size).toBe(0);
  });

  it("derives turns and latest output from the full transcript in session listings", async () => {
    const { app, store, appendEvent } = makeApp();
    const agent = createAgent(store);
    const session = store.sessions.create({
      agentId: agent.agentId,
      userId: null,
    });
    appendEvent({
      eventId: "evt_user_1",
      sessionId: session.sessionId,
      type: "user.message",
      content: "first",
      createdAt: 1,
    });
    appendEvent({
      eventId: "evt_agent_1",
      sessionId: session.sessionId,
      type: "agent.message",
      content: "reply:first",
      createdAt: 2,
      tokensIn: 10,
      tokensOut: 5,
      costUsd: 0.01,
      model: "zenmux/openai/gpt-5.4",
    });
    appendEvent({
      eventId: "evt_user_2",
      sessionId: session.sessionId,
      type: "user.message",
      content: "second",
      createdAt: 3,
    });
    appendEvent({
      eventId: "evt_agent_2",
      sessionId: session.sessionId,
      type: "agent.message",
      content: "reply:second",
      createdAt: 4,
      tokensIn: 12,
      tokensOut: 6,
      costUsd: 0.02,
      model: "zenmux/openai/gpt-5.4",
    });

    const res = await req(app, "/v1/sessions", {
      token: "admin-secret",
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      count: 1,
      sessions: [
        {
          session_id: session.sessionId,
          output: "reply:second",
          tokens: { input: 12, output: 6 },
          cost_usd: 0.02,
        },
      ],
    });
  });
});
