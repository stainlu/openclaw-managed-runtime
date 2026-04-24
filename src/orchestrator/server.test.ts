import { describe, expect, it } from "vitest";

import { ParentTokenMinter } from "../runtime/parent-token.js";
import { InMemoryStore } from "../store/memory.js";
import { RouterError } from "./router.js";
import { buildApp, type ServerDeps } from "./server.js";
import { clearZenMuxCatalogCache } from "./zenmux-pricing.js";
import type { Event, Session } from "./types.js";

function makeApp(opts: { passthroughEnv?: Record<string, string> } = {}) {
  const store = new InMemoryStore();
  const latestBySession = new Map<string, Event>();
  const routerCalls = {
    warmForAgent: [] as string[],
    dropWarmForAgent: [] as string[],
    disposeSessionRuntime: [] as string[],
  };

  const events = {
    latestAgentMessage(_agentId: string, sessionId: string) {
      return latestBySession.get(sessionId);
    },
    listBySession(_agentId: string, sessionId: string) {
      const event = latestBySession.get(sessionId);
      return event ? [event] : [];
    },
    deleteBySession(_agentId: string, sessionId: string) {
      latestBySession.delete(sessionId);
    },
    countUserTurns() {
      return 0;
    },
    statJsonl() {
      return undefined;
    },
    async *follow() {
      return;
    },
  };

  const router = {
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
      latestBySession.set(args.sessionId, {
        eventId: `evt_${args.sessionId}_${now}`,
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
    latestBySession,
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

describe("session ownership in the HTTP API", () => {
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
    const { app, store, latestBySession } = makeApp();
    const agent = createAgent(store);
    const session = store.sessions.create({
      agentId: agent.agentId,
      userId: null,
    });
    const now = Date.now();
    latestBySession.set(session.sessionId, {
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
      const { app, store, latestBySession } = makeApp({
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
      latestBySession.set(session.sessionId, {
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
});
