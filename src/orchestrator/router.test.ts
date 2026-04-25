import { afterEach, describe, expect, it, vi } from "vitest";

import type { GatewayWebSocketClient } from "../runtime/gateway-ws.js";
import { ParentTokenMinter } from "../runtime/parent-token.js";
import type { SessionContainerPool } from "../runtime/pool.js";
import { InMemoryStore } from "../store/memory.js";
import { PiJsonlEventReader } from "../store/pi-jsonl.js";
import type { QueueStore } from "../store/types.js";
import { clearZenMuxCatalogCache } from "./zenmux-pricing.js";
import {
  AgentRouter,
  RouterError,
  normalizeModelForRuntime,
  type RouterConfig,
} from "./router.js";

// These tests cover the decision-tree logic that doesn't require a live
// container: createSession, runEvent's pre-dispatch checks, and cancel's
// pre-abort checks. Paths that reach the pool / WS / chat.completions
// call are out of scope for unit tests and are covered by e2e.

function makeRouter(opts: {
  poolStub?: Partial<SessionContainerPool>;
  eventReaderStub?: Partial<PiJsonlEventReader>;
  passthroughEnv?: Record<string, string>;
} = {}): {
  router: AgentRouter;
  store: InMemoryStore;
  queue: QueueStore;
  pool: Partial<SessionContainerPool>;
} {
  const store = new InMemoryStore();
  const queue = store.queue;
  // Minimal pool stub: in tests that shouldn't reach the pool we leave
  // methods undefined so any accidental call throws TypeError and fails
  // loudly. Tests that DO want to exercise a pool interaction provide
  // their own shaped stub.
  const pool = (opts.poolStub ?? {}) as SessionContainerPool;
  const eventReader = (opts.eventReaderStub ??
    new PiJsonlEventReader("/tmp/does-not-exist")) as PiJsonlEventReader;
  const cfg: RouterConfig = {
    runtimeImage: "test-image",
    hostStateRoot: "/tmp/test-state",
    network: "test-net",
    gatewayPort: 18789,
    passthroughEnv: opts.passthroughEnv ?? {},
    runTimeoutMs: 60_000,
    orchestratorUrl: "http://orchestrator-test:8080",
    tokenMinter: new ParentTokenMinter(),
  };
  const router = new AgentRouter(
    store.agents,
    store.environments,
    store.sessions,
    eventReader,
    pool as SessionContainerPool,
    queue,
    store.vaults,
    cfg,
  );
  return { router, store, queue, pool };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clearZenMuxCatalogCache();
});

async function waitForSessionToStopRunning(
  store: InMemoryStore,
  sessionId: string,
): Promise<void> {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    const status = store.sessions.get(sessionId)?.status;
    if (status !== "starting" && status !== "running") return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`session ${sessionId} stayed inflight`);
}

describe("AgentRouter.createSession", () => {
  it("normalizes runtime models through ZenMux when ZENMUX_API_KEY is configured", () => {
    expect(
      normalizeModelForRuntime("moonshot/kimi-k2.6", { ZENMUX_API_KEY: "sk-test" }),
    ).toBe("zenmux/moonshot/kimi-k2.6");
    expect(
      normalizeModelForRuntime("zenmux/moonshot/kimi-k2.6", { ZENMUX_API_KEY: "sk-test" }),
    ).toBe("zenmux/moonshot/kimi-k2.6");
    expect(
      normalizeModelForRuntime("moonshot/kimi-k2.6", {}),
    ).toBe("moonshot/kimi-k2.6");
    expect(
      normalizeModelForRuntime("anthropic/claude-opus-4-7", { ZENMUX_API_KEY: "sk-test" }),
    ).toBe("zenmux/anthropic/claude-opus-4.7");
    expect(
      normalizeModelForRuntime("claude-opus-4-6", { ZENMUX_API_KEY: "sk-test" }),
    ).toBe("zenmux/anthropic/claude-opus-4.6");
  });

  it("creates a session bound to an existing agent", () => {
    const { router, store } = makeRouter();
    const agent = store.agents.create({
      model: "moonshot/kimi-k2.5",
      tools: [],
      instructions: "",
      permissionPolicy: { type: "always_allow" },
      callableAgents: [],
      maxSubagentDepth: 0,
    });
    const session = router.createSession(agent.agentId);
    expect(session.agentId).toBe(agent.agentId);
    expect(session.status).toBe("idle");
    expect(store.sessions.get(session.sessionId)).toBeDefined();
  });

  it("throws agent_not_found when agent does not exist", () => {
    const { router } = makeRouter();
    try {
      router.createSession("agt_missing");
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RouterError);
      expect((err as RouterError).code).toBe("agent_not_found");
    }
  });

  it("throws agent_archived once the agent is archived", () => {
    const { router, store } = makeRouter();
    const agent = store.agents.create({
      model: "m",
      tools: [],
      instructions: "",
      permissionPolicy: { type: "always_allow" },
      callableAgents: [],
      maxSubagentDepth: 0,
    });
    store.agents.archive(agent.agentId);
    try {
      router.createSession(agent.agentId);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RouterError);
      expect((err as RouterError).code).toBe("agent_archived");
    }
  });

  it("inherits maxSubagentDepth from the agent template by default", () => {
    const { router, store } = makeRouter();
    const agent = store.agents.create({
      model: "m",
      tools: [],
      instructions: "",
      permissionPolicy: { type: "always_allow" },
      callableAgents: ["agt_worker"],
      maxSubagentDepth: 3,
    });
    const session = router.createSession(agent.agentId);
    expect(session.remainingSubagentDepth).toBe(3);
  });

  it("honors an explicit remainingSubagentDepth override (subagent spawn path)", () => {
    const { router, store } = makeRouter();
    const agent = store.agents.create({
      model: "m",
      tools: [],
      instructions: "",
      permissionPolicy: { type: "always_allow" },
      callableAgents: ["agt_x"],
      maxSubagentDepth: 5,
    });
    const session = router.createSession(agent.agentId, {
      remainingSubagentDepth: 2,
    });
    // Override wins over the agent template's 5 — child sessions inherit
    // parent.remaining_depth - 1, not the child agent's own max.
    expect(session.remainingSubagentDepth).toBe(2);
  });
});

describe("AgentRouter.warmSession", () => {
  function seedAgent(store: InMemoryStore) {
    return store.agents.create({
      model: "moonshot/kimi-k2.5",
      tools: [],
      instructions: "",
      permissionPolicy: { type: "always_allow" },
      callableAgents: [],
      maxSubagentDepth: 0,
    });
  }

  it("queues a template warm for a default session", async () => {
    const warmed: string[] = [];
    const { router, store } = makeRouter({
      poolStub: {
        warmForAgent: async (agentId: string) => {
          warmed.push(agentId);
        },
      },
    });
    const agent = seedAgent(store);
    const session = router.createSession(agent.agentId);

    await router.warmSession(session.sessionId);

    expect(warmed).toEqual([agent.agentId]);
  });

  it("skips template warm for sessions with package preinstalls", async () => {
    const warmed: string[] = [];
    const { router, store } = makeRouter({
      poolStub: {
        warmForAgent: async (agentId: string) => {
          warmed.push(agentId);
        },
      },
    });
    const agent = seedAgent(store);
    const env = store.environments.create({
      name: "python",
      description: "",
      packages: { pip: ["numpy"] },
      networking: { type: "unrestricted" },
    });
    const session = router.createSession(agent.agentId, {
      environmentId: env.environmentId,
    });

    await router.warmSession(session.sessionId);

    expect(warmed).toEqual([]);
  });

  it("skips template warm for limited-networking sessions", async () => {
    const warmed: string[] = [];
    const { router, store } = makeRouter({
      poolStub: {
        warmForAgent: async (agentId: string) => {
          warmed.push(agentId);
        },
      },
    });
    const agent = seedAgent(store);
    const env = store.environments.create({
      name: "limited",
      description: "",
      networking: { type: "limited", allowedHosts: ["api.example.com"] },
    });
    const session = router.createSession(agent.agentId, {
      environmentId: env.environmentId,
    });

    await router.warmSession(session.sessionId);

    expect(warmed).toEqual([]);
  });

  it("skips template warm for vault-bound sessions", async () => {
    const warmed: string[] = [];
    const { router, store } = makeRouter({
      poolStub: {
        warmForAgent: async (agentId: string) => {
          warmed.push(agentId);
        },
      },
    });
    const agent = seedAgent(store);
    const vault = store.vaults.createVault({ userId: "usr_test", name: "prod" });
    const session = router.createSession(agent.agentId, {
      vaultId: vault.vaultId,
    });

    await router.warmSession(session.sessionId);

    expect(warmed).toEqual([]);
  });
});

describe("AgentRouter.streamEvent — pre-container decision tree", () => {
  // These tests exercise the parts of streamEvent that run BEFORE we hit
  // the pool / WS / fetch to the container — that surface is covered by
  // the existing e2e (test/e2e.sh) against a real container. The
  // pre-dispatch checks (session_not_found, agent_not_found,
  // session_busy) don't need a live container and are what we want to
  // lock against regressions.
  it("rejects unknown sessions with session_not_found", async () => {
    const { router } = makeRouter();
    await expect(
      router.streamEvent({ sessionId: "ses_nope", content: "hi" }),
    ).rejects.toMatchObject({ name: "RouterError", code: "session_not_found" });
  });

  it("rejects busy sessions with session_busy (streaming cannot interleave with the queue)", async () => {
    const { router, store } = makeRouter();
    const agent = store.agents.create({
      model: "m",
      tools: [],
      instructions: "",
      permissionPolicy: { type: "always_allow" },
      callableAgents: [],
      maxSubagentDepth: 0,
    });
    const session = router.createSession(agent.agentId);
    // Flip to starting directly to simulate a turn already inflight.
    store.sessions.beginRun(session.sessionId);
    await expect(
      router.streamEvent({ sessionId: session.sessionId, content: "hi" }),
    ).rejects.toMatchObject({ name: "RouterError", code: "session_busy" });
    // Session must still be inflight — a rejection must NOT inadvertently
    // transition state (a bug where we beginRun before checking status
    // would leave it inflight forever on the rejection path).
    expect(store.sessions.get(session.sessionId)?.status).toBe("starting");
  });

  it("rejects when the agent template was deleted after session creation", async () => {
    const { router, store } = makeRouter();
    const agent = store.agents.create({
      model: "m",
      tools: [],
      instructions: "",
      permissionPolicy: { type: "always_allow" },
      callableAgents: [],
      maxSubagentDepth: 0,
    });
    const session = router.createSession(agent.agentId);
    store.agents.delete(agent.agentId);
    await expect(
      router.streamEvent({ sessionId: session.sessionId, content: "hi" }),
    ).rejects.toMatchObject({ name: "RouterError", code: "agent_not_found" });
    // Session must be idle since we never got past validation.
    expect(store.sessions.get(session.sessionId)?.status).toBe("idle");
  });
});

describe("AgentRouter quota enforcement", () => {
  // Quotas fire from runEvent / streamEvent's pre-dispatch checks, so we
  // can exercise them without needing a live pool — same shape as the
  // other router decision-tree tests above.
  function seedAgentWithQuota(
    store: InMemoryStore,
    quota: NonNullable<ReturnType<InMemoryStore["agents"]["get"]>>["quota"],
  ) {
    return store.agents.create({
      model: "m",
      tools: [],
      instructions: "",
      permissionPolicy: { type: "always_allow" },
      callableAgents: [],
      maxSubagentDepth: 0,
      mcpServers: {},
      quota,
    });
  }

  it("rejects with quota_exceeded when the session's rolling cost >= maxCostUsdPerSession", async () => {
    const { router, store } = makeRouter();
    const agent = seedAgentWithQuota(store, { maxCostUsdPerSession: 1.0 });
    const session = router.createSession(agent.agentId);
    // Simulate a prior turn that brought us to the cap.
    store.sessions.addUsage(session.sessionId, {
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 1.0,
    });
    await expect(
      router.runEvent({ sessionId: session.sessionId, content: "another turn" }),
    ).rejects.toMatchObject({ name: "RouterError", code: "quota_exceeded" });
    // Session stayed idle — quota check must not flip state.
    expect(store.sessions.get(session.sessionId)?.status).toBe("idle");
  });

  it("rejects with quota_exceeded when tokens_in + tokens_out >= maxTokensPerSession", async () => {
    const { router, store } = makeRouter();
    const agent = seedAgentWithQuota(store, { maxTokensPerSession: 100 });
    const session = router.createSession(agent.agentId);
    store.sessions.addUsage(session.sessionId, {
      tokensIn: 80,
      tokensOut: 20,
      costUsd: 0,
    });
    await expect(
      router.runEvent({ sessionId: session.sessionId, content: "hi" }),
    ).rejects.toMatchObject({ name: "RouterError", code: "quota_exceeded" });
  });

  it("rejects with quota_exceeded when the session age has passed maxWallDurationMs", async () => {
    const { router, store } = makeRouter();
    const agent = seedAgentWithQuota(store, { maxWallDurationMs: 10 });
    const session = router.createSession(agent.agentId);
    await new Promise((r) => setTimeout(r, 20));
    await expect(
      router.runEvent({ sessionId: session.sessionId, content: "hi" }),
    ).rejects.toMatchObject({ name: "RouterError", code: "quota_exceeded" });
  });
});

describe("AgentRouter.runEvent — decision tree", () => {
  it("throws session_not_found for an unknown session", async () => {
    const { router } = makeRouter();
    await expect(
      router.runEvent({ sessionId: "ses_missing", content: "hi" }),
    ).rejects.toMatchObject({
      name: "RouterError",
      code: "session_not_found",
    });
  });

  it("throws agent_not_found when the agent was deleted but session lingers", async () => {
    // This path is a safety net: sessions outlive their template by design,
    // but if the template was deleted we can't spawn a container. Reject
    // explicitly rather than trying to spawn.
    const { router, store } = makeRouter();
    const agent = store.agents.create({
      model: "m",
      tools: [],
      instructions: "",
      permissionPolicy: { type: "always_allow" },
      callableAgents: [],
      maxSubagentDepth: 0,
    });
    const session = router.createSession(agent.agentId);
    store.agents.delete(agent.agentId);
    await expect(
      router.runEvent({ sessionId: session.sessionId, content: "hi" }),
    ).rejects.toMatchObject({
      name: "RouterError",
      code: "agent_not_found",
    });
  });

  it("queues the event when the session is currently running (no new run started)", async () => {
    // Session in "running" state → the event should land in the queue for
    // the in-flight run to pick up on completion. runEvent must return
    // queued=true and must NOT touch the pool (which would spawn a second
    // container).
    const { router, store, queue } = makeRouter();
    const agent = store.agents.create({
      model: "m",
      tools: [],
      instructions: "",
      permissionPolicy: { type: "always_allow" },
      callableAgents: [],
      maxSubagentDepth: 0,
    });
    const session = router.createSession(agent.agentId);
    // Simulate a run already in flight.
    store.sessions.beginRun(session.sessionId);
    expect(store.sessions.get(session.sessionId)?.status).toBe("starting");

    const result = await router.runEvent({
      sessionId: session.sessionId,
      content: "second message while first is running",
    });
    expect(result.queued).toBe(true);
    expect(result.session.status).toBe("starting");
    // Queue now has the one event we pushed.
    const next = queue.shift(session.sessionId);
    expect(next?.content).toBe("second message while first is running");
    // No more events queued.
    expect(queue.shift(session.sessionId)).toBeUndefined();
  });

  it("includes an optional `model` override in the queued entry", async () => {
    const { router, store, queue } = makeRouter();
    const agent = store.agents.create({
      model: "moonshot/kimi-k2.5",
      tools: [],
      instructions: "",
      permissionPolicy: { type: "always_allow" },
      callableAgents: [],
      maxSubagentDepth: 0,
    });
    const session = router.createSession(agent.agentId);
    store.sessions.beginRun(session.sessionId);

    await router.runEvent({
      sessionId: session.sessionId,
      content: "upgrade this turn",
      model: "anthropic/claude-sonnet-4-6",
    });
    const next = queue.shift(session.sessionId);
    expect(next?.model).toBe("anthropic/claude-sonnet-4-6");
  });

  it("rejects busy sessions instead of queueing when rejectIfBusy is set", async () => {
    const { router, store, queue } = makeRouter();
    const agent = store.agents.create({
      model: "m",
      tools: [],
      instructions: "",
      permissionPolicy: { type: "always_allow" },
      callableAgents: [],
      maxSubagentDepth: 0,
    });
    const session = router.createSession(agent.agentId);
    store.sessions.beginRun(session.sessionId);

    await expect(
      router.runEvent({
        sessionId: session.sessionId,
        content: "do not queue",
        rejectIfBusy: true,
      }),
    ).rejects.toMatchObject({ name: "RouterError", code: "session_busy" });
    expect(queue.size(session.sessionId)).toBe(0);
  });
});

describe("AgentRouter.runEvent — JSONL advancement guarantees", () => {
  function seedAgent(store: InMemoryStore) {
    return store.agents.create({
      model: "m",
      tools: [],
      instructions: "",
      permissionPolicy: { type: "always_allow" },
      callableAgents: [],
      maxSubagentDepth: 0,
    });
  }

  it("fails the turn when chat.completions returns 200 but no new JSONL events were written", async () => {
    vi.stubEnv("OPENCLAW_TURN_ADVANCE_WAIT_MS", "0");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "all good" } }],
            usage: { prompt_tokens: 11, completion_tokens: 7 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const fakeEvents = {
      stateRoot: "/tmp/test-state",
      countUserTurns: vi
        .fn()
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(0),
      latestAgentOutcome: vi
        .fn()
        .mockReturnValueOnce(undefined)
        .mockReturnValueOnce(undefined),
      latestAgentMessage: vi
        .fn()
        .mockReturnValueOnce(undefined)
        .mockReturnValueOnce(undefined),
    };
    const { router, store } = makeRouter({
      poolStub: {
        acquireForSession: async () =>
          ({ baseUrl: "http://container.test", token: "tok" }) as any,
        evictSession: async () => {},
      },
      eventReaderStub: fakeEvents as unknown as PiJsonlEventReader,
    });
    const agent = seedAgent(store);
    const session = router.createSession(agent.agentId);

    await router.runEvent({ sessionId: session.sessionId, content: "hi" });
    await waitForSessionToStopRunning(store, session.sessionId);

    const failed = store.sessions.get(session.sessionId);
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toContain("no new user.message was written to JSONL");
  });

  it("keeps the turn successful when the user turn is durable and only the assistant outcome lags JSONL", async () => {
    vi.stubEnv("OPENCLAW_TURN_ADVANCE_WAIT_MS", "0");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "direct completion" } }],
            usage: { prompt_tokens: 11, completion_tokens: 7 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const fakeEvents = {
      stateRoot: "/tmp/test-state",
      countUserTurns: vi.fn().mockReturnValue(1).mockReturnValueOnce(0),
      latestAgentOutcome: vi.fn().mockReturnValue(undefined),
      latestAgentMessage: vi.fn().mockReturnValue(undefined),
    };
    const { router, store } = makeRouter({
      poolStub: {
        acquireForSession: async () =>
          ({ baseUrl: "http://container.test", token: "tok" }) as any,
        evictSession: async () => {},
      },
      eventReaderStub: fakeEvents as unknown as PiJsonlEventReader,
    });
    const agent = seedAgent(store);
    const session = router.createSession(agent.agentId);

    await router.runEvent({ sessionId: session.sessionId, content: "hi" });
    await waitForSessionToStopRunning(store, session.sessionId);

    const finished = store.sessions.get(session.sessionId);
    expect(finished?.status).toBe("idle");
    expect(finished?.error).toBeNull();
    expect(finished?.tokensIn).toBe(11);
    expect(finished?.tokensOut).toBe(7);
  });

  it("keeps the turn successful when both user.message and agent.message advance", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "done" } }],
            usage: { prompt_tokens: 11, completion_tokens: 7 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const fakeEvents = {
      stateRoot: "/tmp/test-state",
      countUserTurns: vi
        .fn()
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(1),
      latestAgentOutcome: vi
        .fn()
        .mockReturnValueOnce(undefined)
        .mockReturnValueOnce({
          eventId: "evt_new",
          sessionId: "ses_unused",
          type: "agent.message",
          content: "done",
          createdAt: Date.now(),
          tokensIn: 11,
          tokensOut: 7,
          costUsd: 0.12,
        }),
      latestAgentMessage: vi
        .fn()
        .mockReturnValueOnce({
          eventId: "evt_new",
          sessionId: "ses_unused",
          type: "agent.message",
          content: "done",
          createdAt: Date.now(),
          tokensIn: 11,
          tokensOut: 7,
          costUsd: 0.12,
        }),
    };
    const { router, store } = makeRouter({
      poolStub: {
        acquireForSession: async () =>
          ({ baseUrl: "http://container.test", token: "tok" }) as any,
        evictSession: async () => {},
      },
      eventReaderStub: fakeEvents as unknown as PiJsonlEventReader,
    });
    const agent = seedAgent(store);
    const session = router.createSession(agent.agentId);

    await router.runEvent({ sessionId: session.sessionId, content: "hi" });
    await waitForSessionToStopRunning(store, session.sessionId);

    const finished = store.sessions.get(session.sessionId);
    expect(finished?.status).toBe("idle");
    expect(finished?.error).toBeNull();
    expect(finished?.tokensIn).toBe(11);
    expect(finished?.tokensOut).toBe(7);
    expect(finished?.costUsd).toBe(0.12);
  });

  it("keeps the turn successful when a tool result advances but no final agent.message is written", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "done" } }],
            usage: { prompt_tokens: 11, completion_tokens: 7 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const fakeEvents = {
      stateRoot: "/tmp/test-state",
      countUserTurns: vi
        .fn()
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(1),
      latestAgentOutcome: vi
        .fn()
        .mockReturnValueOnce(undefined)
        .mockReturnValueOnce({
          eventId: "evt_tool_result",
          sessionId: "ses_unused",
          type: "agent.tool_result",
          content: "Fri Apr 24 17:58:01 UTC 2026",
          createdAt: Date.now(),
          toolName: "exec",
          toolCallId: "call-date",
        }),
      latestAgentMessage: vi
        .fn()
        .mockReturnValueOnce(undefined),
    };
    const { router, store } = makeRouter({
      poolStub: {
        acquireForSession: async () =>
          ({ baseUrl: "http://container.test", token: "tok" }) as any,
        evictSession: async () => {},
      },
      eventReaderStub: fakeEvents as unknown as PiJsonlEventReader,
    });
    const agent = seedAgent(store);
    const session = router.createSession(agent.agentId);

    await router.runEvent({ sessionId: session.sessionId, content: "what time is it?" });
    await waitForSessionToStopRunning(store, session.sessionId);

    const finished = store.sessions.get(session.sessionId);
    expect(finished?.status).toBe("idle");
    expect(finished?.error).toBeNull();
    expect(finished?.tokensIn).toBe(11);
    expect(finished?.tokensOut).toBe(7);
  });

  it("bakes first-turn model and thinking overrides into spawn options", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "done" } }],
            usage: { prompt_tokens: 11, completion_tokens: 7 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const fakeEvents = {
      stateRoot: "/tmp/test-state",
      countUserTurns: vi
        .fn()
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(1),
      latestAgentOutcome: vi
        .fn()
        .mockReturnValueOnce(undefined)
        .mockReturnValueOnce({
          eventId: "evt_new",
          sessionId: "ses_unused",
          type: "agent.message",
          content: "done",
          createdAt: Date.now(),
          tokensIn: 11,
          tokensOut: 7,
        }),
      latestAgentMessage: vi
        .fn()
        .mockReturnValueOnce({
          eventId: "evt_new",
          sessionId: "ses_unused",
          type: "agent.message",
          content: "done",
          createdAt: Date.now(),
          tokensIn: 11,
          tokensOut: 7,
        }),
    };
    let capturedSpawnOptions: unknown;
    const { router, store } = makeRouter({
      poolStub: {
        acquireForSession: async (args: { spawnOptions: unknown }) => {
          capturedSpawnOptions = args.spawnOptions;
          return { baseUrl: "http://container.test", token: "tok" } as any;
        },
        evictSession: async () => {},
      },
      eventReaderStub: fakeEvents as unknown as PiJsonlEventReader,
    });
    const agent = store.agents.create({
      model: "moonshot/kimi-k2.5",
      tools: [],
      instructions: "",
      permissionPolicy: { type: "always_allow" },
      callableAgents: [],
      maxSubagentDepth: 0,
      thinkingLevel: "medium",
    });
    const session = router.createSession(agent.agentId);

    await router.runEvent({
      sessionId: session.sessionId,
      content: "hi",
      model: "openai/gpt-5.4",
      thinkingLevel: "high",
    });
    await waitForSessionToStopRunning(store, session.sessionId);

    expect(capturedSpawnOptions).toMatchObject({
      env: {
        OPENCLAW_MODEL: "openai/gpt-5.4",
        OPENCLAW_THINKING_LEVEL: "high",
      },
    });
  });

  it("uses WS patch instead of changing boot config for later-turn overrides", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "done" } }],
            usage: { prompt_tokens: 11, completion_tokens: 7 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const fakeEvents = {
      stateRoot: "/tmp/test-state",
      countUserTurns: vi
        .fn()
        .mockReturnValueOnce(1)
        .mockReturnValueOnce(2),
      latestAgentOutcome: vi
        .fn()
        .mockReturnValueOnce({
          eventId: "evt_old",
          sessionId: "ses_unused",
          type: "agent.message",
          content: "old",
          createdAt: 1,
        })
        .mockReturnValueOnce({
          eventId: "evt_new",
          sessionId: "ses_unused",
          type: "agent.message",
          content: "done",
          createdAt: Date.now(),
          tokensIn: 11,
          tokensOut: 7,
        }),
      latestAgentMessage: vi
        .fn()
        .mockReturnValueOnce({
          eventId: "evt_new",
          sessionId: "ses_unused",
          type: "agent.message",
          content: "done",
          createdAt: Date.now(),
          tokensIn: 11,
          tokensOut: 7,
        }),
    };
    let capturedSpawnOptions: unknown;
    let patched: Record<string, unknown> | undefined;
    const fakeWs = {
      patch: async (_key: string, fields: Record<string, unknown>) => {
        patched = fields;
      },
    };
    const { router, store } = makeRouter({
      poolStub: {
        acquireForSession: async (args: { spawnOptions: unknown }) => {
          capturedSpawnOptions = args.spawnOptions;
          return { baseUrl: "http://container.test", token: "tok" } as any;
        },
        getWsClient: () => fakeWs as unknown as GatewayWebSocketClient,
        evictSession: async () => {},
      },
      eventReaderStub: fakeEvents as unknown as PiJsonlEventReader,
    });
    const agent = store.agents.create({
      model: "moonshot/kimi-k2.5",
      tools: [],
      instructions: "",
      permissionPolicy: { type: "always_allow" },
      callableAgents: [],
      maxSubagentDepth: 0,
      thinkingLevel: "off",
    });
    const session = router.createSession(agent.agentId);
    store.sessions.bumpTurns(session.sessionId);

    await router.runEvent({
      sessionId: session.sessionId,
      content: "hi",
      model: "openai/gpt-5.4",
      thinkingLevel: "high",
    });
    await waitForSessionToStopRunning(store, session.sessionId);

    expect(capturedSpawnOptions).toMatchObject({
      env: {
        OPENCLAW_MODEL: "moonshot/kimi-k2.5",
        OPENCLAW_THINKING_LEVEL: "off",
      },
    });
    expect(patched).toEqual({
      model: "openai/gpt-5.4",
      thinkingLevel: "high",
    });
  });

  it("falls back to transcript usage when the completion response omits usage", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "done" } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const fakeEvents = {
      stateRoot: "/tmp/test-state",
      countUserTurns: vi
        .fn()
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(1),
      latestAgentOutcome: vi
        .fn()
        .mockReturnValueOnce(undefined)
        .mockReturnValueOnce({
          eventId: "evt_new",
          sessionId: "ses_unused",
          type: "agent.message",
          content: "done",
          createdAt: Date.now(),
          tokensIn: 321,
          tokensOut: 45,
          costUsd: 0.42,
        }),
      latestAgentMessage: vi
        .fn()
        .mockReturnValueOnce({
          eventId: "evt_new",
          sessionId: "ses_unused",
          type: "agent.message",
          content: "done",
          createdAt: Date.now(),
          tokensIn: 321,
          tokensOut: 45,
          costUsd: 0.42,
        }),
    };
    const { router, store } = makeRouter({
      poolStub: {
        acquireForSession: async () =>
          ({ baseUrl: "http://container.test", token: "tok" }) as any,
        evictSession: async () => {},
      },
      eventReaderStub: fakeEvents as unknown as PiJsonlEventReader,
    });
    const agent = seedAgent(store);
    const session = router.createSession(agent.agentId);

    await router.runEvent({ sessionId: session.sessionId, content: "hi" });
    await waitForSessionToStopRunning(store, session.sessionId);

    const finished = store.sessions.get(session.sessionId);
    expect(finished?.status).toBe("idle");
    expect(finished?.tokensIn).toBe(321);
    expect(finished?.tokensOut).toBe(45);
    expect(finished?.costUsd).toBe(0.42);
  });

  it("normalizes input_tokens/output_tokens usage aliases from chat completion responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "done" } }],
            usage: { input_tokens: 18, output_tokens: 6 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const fakeEvents = {
      stateRoot: "/tmp/test-state",
      countUserTurns: vi
        .fn()
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(1),
      latestAgentOutcome: vi
        .fn()
        .mockReturnValueOnce(undefined)
        .mockReturnValueOnce({
          eventId: "evt_new",
          sessionId: "ses_unused",
          type: "agent.message",
          content: "done",
          createdAt: Date.now(),
          costUsd: 0.05,
        }),
      latestAgentMessage: vi
        .fn()
        .mockReturnValueOnce({
          eventId: "evt_new",
          sessionId: "ses_unused",
          type: "agent.message",
          content: "done",
          createdAt: Date.now(),
          costUsd: 0.05,
        }),
    };
    const { router, store } = makeRouter({
      poolStub: {
        acquireForSession: async () =>
          ({ baseUrl: "http://container.test", token: "tok" }) as any,
        evictSession: async () => {},
      },
      eventReaderStub: fakeEvents as unknown as PiJsonlEventReader,
    });
    const agent = seedAgent(store);
    const session = router.createSession(agent.agentId);

    await router.runEvent({ sessionId: session.sessionId, content: "hi" });
    await waitForSessionToStopRunning(store, session.sessionId);

    const finished = store.sessions.get(session.sessionId);
    expect(finished?.status).toBe("idle");
    expect(finished?.tokensIn).toBe(18);
    expect(finished?.tokensOut).toBe(6);
    expect(finished?.costUsd).toBe(0.05);
  });

  it("estimates cost from the live ZenMux catalog when transcript cost is missing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === "http://container.test/v1/chat/completions") {
          return new Response(
            JSON.stringify({
              choices: [{ message: { content: "done" } }],
              usage: { prompt_tokens: 321, completion_tokens: 45 },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
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
      }),
    );
    const fakeEvents = {
      stateRoot: "/tmp/test-state",
      countUserTurns: vi
        .fn()
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(1),
      latestAgentOutcome: vi
        .fn()
        .mockReturnValueOnce(undefined)
        .mockReturnValueOnce({
          eventId: "evt_new",
          sessionId: "ses_unused",
          type: "agent.message",
          content: "done",
          createdAt: Date.now(),
          tokensIn: 321,
          tokensOut: 45,
          model: "zenmux/openai/gpt-5.4",
        }),
      latestAgentMessage: vi
        .fn()
        .mockReturnValueOnce({
          eventId: "evt_new",
          sessionId: "ses_unused",
          type: "agent.message",
          content: "done",
          createdAt: Date.now(),
          tokensIn: 321,
          tokensOut: 45,
          model: "zenmux/openai/gpt-5.4",
        }),
    };
    const { router, store } = makeRouter({
      poolStub: {
        acquireForSession: async () =>
          ({ baseUrl: "http://container.test", token: "tok" }) as any,
        evictSession: async () => {},
      },
      eventReaderStub: fakeEvents as unknown as PiJsonlEventReader,
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
    const session = router.createSession(agent.agentId);

    await router.runEvent({ sessionId: session.sessionId, content: "hi" });
    await waitForSessionToStopRunning(store, session.sessionId);

    const finished = store.sessions.get(session.sessionId);
    expect(finished?.status).toBe("idle");
    expect(finished?.tokensIn).toBe(321);
    expect(finished?.tokensOut).toBe(45);
    expect(finished?.costUsd).toBeCloseTo(0.0112525, 8);
  });
});

describe("AgentRouter.cancel — pre-abort checks", () => {
  it("throws session_not_found for an unknown session", async () => {
    const { router } = makeRouter();
    await expect(router.cancel("ses_missing")).rejects.toMatchObject({
      name: "RouterError",
      code: "session_not_found",
    });
  });

  it("throws session_not_running when the session is idle", async () => {
    const { router, store } = makeRouter();
    const agent = store.agents.create({
      model: "m",
      tools: [],
      instructions: "",
      permissionPolicy: { type: "always_allow" },
      callableAgents: [],
      maxSubagentDepth: 0,
    });
    const session = router.createSession(agent.agentId);
    // Session is idle (never called beginRun).
    await expect(router.cancel(session.sessionId)).rejects.toMatchObject({
      name: "RouterError",
      code: "session_not_running",
    });
  });

  it("cancels gracefully when running session has no pool entry (acquire phase)", async () => {
    // When cancel is called while the session is still acquiring a
    // container (no WS client yet), it should transition the session
    // to idle instead of throwing — the background task will detect
    // the flag and abort after acquire completes.
    const pool = {
      getWsClient: (_id: string): GatewayWebSocketClient | undefined => undefined,
    };
    const { router, store } = makeRouter({ poolStub: pool });
    const agent = store.agents.create({
      model: "m",
      tools: [],
      instructions: "",
      permissionPolicy: { type: "always_allow" },
      callableAgents: [],
      maxSubagentDepth: 0,
    });
    const session = router.createSession(agent.agentId);
    store.sessions.beginRun(session.sessionId);

    const result = await router.cancel(session.sessionId);
    expect(result.status).toBe("idle");
  });

  it("drains the queue and pending approvals then marks the session idle", async () => {
    // Happy-path cancel: WS abort succeeds, router clears per-session
    // bookkeeping. We use a fake ws that records the abort call and
    // resolves successfully.
    let abortedKey: string | undefined;
    const fakeWs = {
      abort: async (key: string) => {
        abortedKey = key;
      },
      close: async () => {},
    } as unknown as GatewayWebSocketClient;
    const pool = {
      getWsClient: (_id: string) => fakeWs,
    };
    const { router, store, queue } = makeRouter({ poolStub: pool });
    const agent = store.agents.create({
      model: "m",
      tools: [],
      instructions: "",
      permissionPolicy: { type: "always_allow" },
      callableAgents: [],
      maxSubagentDepth: 0,
    });
    const session = router.createSession(agent.agentId);
    store.sessions.beginRun(session.sessionId);
    queue.enqueue(session.sessionId, {
      content: "pending work",
      enqueuedAt: Date.now(),
    });

    const cancelled = await router.cancel(session.sessionId);
    expect(cancelled.status).toBe("idle");
    // Canonical session key is what OpenClaw's orphan-key migration
    // rewrites non-canonical forms to on startup, so using it directly
    // keeps our abort idempotent across OpenClaw restarts.
    expect(abortedKey).toBe(`agent:main:${session.sessionId}`);
    expect(queue.shift(session.sessionId)).toBeUndefined();
  });
});

describe("AgentRouter.getPendingApprovals", () => {
  it("returns an empty array for a session with no pending approvals", () => {
    const { router } = makeRouter();
    expect(router.getPendingApprovals("ses_whatever")).toEqual([]);
  });
});

class FakeApprovalWs {
  readonly listeners = new Map<string, Set<(payload: unknown) => void>>();
  pending: unknown[] = [];
  resolveImpl: (id: string, decision: string) => Promise<void> = async () => {};

  onEvent(eventName: string, handler: (payload: unknown) => void): () => void {
    const set = this.listeners.get(eventName) ?? new Set<(payload: unknown) => void>();
    set.add(handler);
    this.listeners.set(eventName, set);
    return () => {
      set.delete(handler);
      if (set.size === 0) this.listeners.delete(eventName);
    };
  }

  async approvalList(): Promise<unknown[]> {
    return this.pending;
  }

  async approvalResolve(id: string, decision: string): Promise<void> {
    await this.resolveImpl(id, decision);
  }

  emit(eventName: string, payload: unknown): void {
    for (const handler of this.listeners.get(eventName) ?? []) {
      handler(payload);
    }
  }

  listenerCount(eventName: string): number {
    return this.listeners.get(eventName)?.size ?? 0;
  }
}

describe("AgentRouter approval flow", () => {
  it("keeps a pending approval when approvalResolve fails", async () => {
    const fakeWs = new FakeApprovalWs();
    fakeWs.resolveImpl = async () => {
      throw new Error("ws down");
    };
    const { router } = makeRouter({
      poolStub: {
        getWsClient: () => fakeWs as unknown as GatewayWebSocketClient,
      },
    });
    (router as any).pendingApprovals.set("ses_1", [{
      approvalId: "ap_1",
      sessionId: "ses_1",
      toolName: "write",
      toolCallId: "call_1",
      description: "write file?",
      arrivedAt: 1,
    }]);

    await expect(router.confirmTool("ses_1", "ap_1", "allow")).rejects.toMatchObject({
      name: "RouterError",
      code: "confirm_tool_failed",
    });
    expect(router.getPendingApprovals("ses_1")).toHaveLength(1);
    expect(router.getPendingApprovals("ses_1")[0]?.approvalId).toBe("ap_1");
  });

  it("rehydrates pending approvals from the gateway list with toolCallId metadata", async () => {
    const fakeWs = new FakeApprovalWs();
    fakeWs.pending = [{
      id: "ap_1",
      createdAtMs: 123,
      request: {
        toolName: "write",
        toolCallId: "call_1",
        description: "The agent wants to write a file.",
      },
    }];
    const { router } = makeRouter();

    await (router as any).ensureApprovalSubscriptions(
      "ses_1",
      fakeWs as unknown as GatewayWebSocketClient,
    );

    expect(router.getPendingApprovals("ses_1")).toEqual([{
      approvalId: "ap_1",
      sessionId: "ses_1",
      toolName: "write",
      toolCallId: "call_1",
      description: "The agent wants to write a file.",
      arrivedAt: 123,
    }]);
  });

  it("deduplicates approval listeners per session and clears on resolved events", async () => {
    const fakeWs = new FakeApprovalWs();
    const { router } = makeRouter();

    await (router as any).ensureApprovalSubscriptions(
      "ses_1",
      fakeWs as unknown as GatewayWebSocketClient,
    );
    await (router as any).ensureApprovalSubscriptions(
      "ses_1",
      fakeWs as unknown as GatewayWebSocketClient,
    );

    expect(fakeWs.listenerCount("plugin.approval.requested")).toBe(1);
    expect(fakeWs.listenerCount("plugin.approval.resolved")).toBe(1);

    fakeWs.emit("plugin.approval.requested", {
      id: "ap_1",
      createdAtMs: 123,
      request: {
        title: "Tool requires confirmation: write",
        toolName: "write",
        toolCallId: "call_1",
        description: "desc",
      },
    });
    fakeWs.emit("plugin.approval.requested", {
      id: "ap_1",
      createdAtMs: 124,
      request: {
        title: "Tool requires confirmation: write",
        toolName: "write",
        toolCallId: "call_1",
        description: "desc",
      },
    });

    expect(router.getPendingApprovals("ses_1")).toHaveLength(1);
    expect(router.getPendingApprovals("ses_1")[0]?.toolCallId).toBe("call_1");

    fakeWs.emit("plugin.approval.resolved", { id: "ap_1", decision: "allow-once" });
    expect(router.getPendingApprovals("ses_1")).toEqual([]);
  });
});
