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

type FakeRuntimeCall =
  | { kind: "spawn"; id: string; opts: SpawnOptions }
  | { kind: "stop"; id: string }
  | { kind: "waitForReady"; id: string }
  | { kind: "ensureNetwork"; network: string; internal: boolean }
  | { kind: "removeNetwork"; network: string }
  | { kind: "connectNetwork"; containerId: string; network: string };

class FakeRuntime implements ContainerRuntime {
  readonly calls: FakeRuntimeCall[] = [];
  readonly spawned = new Set<string>();
  readonly stopped = new Set<string>();
  readonly networks = new Set<string>();
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
    // If the spawn asked for additional networks, record implicit
    // connects so tests can assert the topology.
    if (opts.additionalNetworks) {
      for (const n of opts.additionalNetworks) {
        this.calls.push({ kind: "connectNetwork", containerId: id, network: n });
      }
    }
    // Synthesize a deterministic IP per (container, network) pair so
    // tests can assert Dns wiring downstream.
    const networks: Record<string, string> = {};
    const primary = opts.network;
    if (primary) networks[primary] = `10.0.${this.counter}.1`;
    for (const n of opts.additionalNetworks ?? []) {
      networks[n] = `10.0.${this.counter}.2`;
    }
    return {
      id,
      name: `name_${this.counter}`,
      baseUrl: `http://${id}:18789`,
      token: `tok_${this.counter}`,
      networks: Object.keys(networks).length > 0 ? networks : undefined,
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

  async ensureNetwork(name: string, opts?: { internal?: boolean }): Promise<void> {
    this.calls.push({
      kind: "ensureNetwork",
      network: name,
      internal: opts?.internal ?? false,
    });
    this.networks.add(name);
  }

  async removeNetwork(name: string): Promise<void> {
    this.calls.push({ kind: "removeNetwork", network: name });
    this.networks.delete(name);
  }

  async connectNetwork(containerId: string, network: string): Promise<void> {
    this.calls.push({ kind: "connectNetwork", containerId, network });
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

// --------------------------------------------------------------------
// networking: limited — per-session confined topology
// --------------------------------------------------------------------

function makeLimitedPool(overrides: Partial<PoolConfig> = {}): {
  pool: SessionContainerPool;
  runtime: FakeRuntime;
} {
  return makePool({
    limitedNetworking: {
      sidecarImage: "ghcr.io/stainlu/openclaw-managed-agents-egress-proxy:test",
      controlPlaneNetwork: "openclaw-control-plane",
    },
    ...overrides,
  });
}

describe("SessionContainerPool — networking: limited", () => {
  it("spawns the sidecar first, then the agent, on the confined network", async () => {
    const { pool, runtime } = makeLimitedPool();
    const c = await pool.acquireForSession({
      sessionId: "ses_confined123",
      spawnOptions: baseSpawnOptions(),
      networking: { type: "limited", allowedHosts: ["api.example.com"] },
    });
    expect(c.id).toBe("cnt_2"); // sidecar = cnt_1, agent = cnt_2

    // Two networks were created: confined (internal) + egress (not internal).
    const netCreates = runtime.calls.filter((c) => c.kind === "ensureNetwork");
    expect(netCreates).toHaveLength(2);
    const confined = netCreates.find((c) =>
      c.kind === "ensureNetwork" && c.network.endsWith("-confined"),
    );
    const egress = netCreates.find((c) =>
      c.kind === "ensureNetwork" && c.network.endsWith("-egress"),
    );
    expect(confined?.kind === "ensureNetwork" ? confined.internal : false).toBe(
      true,
    );
    expect(egress?.kind === "ensureNetwork" ? egress.internal : true).toBe(false);

    // Order: both networks, then sidecar spawn, then agent spawn.
    const spawns = runtime.calls.filter((c) => c.kind === "spawn");
    expect(spawns).toHaveLength(2);
    // First spawn is the sidecar (image matches limitedNetworking.sidecarImage).
    expect(
      spawns[0].kind === "spawn" ? spawns[0].opts.image : "",
    ).toContain("egress-proxy");
    // Second spawn is the agent on the confined network.
    expect(
      spawns[1].kind === "spawn" ? spawns[1].opts.network ?? "" : "",
    ).toMatch(/-confined$/);
  });

  it("passes the allowlist to the sidecar via OPENCLAW_EGRESS_ALLOWED_HOSTS", async () => {
    const { pool, runtime } = makeLimitedPool();
    await pool.acquireForSession({
      sessionId: "ses_ax1",
      spawnOptions: baseSpawnOptions(),
      networking: {
        type: "limited",
        allowedHosts: ["api.openai.com", "*.googleapis.com"],
      },
    });
    const sidecarSpawn = runtime.calls.find(
      (c) => c.kind === "spawn" && c.opts.image.includes("egress-proxy"),
    );
    if (sidecarSpawn?.kind !== "spawn") throw new Error("sidecar not spawned");
    const allowedRaw = sidecarSpawn.opts.env["OPENCLAW_EGRESS_ALLOWED_HOSTS"];
    expect(JSON.parse(allowedRaw ?? "[]")).toEqual([
      "api.openai.com",
      "*.googleapis.com",
    ]);
    // Session id flows through for log correlation.
    expect(sidecarSpawn.opts.env["OPENCLAW_EGRESS_SESSION_ID"]).toBe("ses_ax1");
  });

  it("wires HTTP_PROXY + control-plane network on the agent", async () => {
    const { pool, runtime } = makeLimitedPool();
    await pool.acquireForSession({
      sessionId: "ses_wire",
      spawnOptions: baseSpawnOptions(),
      networking: { type: "limited", allowedHosts: ["api.example.com"] },
    });
    const agentSpawn = runtime.calls.filter((c) => c.kind === "spawn")[1];
    if (agentSpawn?.kind !== "spawn") throw new Error("agent not spawned");
    expect(agentSpawn.opts.env["HTTP_PROXY"]).toMatch(/^http:\/\/openclaw-sess-.*-proxy:8118$/);
    expect(agentSpawn.opts.env["HTTPS_PROXY"]).toMatch(/^http:\/\/openclaw-sess-.*-proxy:8118$/);
    expect(agentSpawn.opts.env["NO_PROXY"]).toContain("openclaw-orchestrator");
    expect(agentSpawn.opts.additionalNetworks).toEqual(["openclaw-control-plane"]);
    expect(agentSpawn.opts.network).toMatch(/-confined$/);
  });

  it("wires agent's Dns to the sidecar's IP on the confined network", async () => {
    // Without this, a caller inside the agent that bypasses HTTP_PROXY
    // (raw socket.connect / getaddrinfo) would resolve against Docker's
    // embedded DNS, not our filter. Dns config writes the sidecar's IP
    // into /etc/resolv.conf so every name lookup hits the sidecar's
    // UDP 53 allowlist.
    const { pool, runtime } = makeLimitedPool();
    await pool.acquireForSession({
      sessionId: "ses_dns",
      spawnOptions: baseSpawnOptions(),
      networking: { type: "limited", allowedHosts: ["api.example.com"] },
    });
    const [sidecarSpawn, agentSpawn] = runtime.calls.filter(
      (c) => c.kind === "spawn",
    );
    if (sidecarSpawn?.kind !== "spawn" || agentSpawn?.kind !== "spawn") {
      throw new Error("expected two spawns");
    }
    const confinedName = sidecarSpawn.opts.network!;
    // FakeRuntime synthesizes a stable per-network IP; the pool reads
    // the sidecar's confined-network IP and passes it as agent Dns.
    const sidecarIp =
      agentSpawn.opts.network === confinedName
        ? `10.0.1.1` // sidecar was cnt_1, confined is its primary network
        : undefined;
    expect(agentSpawn.opts.dns).toEqual([sidecarIp]);
  });

  it("doesn't truncate the session id — two long ids with a shared prefix get distinct networks", async () => {
    // Before the fix, slice(0, 12) truncated the id. Two sessions
    // starting with the same 12-char prefix would share a sidecar and
    // confined network — silent collapse, not confinement.
    const { pool, runtime } = makeLimitedPool();
    await pool.acquireForSession({
      sessionId: "ses_abcdef12345xyz",
      spawnOptions: baseSpawnOptions(),
      networking: { type: "limited", allowedHosts: ["api.example.com"] },
    });
    await pool.acquireForSession({
      sessionId: "ses_abcdef12345wwx",
      spawnOptions: baseSpawnOptions(),
      networking: { type: "limited", allowedHosts: ["api.example.com"] },
    });
    const networks = runtime.calls
      .filter((c) => c.kind === "ensureNetwork")
      .map((c) => (c.kind === "ensureNetwork" ? c.network : ""));
    // Four networks total — two per session, no deduplication.
    expect(new Set(networks).size).toBe(4);
    await pool.shutdown();
  });

  it("rolls back sidecar + networks when the agent spawn fails", async () => {
    // readyShouldFail causes waitForReady() for BOTH sidecar and agent
    // to throw. The sidecar waitForReady is the first ready check; if
    // that fails we should stop the sidecar and drop both networks,
    // and never spawn the agent.
    const { pool, runtime } = makeLimitedPool();
    runtime.readyShouldFail = true;
    await expect(
      pool.acquireForSession({
        sessionId: "ses_rollback",
        spawnOptions: baseSpawnOptions(),
        networking: { type: "limited", allowedHosts: ["api.example.com"] },
      }),
    ).rejects.toThrow();
    // Sidecar was stopped on the rollback path.
    expect(runtime.stopped.has("cnt_1")).toBe(true);
    // Both networks were removed.
    const removals = runtime.calls.filter((c) => c.kind === "removeNetwork");
    expect(removals).toHaveLength(2);
    // No live entry in the pool for this session.
    expect(pool.snapshot().find((e) => e.sessionId === "ses_rollback")).toBeUndefined();
  });

  it("throws cleanly if limited networking is requested without config", async () => {
    // Pool without limitedNetworking config. Requesting a limited
    // session must fail with a clear error rather than silently
    // falling back to an unrestricted spawn.
    const { pool } = makePool();
    await expect(
      pool.acquireForSession({
        sessionId: "ses_missing",
        spawnOptions: baseSpawnOptions(),
        networking: { type: "limited", allowedHosts: ["api.example.com"] },
      }),
    ).rejects.toThrow(/limitedNetworking/);
  });

  it("evict tears down the whole group (agent + sidecar + per-session networks)", async () => {
    const { pool, runtime } = makeLimitedPool();
    await pool.acquireForSession({
      sessionId: "ses_evict",
      spawnOptions: baseSpawnOptions(),
      networking: { type: "limited", allowedHosts: ["api.example.com"] },
    });
    await pool.evictSession("ses_evict");
    // Both the agent (cnt_2) and sidecar (cnt_1) were stopped.
    expect(runtime.stopped.has("cnt_1")).toBe(true);
    expect(runtime.stopped.has("cnt_2")).toBe(true);
    // Both per-session networks were removed.
    const removals = runtime.calls.filter((c) => c.kind === "removeNetwork");
    expect(removals).toHaveLength(2);
    expect(pool.snapshot()).toHaveLength(0);
    await pool.shutdown();
  });

  it("reapIdle cleans up the sidecar + networks alongside an idled agent", async () => {
    const { pool, runtime } = makeLimitedPool({ idleTimeoutMs: 50 });
    await pool.acquireForSession({
      sessionId: "ses_reap",
      spawnOptions: baseSpawnOptions(),
      networking: { type: "limited", allowedHosts: ["api.example.com"] },
    });
    await new Promise((r) => setTimeout(r, 80));
    // @ts-expect-error — private reapIdle
    await pool.reapIdle();
    expect(runtime.stopped.has("cnt_1")).toBe(true); // sidecar
    expect(runtime.stopped.has("cnt_2")).toBe(true); // agent
    expect(runtime.calls.filter((c) => c.kind === "removeNetwork")).toHaveLength(2);
    await pool.shutdown();
  });

  it("does NOT consult the warm pool for limited sessions", async () => {
    // Warm containers boot on the default network, which has external
    // egress. Claiming one for a limited session would defeat the
    // whole point. Verify that pre-warmed containers for the same
    // agent id are NOT claimed when the session is limited.
    const { pool, runtime } = makeLimitedPool();
    await pool.warmForAgent("agt_x", baseSpawnOptions()); // cnt_1 warm
    const spawnsBefore = runtime.calls.filter((c) => c.kind === "spawn").length;
    await pool.acquireForSession({
      sessionId: "ses_limited_not_warm",
      spawnOptions: baseSpawnOptions(),
      agentId: "agt_x",
      networking: { type: "limited", allowedHosts: ["api.example.com"] },
    });
    const spawnsAfter = runtime.calls.filter((c) => c.kind === "spawn").length;
    // Warm container wasn't claimed — we spawned a fresh sidecar AND
    // agent (+2 spawns), not just an agent (+1).
    expect(spawnsAfter - spawnsBefore).toBe(2);
    await pool.shutdown();
  });
});
