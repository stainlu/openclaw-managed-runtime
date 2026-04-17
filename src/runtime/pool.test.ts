import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the WS client BEFORE importing pool. The real impl opens a
// network socket in its connect(); a unit test must avoid that. Only
// the surface the pool actually uses (new + connect + close) is
// exercised, so the fake is tiny.
vi.mock("./gateway-ws.js", () => {
  // Tracks instances so tests can assert how many were created.
  const instances: FakeWs[] = [];
  class FakeWs {
    readonly closeCount = { n: 0 };
    constructor(public readonly cfg: unknown) {
      instances.push(this);
    }
    async connect(): Promise<void> {
      /* noop */
    }
    async close(): Promise<void> {
      this.closeCount.n += 1;
    }
    async abort(): Promise<void> {
      /* noop */
    }
  }
  class FakeWsError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
    }
  }
  return {
    GatewayWebSocketClient: FakeWs,
    GatewayWsError: FakeWsError,
    __instances: instances,
  };
});

// Import AFTER the mock hoist — the pool will pick up the fake.
import type { Container, ContainerRuntime, SpawnOptions } from "./container.js";
import { SessionContainerPool, type PoolConfig } from "./pool.js";

type FakeRuntimeCall = { kind: "spawn" | "stop" | "waitForReady"; id: string; opts?: SpawnOptions };

class FakeRuntime implements ContainerRuntime {
  readonly calls: FakeRuntimeCall[] = [];
  readonly spawned = new Set<string>();
  readonly stopped = new Set<string>();
  spawnDelayMs = 0;
  readyShouldFail = false;

  private counter = 0;

  async spawn(opts: SpawnOptions): Promise<Container> {
    this.counter += 1;
    const id = `cnt_${this.counter}`;
    this.calls.push({ kind: "spawn", id, opts });
    this.spawned.add(id);
    if (this.spawnDelayMs > 0) {
      await new Promise((r) => setTimeout(r, this.spawnDelayMs));
    }
    return {
      id,
      name: `name_${this.counter}`,
      baseUrl: `http://${id}:18789`,
      token: `tok_${this.counter}`,
    };
  }

  async stop(id: string): Promise<void> {
    this.calls.push({ kind: "stop", id });
    this.stopped.add(id);
    this.spawned.delete(id);
  }

  async waitForReady(container: Container, _timeoutMs: number): Promise<void> {
    this.calls.push({ kind: "waitForReady", id: container.id });
    if (this.readyShouldFail) {
      throw new Error("readyz timeout (simulated)");
    }
  }
}

function baseSpawnOptions(nameOverride?: string): SpawnOptions {
  return {
    image: "test-image",
    env: {},
    mounts: [],
    containerPort: 18789,
    name: nameOverride,
  };
}

function makePool(overrides: Partial<PoolConfig> = {}): {
  pool: SessionContainerPool;
  runtime: FakeRuntime;
  cfg: PoolConfig;
} {
  const runtime = new FakeRuntime();
  const cfg: PoolConfig = {
    idleTimeoutMs: 60_000,
    readyTimeoutMs: 10_000,
    // sweepIntervalMs is set high so the timer-based sweeper doesn't
    // fire during tests. We invoke reapIdle / shutdown manually.
    sweepIntervalMs: 10 * 60_000,
    maxWarmContainers: 3,
    warmIdleTimeoutMs: 60_000,
    isBusy: () => false,
    ...overrides,
  };
  const pool = new SessionContainerPool(runtime, cfg);
  return { pool, runtime, cfg };
}

describe("SessionContainerPool.adopt", () => {
  it("registers an existing container in active without spawning", async () => {
    const { pool, runtime } = makePool();
    const preExisting = {
      id: "cnt_existing",
      name: "pre-existing",
      baseUrl: "http://pre-existing:18789",
      token: "tok_recovered",
    };
    await pool.adopt({ sessionId: "ses_restart", container: preExisting });
    // No spawn, but readyz MUST be probed so we don't adopt a broken container.
    expect(runtime.calls.map((c) => c.kind)).toEqual(["waitForReady"]);
    // The active-reuse path should now find the adopted container without spawning.
    const reused = await pool.acquireForSession({
      sessionId: "ses_restart",
      spawnOptions: baseSpawnOptions(),
    });
    expect(reused.id).toBe("cnt_existing");
    expect(runtime.calls.filter((c) => c.kind === "spawn")).toHaveLength(0);
    await pool.shutdown();
  });

  it("rejects adopt when the session already has an active container", async () => {
    const { pool } = makePool();
    await pool.acquireForSession({
      sessionId: "ses_live",
      spawnOptions: baseSpawnOptions(),
    });
    await expect(
      pool.adopt({
        sessionId: "ses_live",
        container: {
          id: "cnt_dup",
          name: "dup",
          baseUrl: "http://dup:18789",
          token: "tok_dup",
        },
      }),
    ).rejects.toThrow(/already has an active container/);
    await pool.shutdown();
  });

  it("propagates readyz failure so the caller can decide whether to stop the container", async () => {
    const { pool, runtime } = makePool();
    runtime.readyShouldFail = true;
    await expect(
      pool.adopt({
        sessionId: "ses_dead",
        container: {
          id: "cnt_dead",
          name: "dead",
          baseUrl: "http://dead:18789",
          token: "tok_dead",
        },
      }),
    ).rejects.toThrow(/readyz timeout/);
    // Adopt MUST NOT call runtime.stop — that's the caller's policy
    // decision (startup flow stops; a future adopt-on-demand path
    // might retry).
    expect(runtime.calls.some((c) => c.kind === "stop")).toBe(false);
    await pool.shutdown();
  });
});

describe("SessionContainerPool.acquireForSession", () => {
  it("cold-spawn path: creates a new container, waits for ready, registers active", async () => {
    const { pool, runtime } = makePool();
    const c = await pool.acquireForSession({
      sessionId: "ses_1",
      spawnOptions: baseSpawnOptions(),
    });
    expect(c.id).toBe("cnt_1");
    expect(runtime.calls.map((c) => c.kind)).toEqual(["spawn", "waitForReady"]);
    expect(pool.snapshot()).toHaveLength(1);
    await pool.shutdown();
  });

  it("live-reuse path: second acquire for same session returns same container without spawning again", async () => {
    const { pool, runtime } = makePool();
    const first = await pool.acquireForSession({
      sessionId: "ses_1",
      spawnOptions: baseSpawnOptions(),
    });
    const second = await pool.acquireForSession({
      sessionId: "ses_1",
      spawnOptions: baseSpawnOptions(),
    });
    expect(second.id).toBe(first.id);
    const spawns = runtime.calls.filter((c) => c.kind === "spawn");
    expect(spawns).toHaveLength(1);
    await pool.shutdown();
  });

  it("pending-dedup: two concurrent acquires for the same session share one spawn", async () => {
    const { pool, runtime } = makePool();
    runtime.spawnDelayMs = 20; // force the spawns to overlap
    const [a, b] = await Promise.all([
      pool.acquireForSession({ sessionId: "ses_1", spawnOptions: baseSpawnOptions() }),
      pool.acquireForSession({ sessionId: "ses_1", spawnOptions: baseSpawnOptions() }),
    ]);
    expect(a.id).toBe(b.id);
    expect(runtime.calls.filter((c) => c.kind === "spawn")).toHaveLength(1);
    await pool.shutdown();
  });

  it("warm-claim path: pre-warmed container is claimed and the warm bucket shrinks", async () => {
    const { pool, runtime } = makePool();
    await pool.warmForAgent("agt_x", baseSpawnOptions());
    // The warm-for-agent path spawned one container and left it warm.
    expect(runtime.calls.filter((c) => c.kind === "spawn")).toHaveLength(1);

    const c = await pool.acquireForSession({
      sessionId: "ses_1",
      spawnOptions: baseSpawnOptions(),
      agentId: "agt_x",
    });
    // The acquired container matches the pre-warmed one (id=cnt_1).
    expect(c.id).toBe("cnt_1");
    // No new spawn for the claim itself — the immediate spawn count is
    // still 1. (The background replenish kicks off a second spawn.)
    // Give the event loop one tick so the replenish can settle.
    await new Promise((r) => setImmediate(r));
    expect(runtime.calls.filter((c) => c.kind === "spawn")).toHaveLength(2);
    await pool.shutdown();
  });
});

describe("SessionContainerPool.warmForAgent", () => {
  it("is idempotent — a second call for the same agent is a no-op", async () => {
    const { pool, runtime } = makePool();
    await pool.warmForAgent("agt_x", baseSpawnOptions());
    await pool.warmForAgent("agt_x", baseSpawnOptions());
    // Only one actual spawn; second call short-circuits on `warm.has(agentId)`.
    expect(runtime.calls.filter((c) => c.kind === "spawn")).toHaveLength(1);
    await pool.shutdown();
  });

  it("evicts the oldest warm entry when at maxWarmContainers cap", async () => {
    const { pool, runtime } = makePool({ maxWarmContainers: 2 });
    await pool.warmForAgent("agt_first", baseSpawnOptions()); // cnt_1 oldest
    await pool.warmForAgent("agt_second", baseSpawnOptions()); // cnt_2
    // At cap now. Adding a third should evict cnt_1 first.
    await pool.warmForAgent("agt_third", baseSpawnOptions()); // cnt_3 triggers stop(cnt_1)
    const stopped = runtime.calls.filter((c) => c.kind === "stop").map((c) => c.id);
    expect(stopped).toContain("cnt_1");
    expect(stopped).not.toContain("cnt_2");
    expect(stopped).not.toContain("cnt_3");
    await pool.shutdown();
  });

  it("stops the container if waitForReady fails, so a broken spawn doesn't leak", async () => {
    const { pool, runtime } = makePool();
    runtime.readyShouldFail = true;
    await expect(pool.warmForAgent("agt_x", baseSpawnOptions())).rejects.toThrow(
      /readyz/,
    );
    // The spawned container should have been stopped on the failure path.
    expect(runtime.stopped.has("cnt_1")).toBe(true);
    await pool.shutdown();
  });
});

describe("SessionContainerPool.evictSession", () => {
  it("stops the container and removes the active entry", async () => {
    const { pool, runtime } = makePool();
    await pool.acquireForSession({
      sessionId: "ses_1",
      spawnOptions: baseSpawnOptions(),
    });
    expect(pool.snapshot()).toHaveLength(1);
    await pool.evictSession("ses_1");
    expect(pool.snapshot()).toHaveLength(0);
    expect(runtime.stopped.has("cnt_1")).toBe(true);
    await pool.shutdown();
  });

  it("is a no-op for an unknown session", async () => {
    const { pool, runtime } = makePool();
    await pool.evictSession("ses_never");
    expect(runtime.calls).toHaveLength(0);
    await pool.shutdown();
  });
});

describe("SessionContainerPool.reapIdle", () => {
  it("reaps active containers whose lastUsedAt is older than idleTimeoutMs", async () => {
    // Use a short idle timeout so we can flip the clock via `sleep(2)`
    // without making the suite slow.
    const { pool, runtime } = makePool({ idleTimeoutMs: 50 });
    await pool.acquireForSession({
      sessionId: "ses_1",
      spawnOptions: baseSpawnOptions(),
    });
    await new Promise((r) => setTimeout(r, 80));
    // @ts-expect-error — reapIdle is private but we exercise it directly
    // to avoid relying on the interval-based sweeper in a unit test.
    await pool.reapIdle();
    expect(pool.snapshot()).toHaveLength(0);
    expect(runtime.stopped.has("cnt_1")).toBe(true);
    await pool.shutdown();
  });

  it("skips sessions where isBusy(sessionId) returns true", async () => {
    // isBusy is the orchestrator's way of telling the pool "a run is in
    // flight on this session; don't yank the container even if it looks
    // idle." The pool closes over that predicate at construction.
    const busy = new Set(["ses_busy"]);
    const { pool, runtime } = makePool({
      idleTimeoutMs: 50,
      isBusy: (id) => busy.has(id),
    });
    await pool.acquireForSession({
      sessionId: "ses_busy",
      spawnOptions: baseSpawnOptions(),
    });
    await pool.acquireForSession({
      sessionId: "ses_idle",
      spawnOptions: baseSpawnOptions(),
    });
    await new Promise((r) => setTimeout(r, 80));
    // @ts-expect-error — private reapIdle
    await pool.reapIdle();
    const sessionsLeft = pool.snapshot().map((e) => e.sessionId);
    expect(sessionsLeft).toEqual(["ses_busy"]);
    expect(runtime.stopped.has("cnt_2")).toBe(true); // idle one reaped
    expect(runtime.stopped.has("cnt_1")).toBe(false); // busy one kept
    await pool.shutdown();
  });

  it("invokes cleanupOnReap after reaping so ephemeral sessions can delete their JSONL", async () => {
    const cleaned: string[] = [];
    const { pool } = makePool({
      idleTimeoutMs: 50,
      cleanupOnReap: async (id) => {
        cleaned.push(id);
      },
    });
    await pool.acquireForSession({
      sessionId: "ses_eph",
      spawnOptions: baseSpawnOptions(),
    });
    await new Promise((r) => setTimeout(r, 80));
    // @ts-expect-error — private reapIdle
    await pool.reapIdle();
    expect(cleaned).toEqual(["ses_eph"]);
    await pool.shutdown();
  });

  it("reaps warm containers past warmIdleTimeoutMs", async () => {
    const { pool, runtime } = makePool({
      idleTimeoutMs: 10 * 60_000,
      warmIdleTimeoutMs: 50,
    });
    await pool.warmForAgent("agt_x", baseSpawnOptions());
    await new Promise((r) => setTimeout(r, 80));
    // @ts-expect-error — private reapIdle
    await pool.reapIdle();
    expect(runtime.stopped.has("cnt_1")).toBe(true);
    await pool.shutdown();
  });
});

describe("SessionContainerPool.shutdown", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("stops every active and warm container", async () => {
    const { pool, runtime } = makePool();
    await pool.acquireForSession({
      sessionId: "ses_1",
      spawnOptions: baseSpawnOptions(),
    });
    await pool.warmForAgent("agt_x", baseSpawnOptions());
    expect(pool.snapshot()).toHaveLength(1);
    await pool.shutdown();
    expect(pool.snapshot()).toHaveLength(0);
    // Both the active (cnt_1) and warm (cnt_2) were stopped.
    expect(runtime.stopped.has("cnt_1")).toBe(true);
    expect(runtime.stopped.has("cnt_2")).toBe(true);
  });
});
