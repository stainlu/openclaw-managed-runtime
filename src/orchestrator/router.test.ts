import { describe, expect, it } from "vitest";

import type { GatewayWebSocketClient } from "../runtime/gateway-ws.js";
import { ParentTokenMinter } from "../runtime/parent-token.js";
import type { SessionContainerPool } from "../runtime/pool.js";
import { InMemoryStore } from "../store/memory.js";
import { PiJsonlEventReader } from "../store/pi-jsonl.js";
import type { QueueStore } from "../store/types.js";
import { AgentRouter, RouterError, type RouterConfig } from "./router.js";

// These tests cover the decision-tree logic that doesn't require a live
// container: createSession, runEvent's pre-dispatch checks, and cancel's
// pre-abort checks. Paths that reach the pool / WS / chat.completions
// call are out of scope for unit tests and are covered by e2e.

function makeRouter(opts: {
  poolStub?: Partial<SessionContainerPool>;
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
  const eventReader = new PiJsonlEventReader("/tmp/does-not-exist");
  const cfg: RouterConfig = {
    runtimeImage: "test-image",
    hostStateRoot: "/tmp/test-state",
    network: "test-net",
    gatewayPort: 18789,
    passthroughEnv: {},
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
    cfg,
  );
  return { router, store, queue, pool };
}

describe("AgentRouter.createSession", () => {
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
    // Flip to running directly to simulate a turn in flight.
    store.sessions.beginRun(session.sessionId);
    await expect(
      router.streamEvent({ sessionId: session.sessionId, content: "hi" }),
    ).rejects.toMatchObject({ name: "RouterError", code: "session_busy" });
    // Session must still be running — a rejection must NOT inadvertently
    // transition state (a bug where we beginRun before checking status
    // would leave it "running" forever on the rejection path).
    expect(store.sessions.get(session.sessionId)?.status).toBe("running");
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
    expect(store.sessions.get(session.sessionId)?.status).toBe("running");

    const result = await router.runEvent({
      sessionId: session.sessionId,
      content: "second message while first is running",
    });
    expect(result.queued).toBe(true);
    expect(result.session.status).toBe("running");
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

  it("throws no_active_container when running session has no pool entry", async () => {
    // Cancel path requires a live WS to abort. If the container was
    // already torn down (eg. it crashed right before cancel), we surface
    // the error rather than silently no-op the abort.
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

    await expect(router.cancel(session.sessionId)).rejects.toMatchObject({
      name: "RouterError",
      code: "no_active_container",
    });
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
