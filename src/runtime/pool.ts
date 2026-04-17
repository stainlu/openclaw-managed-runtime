import { getLogger } from "../log.js";
import {
  poolAcquireTotal,
  poolActiveContainers,
  poolSpawnDurationSeconds,
  poolWarmContainers,
} from "../metrics.js";
import type {
  Container,
  ContainerRuntime,
  NetworkingSpec,
  SpawnOptions,
} from "./container.js";
import { GatewayWebSocketClient, GatewayWsError } from "./gateway-ws.js";

const log = getLogger("pool");

// Per-session container lifecycle pool.
//
// Before Item 4, every event spawned a fresh container and tore it down at
// the end of the run — a ~15s startup tax on every turn. This pool keeps the
// container alive between turns for the same session, so only the first
// event pays spawn time. An idle sweeper reaps containers that have been
// unused for longer than the configured threshold; the next event for that
// session respawns a fresh container and OpenClaw's SessionManager rebuilds
// the Pi AgentSession from the JSONL on the host mount.
//
// Item 7 added a GatewayWebSocketClient to each live container. After the
// HTTP /readyz check succeeds, the pool also opens a WebSocket to the
// gateway's control plane and runs the operator handshake. The router uses
// that WS client to issue cancel / steer / patch operations against the
// running session; the WS lifetime mirrors the container lifetime.
//
// The pool is in-memory only. On orchestrator restart the pool is empty;
// any containers that outlived the prior process are reaped at startup by
// DockerContainerRuntime.cleanupOrphaned(). See src/index.ts.

export type PoolConfig = {
  /** Milliseconds a container may sit unused before the sweeper reaps it. */
  idleTimeoutMs: number;
  /** Max time to wait for container /readyz on spawn. */
  readyTimeoutMs: number;
  /** How often the sweeper runs. Should be less than idleTimeoutMs / 2. */
  sweepIntervalMs: number;
  /**
   * Maximum number of pre-warmed containers that can sit in the warm pool
   * simultaneously. When `warmForAgent` would exceed this cap, the oldest
   * warm container (by spawnedAt) is reaped first to make room. Unbounded
   * pre-warming was the default before this; on a host with many distinct
   * agent templates that was an unbounded resource leak (N agents → N
   * warm containers at 2 GiB each).
   */
  maxWarmContainers: number;
  /**
   * Milliseconds a pre-warmed container can sit unclaimed before the
   * sweeper reaps it. Unlike active containers (which track lastUsedAt),
   * warm containers are scored on spawnedAt — if nobody has claimed it
   * within this window, something upstream is off and we'd rather give
   * the RAM back than hold it forever.
   */
  warmIdleTimeoutMs: number;
  /**
   * Predicate that returns true if the named session currently has a run in
   * flight. The sweeper uses this to avoid tearing down a container that is
   * about to be used again. The caller closes over its session store to
   * provide the predicate; the pool itself has no dependency on any store,
   * which keeps the runtime layer decoupled from the orchestrator layer.
   */
  isBusy: (sessionId: string) => boolean;
  /**
   * Optional callback invoked AFTER a container is reaped by the idle
   * sweeper. Intended for ephemeral session cleanup: index.ts wires this
   * to delete the Pi JSONL and session store row when the reaped session
   * was flagged `ephemeral` (e.g., created by a keyless POST /v1/chat/completions).
   *
   * Deliberately NOT called from manual `evictSession` (e.g., cancel) or
   * `shutdown` paths — those preserve session data for inspection or
   * graceful restart. The pool stays agnostic: it passes the sessionId
   * and lets the caller decide what to clean up.
   */
  cleanupOnReap?: (sessionId: string) => Promise<void>;
  /**
   * Config for `networking: limited` sessions. When this is unset,
   * limited networking is effectively disabled (schema still accepts
   * it but spawn will throw). In practice, index.ts always wires this
   * in production — tests can opt out by omitting it.
   */
  limitedNetworking?: {
    /** Image reference for the egress-proxy sidecar. */
    sidecarImage: string;
    /**
     * Internal Docker network carrying orchestrator ↔ limited-agent
     * traffic. Must exist and be marked internal before the pool
     * spawns any limited-networking session.
     */
    controlPlaneNetwork: string;
    /** DNS port the proxy sidecar listens on. Default 53. */
    proxyDnsPort?: number;
    /** HTTP proxy port on the sidecar. Default 8118. */
    proxyHttpPort?: number;
    /** Healthz port on the sidecar. Default 8119. */
    proxyHealthzPort?: number;
  };
};

type ActiveContainer = {
  sessionId: string;
  container: Container;
  /** Operator-role WS client for control-plane calls (abort/steer/patch). */
  wsClient: GatewayWebSocketClient;
  spawnedAt: number;
  lastUsedAt: number;
  /**
   * Resources that belong to this session ONLY and must be cleaned up
   * when the session's container is evicted. Populated only for
   * `networking: limited` sessions.
   */
  ownedResources?: {
    /** Egress-proxy sidecar container. Stop alongside the agent. */
    sidecar: Container;
    /** Per-session Docker networks. Remove after both containers stop. */
    networks: string[];
  };
};

/** A pre-warmed container waiting to be claimed by a session. */
type WarmContainer = {
  agentId: string;
  container: Container;
  wsClient: GatewayWebSocketClient;
  spawnOptions: SpawnOptions;
  spawnedAt: number;
};

export class SessionContainerPool {
  private readonly active = new Map<string, ActiveContainer>();
  private readonly pending = new Map<string, Promise<Container>>();
  /** Pre-warmed containers keyed by agentId, waiting to be claimed. */
  private readonly warm = new Map<string, WarmContainer>();
  private sweeperHandle: NodeJS.Timeout | undefined;

  constructor(
    private readonly runtime: ContainerRuntime,
    private readonly cfg: PoolConfig,
  ) {
    this.sweeperHandle = setInterval(() => {
      void this.reapIdle().catch((err) => {
        log.warn({ err }, "reapIdle error");
      });
    }, cfg.sweepIntervalMs);
    // Don't keep the event loop alive just for the sweeper — if nothing else
    // is pending, the process should still be able to exit.
    this.sweeperHandle.unref();
  }

  /**
   * Pre-warm a container for an agent template. The container boots fully
   * (spawn + /readyz + WS handshake) and waits in the warm bucket until
   * claimed by a session via acquireForSession(). Fire-and-forget — the
   * caller does not wait for completion. Silently no-ops if a warm
   * container already exists for this agent.
   *
   * When the warm pool is at `maxWarmContainers`, the oldest warm entry
   * (by spawnedAt) is evicted before adding the new one. Keeps the warm
   * pool bounded so that a host with many agent templates doesn't
   * accumulate one persistent 2 GiB container per template.
   */
  async warmForAgent(agentId: string, spawnOptions: SpawnOptions): Promise<void> {
    if (this.warm.has(agentId)) return;
    await this.evictOldestWarmIfAtCap();
    const container = await this.runtime.spawn(spawnOptions);
    try {
      await this.runtime.waitForReady(container, this.cfg.readyTimeoutMs);
    } catch (err) {
      await this.runtime.stop(container.id).catch(() => { /* best-effort */ });
      throw err;
    }
    const wsClient = new GatewayWebSocketClient({
      baseUrl: container.baseUrl,
      token: container.token,
      clientName: "openclaw-managed-agents",
    });
    try {
      await wsClient.connect();
    } catch (err) {
      await wsClient.close().catch(() => { /* best-effort */ });
      await this.runtime.stop(container.id).catch(() => { /* best-effort */ });
      throw err;
    }
    this.warm.set(agentId, {
      agentId,
      container,
      wsClient,
      spawnOptions,
      spawnedAt: Date.now(),
    });
    poolWarmContainers.set(this.warm.size);
    log.info({ agent_id: agentId }, "pre-warmed container for agent");
  }

  /**
   * Get a ready container for the given session. Checks three sources in
   * order: (1) existing active container for this session, (2) pre-warmed
   * container matching the agent, (3) fresh spawn. Bumps lastUsedAt.
   */
  async acquireForSession(args: {
    sessionId: string;
    spawnOptions: SpawnOptions;
    /** Agent ID for warm-pool matching. */
    agentId?: string;
    /**
     * Per-session networking policy. Unset or {type:"unrestricted"}
     * uses the legacy single-network path. {type:"limited"} spawns an
     * egress-proxy sidecar on per-session networks and confines the
     * agent to them.
     */
    networking?: NetworkingSpec;
  }): Promise<Container> {
    const existing = this.active.get(args.sessionId);
    if (existing) {
      existing.lastUsedAt = Date.now();
      poolAcquireTotal.labels({ source: "active" }).inc();
      return existing.container;
    }

    // Limited networking forks off to its own spawn path — warm pool
    // reuse doesn't apply (the per-session confined network + sidecar
    // are minted fresh per session).
    if (args.networking?.type === "limited") {
      return await this.doLimitedSpawn({
        sessionId: args.sessionId,
        spawnOptions: args.spawnOptions,
        allowedHosts: args.networking.allowedHosts,
      });
    }

    // Check the warm pool for a matching pre-warmed container.
    if (args.agentId) {
      const warmEntry = this.warm.get(args.agentId);
      if (warmEntry) {
        this.warm.delete(args.agentId);
        poolWarmContainers.set(this.warm.size);
        const now = Date.now();
        this.active.set(args.sessionId, {
          sessionId: args.sessionId,
          container: warmEntry.container,
          wsClient: warmEntry.wsClient,
          spawnedAt: warmEntry.spawnedAt,
          lastUsedAt: now,
        });
        poolActiveContainers.set(this.active.size);
        poolAcquireTotal.labels({ source: "warm" }).inc();
        log.info(
          { session_id: args.sessionId, agent_id: args.agentId },
          "claimed pre-warmed container",
        );
        // Replenish the warm pool in the background.
        void this.warmForAgent(args.agentId, warmEntry.spawnOptions).catch((err) => {
          log.warn({ err, agent_id: args.agentId }, "warm-pool replenish failed");
        });
        return warmEntry.container;
      }
    }

    // Deduplicate concurrent spawns for the same session. If a background
    // warm-up (triggered at session-create time) is already in progress,
    // wait for it rather than spawning a second container.
    const inflight = this.pending.get(args.sessionId);
    if (inflight) return inflight;

    const spawnPromise = this.doSpawn(args);
    this.pending.set(args.sessionId, spawnPromise);
    try {
      return await spawnPromise;
    } finally {
      this.pending.delete(args.sessionId);
    }
  }

  private async doSpawn(args: {
    sessionId: string;
    spawnOptions: SpawnOptions;
  }): Promise<Container> {
    const spawnEnd = poolSpawnDurationSeconds.startTimer();
    const container = await this.runtime.spawn(args.spawnOptions);
    try {
      await this.runtime.waitForReady(container, this.cfg.readyTimeoutMs);
    } catch (err) {
      await this.runtime.stop(container.id).catch(() => {
        /* best-effort */
      });
      throw err;
    }

    const wsClient = new GatewayWebSocketClient({
      baseUrl: container.baseUrl,
      token: container.token,
      clientName: "openclaw-managed-agents",
    });
    try {
      await wsClient.connect();
    } catch (err) {
      await wsClient.close().catch(() => {
        /* best-effort */
      });
      await this.runtime.stop(container.id).catch(() => {
        /* best-effort */
      });
      const code = err instanceof GatewayWsError ? err.code : "ws_connect_failed";
      const msg = err instanceof Error ? err.message : String(err);
      throw new GatewayWsError(code, `gateway ws handshake failed: ${msg}`);
    }

    const now = Date.now();
    this.active.set(args.sessionId, {
      sessionId: args.sessionId,
      container,
      wsClient,
      spawnedAt: now,
      lastUsedAt: now,
    });
    poolActiveContainers.set(this.active.size);
    poolAcquireTotal.labels({ source: "spawn" }).inc();
    spawnEnd();
    return container;
  }

  /**
   * Spawn path for `networking: limited` sessions. Topology:
   *
   *   - Two per-session networks are created fresh:
   *     `openclaw-sess-<sid>-confined` (--internal, no egress) and
   *     `openclaw-sess-<sid>-egress` (normal bridge, external egress).
   *   - Egress-proxy sidecar spawns on the confined network and is
   *     connected to the egress network after boot. Receives HTTP+DNS
   *     on the confined side, forwards allowed traffic out the egress
   *     side.
   *   - Agent spawns on the confined network, is additionally connected
   *     to the orchestrator's internal control-plane network so the
   *     orchestrator can still reach its gateway for WS + /readyz.
   *     The confined network has no external egress, and the control-
   *     plane network is also internal — so the agent has no direct
   *     path to the internet. The sidecar is the only route out.
   *   - Agent env gets HTTP_PROXY/HTTPS_PROXY pointing at the sidecar's
   *     confined-side address. HTTP/HTTPS clients (`fetch`, `requests`,
   *     `curl`) route through it automatically. Raw `socket.connect()`
   *     calls from inside the agent can't leave either because no
   *     network attached to the agent has external egress.
   *
   * On any failure, every resource created so far is torn down before
   * the throw so the caller doesn't have to.
   */
  private async doLimitedSpawn(args: {
    sessionId: string;
    spawnOptions: SpawnOptions;
    allowedHosts: string[];
  }): Promise<Container> {
    if (!this.cfg.limitedNetworking) {
      throw new Error(
        "networking: limited requested but pool was not configured with limitedNetworking; " +
          "wire cfg.limitedNetworking in index.ts before spawning a confined session",
      );
    }
    const netCfg = this.cfg.limitedNetworking;
    const spawnEnd = poolSpawnDurationSeconds.startTimer();

    const shortId = args.sessionId.replace(/^ses_/, "").slice(0, 12);
    const confinedNet = `openclaw-sess-${shortId}-confined`;
    const egressNet = `openclaw-sess-${shortId}-egress`;
    const sidecarName = `openclaw-sess-${shortId}-proxy`;
    const dnsPort = netCfg.proxyDnsPort ?? 53;
    const httpPort = netCfg.proxyHttpPort ?? 8118;
    const healthzPort = netCfg.proxyHealthzPort ?? 8119;

    /** Tracks what we've already created so the error path can undo it. */
    const created = {
      confinedNet: false,
      egressNet: false,
      sidecar: undefined as Container | undefined,
      sidecarWs: undefined as undefined,
      agent: undefined as Container | undefined,
      agentWs: undefined as GatewayWebSocketClient | undefined,
    };

    const rollback = async (err: unknown): Promise<never> => {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.warn(
        { err: errMsg, session_id: args.sessionId },
        "limited-spawn failed — rolling back",
      );
      if (created.agentWs) {
        await created.agentWs.close().catch(() => {});
      }
      if (created.agent) {
        await this.runtime.stop(created.agent.id).catch(() => {});
      }
      if (created.sidecar) {
        await this.runtime.stop(created.sidecar.id).catch(() => {});
      }
      if (created.confinedNet) {
        await this.runtime.removeNetwork(confinedNet).catch(() => {});
      }
      if (created.egressNet) {
        await this.runtime.removeNetwork(egressNet).catch(() => {});
      }
      throw err instanceof Error ? err : new Error(errMsg);
    };

    try {
      // 1. Per-session networks.
      await this.runtime.ensureNetwork(confinedNet, { internal: true });
      created.confinedNet = true;
      await this.runtime.ensureNetwork(egressNet, { internal: false });
      created.egressNet = true;

      // 2. Egress-proxy sidecar — spawn on confined (so the agent can
      //    reach it), additionally connect to egress (for the forward
      //    path out). Allowed hosts delivered via env as a JSON array,
      //    matching the schema proxy.mjs expects.
      const sidecar = await this.runtime.spawn({
        image: netCfg.sidecarImage,
        name: sidecarName,
        containerPort: httpPort,
        network: confinedNet,
        additionalNetworks: [egressNet],
        mounts: [],
        env: {
          OPENCLAW_EGRESS_ALLOWED_HOSTS: JSON.stringify(args.allowedHosts),
          OPENCLAW_EGRESS_SESSION_ID: args.sessionId,
          OPENCLAW_EGRESS_HTTP_PORT: String(httpPort),
          OPENCLAW_EGRESS_HEALTHZ_PORT: String(healthzPort),
          OPENCLAW_EGRESS_DNS_PORT: String(dnsPort),
        },
        labels: {
          "managed-by": "openclaw-managed-agents",
          "openclaw-role": "egress-proxy",
          "openclaw-session-id": args.sessionId,
        },
      });
      created.sidecar = sidecar;
      // Poll the sidecar's healthz. waitForReady already hits /readyz
      // but the egress-proxy serves /healthz on a different port; we
      // synthesize a Container pointing at that port so the existing
      // helper works.
      await this.runtime.waitForReady(
        {
          ...sidecar,
          baseUrl: `http://${sidecar.name}:${healthzPort}`,
        },
        this.cfg.readyTimeoutMs,
      );

      // 3. Agent container: boot on confined network, then attach to
      //    control-plane so the orchestrator can reach its gateway.
      //    HTTP_PROXY/HTTPS_PROXY points at the sidecar's confined
      //    address; NO_PROXY excludes localhost + the orchestrator
      //    (we reach the orchestrator via control-plane, no proxy
      //    needed). Docker's embedded resolver on the confined
      //    network won't route DNS queries to the sidecar
      //    automatically; the agent image's entrypoint / glibc
      //    handles this by reading resolv.conf, which Docker sets
      //    from the network config. Wire below.
      const agentEnv: Record<string, string> = {
        ...args.spawnOptions.env,
        HTTP_PROXY: `http://${sidecarName}:${httpPort}`,
        HTTPS_PROXY: `http://${sidecarName}:${httpPort}`,
        http_proxy: `http://${sidecarName}:${httpPort}`,
        https_proxy: `http://${sidecarName}:${httpPort}`,
        NO_PROXY: "localhost,127.0.0.1,openclaw-orchestrator",
        no_proxy: "localhost,127.0.0.1,openclaw-orchestrator",
      };
      const agent = await this.runtime.spawn({
        ...args.spawnOptions,
        env: agentEnv,
        network: confinedNet,
        additionalNetworks: [netCfg.controlPlaneNetwork],
      });
      created.agent = agent;
      await this.runtime.waitForReady(agent, this.cfg.readyTimeoutMs);

      // 4. WS handshake from the orchestrator over the control-plane
      //    network. The agent's container name is reachable on both
      //    confined and control-plane; the orchestrator is only on
      //    control-plane, so traffic flows through there.
      const wsClient = new GatewayWebSocketClient({
        baseUrl: agent.baseUrl,
        token: agent.token,
        clientName: "openclaw-managed-agents",
      });
      try {
        await wsClient.connect();
        created.agentWs = wsClient;
      } catch (err) {
        await wsClient.close().catch(() => {});
        const code = err instanceof GatewayWsError ? err.code : "ws_connect_failed";
        const msg = err instanceof Error ? err.message : String(err);
        throw new GatewayWsError(
          code,
          `gateway ws handshake failed (limited session): ${msg}`,
        );
      }

      const now = Date.now();
      this.active.set(args.sessionId, {
        sessionId: args.sessionId,
        container: agent,
        wsClient,
        spawnedAt: now,
        lastUsedAt: now,
        ownedResources: {
          sidecar,
          networks: [confinedNet, egressNet],
        },
      });
      poolActiveContainers.set(this.active.size);
      poolAcquireTotal.labels({ source: "spawn" }).inc();
      spawnEnd();
      log.info(
        {
          session_id: args.sessionId,
          confined_network: confinedNet,
          egress_network: egressNet,
          allowed_hosts: args.allowedHosts.length,
        },
        "spawned limited-networking session",
      );
      return agent;
    } catch (err) {
      await rollback(err);
      // rollback always throws, but TS needs a return.
      throw err;
    }
  }

  /**
   * Get the operator-role WS client for an active session, if one exists.
   * Returns undefined when the session has no live container in the pool
   * (e.g., it was reaped by the idle sweeper or was never acquired).
   */
  getWsClient(sessionId: string): GatewayWebSocketClient | undefined {
    return this.active.get(sessionId)?.wsClient;
  }

  /** Touch the lastUsedAt timestamp for a session so the sweeper doesn't reap it. */
  touchSession(sessionId: string): void {
    const entry = this.active.get(sessionId);
    if (entry) entry.lastUsedAt = Date.now();
  }

  /**
   * Force-evict any container attached to this session. Called by the router
   * after a failed run (the container might be unhealthy) and by
   * DELETE /v1/sessions/:id. No-op if the session has no live container.
   */
  async evictSession(sessionId: string): Promise<void> {
    const entry = this.active.get(sessionId);
    if (!entry) return;
    this.active.delete(sessionId);
    poolActiveContainers.set(this.active.size);
    await entry.wsClient.close().catch(() => {
      /* best-effort */
    });
    await this.runtime.stop(entry.container.id).catch((err) => {
      log.warn({ err, container_id: entry.container.id }, "pool stop failed");
    });
    // Tear down limited-networking resources owned by this session.
    // Agent must be stopped FIRST (above) so the sidecar + networks
    // have no attached containers when we remove them.
    if (entry.ownedResources) {
      const owned = entry.ownedResources;
      await this.runtime.stop(owned.sidecar.id).catch((err) => {
        log.warn(
          { err, container_id: owned.sidecar.id },
          "sidecar stop failed during evict",
        );
      });
      for (const net of owned.networks) {
        await this.runtime.removeNetwork(net).catch((err) => {
          log.warn({ err, network: net }, "per-session network remove failed");
        });
      }
    }
  }

  /** Snapshot of the pool for observability/logging. Not a hot path. */
  snapshot(): Array<{ sessionId: string; spawnedAt: number; lastUsedAt: number }> {
    return Array.from(this.active.values()).map((e) => ({
      sessionId: e.sessionId,
      spawnedAt: e.spawnedAt,
      lastUsedAt: e.lastUsedAt,
    }));
  }

  /**
   * Stop the sweeper and tear down every active container. Best-effort:
   * errors are swallowed so shutdown is not blocked by a single stuck stop.
   */
  async shutdown(): Promise<void> {
    if (this.sweeperHandle) {
      clearInterval(this.sweeperHandle);
      this.sweeperHandle = undefined;
    }
    const entries = Array.from(this.active.values());
    const warmEntries = Array.from(this.warm.values());
    this.active.clear();
    this.warm.clear();
    // Close WS clients first so the agents see a clean disconnect.
    await Promise.allSettled([
      ...entries.map((e) => e.wsClient.close()),
      ...warmEntries.map((e) => e.wsClient.close()),
    ]);
    // Stop every container (agents + sidecars + warm).
    const containerIds = [
      ...entries.map((e) => e.container.id),
      ...entries.flatMap((e) =>
        e.ownedResources ? [e.ownedResources.sidecar.id] : [],
      ),
      ...warmEntries.map((e) => e.container.id),
    ];
    await Promise.allSettled(containerIds.map((id) => this.runtime.stop(id)));
    // Remove any per-session networks owned by limited-networking sessions.
    // Best-effort — Docker will GC lingering networks eventually anyway.
    const networksToRemove = entries.flatMap((e) =>
      e.ownedResources ? e.ownedResources.networks : [],
    );
    await Promise.allSettled(
      networksToRemove.map((n) => this.runtime.removeNetwork(n)),
    );
  }

  private async reapIdle(): Promise<void> {
    const now = Date.now();
    const threshold = now - this.cfg.idleTimeoutMs;
    // Snapshot the entries so we can mutate `this.active` while iterating.
    for (const entry of Array.from(this.active.values())) {
      if (entry.lastUsedAt >= threshold) continue;
      // Skip containers whose session currently has a run in flight. A tiny
      // race is possible (session flips to running between this check and
      // stop()); the cost is one wasted re-spawn on the next event, which
      // is acceptable for the MVP. A rigorous fix would need a per-session
      // lock, which is Item 7 scope (control endpoints) at the earliest.
      if (this.cfg.isBusy(entry.sessionId)) continue;
      this.active.delete(entry.sessionId);
      poolActiveContainers.set(this.active.size);
      const idleSec = Math.round((now - entry.lastUsedAt) / 1000);
      log.info(
        { session_id: entry.sessionId, idle_seconds: idleSec },
        "reaping idle container",
      );
      await entry.wsClient.close().catch(() => {
        /* best-effort */
      });
      await this.runtime.stop(entry.container.id).catch((err) => {
        log.warn({ err, container_id: entry.container.id }, "reap stop failed");
      });
      // Limited-networking sessions have per-session resources to drop
      // alongside the agent container. Stop sidecar first (it's still
      // attached to the per-session networks), then remove the networks.
      if (entry.ownedResources) {
        const owned = entry.ownedResources;
        await this.runtime.stop(owned.sidecar.id).catch((err) => {
          log.warn(
            { err, container_id: owned.sidecar.id },
            "sidecar reap stop failed",
          );
        });
        for (const net of owned.networks) {
          await this.runtime.removeNetwork(net).catch((err) => {
            log.warn({ err, network: net }, "per-session network reap failed");
          });
        }
      }
      // Notify the caller so it can clean up any per-session resources that
      // should NOT outlive the container. Item 8 uses this for ephemeral
      // session cleanup (delete Pi JSONL + SQLite row).
      if (this.cfg.cleanupOnReap) {
        try {
          await this.cfg.cleanupOnReap(entry.sessionId);
        } catch (err) {
          log.warn(
            { err, session_id: entry.sessionId },
            "cleanupOnReap failed",
          );
        }
      }
    }

    // Reap warm containers that have been sitting unclaimed longer than
    // warmIdleTimeoutMs. Measured on spawnedAt (warm entries have no
    // lastUsedAt — they haven't been used yet). If a warm container is
    // this old, the agent template is either rarely used or something
    // upstream is broken; either way, give the RAM back.
    const warmThreshold = now - this.cfg.warmIdleTimeoutMs;
    for (const entry of Array.from(this.warm.values())) {
      if (entry.spawnedAt >= warmThreshold) continue;
      await this.reapWarmEntry(entry, "idle");
    }
  }

  /**
   * When a new warmForAgent would push the warm pool over the cap,
   * evict the oldest warm entry first. LRU isn't quite the right model
   * here — warm entries aren't "used" until claimed — so we use "oldest
   * spawned first" as a reasonable proxy (likely least popular agent).
   */
  private async evictOldestWarmIfAtCap(): Promise<void> {
    if (this.warm.size < this.cfg.maxWarmContainers) return;
    let oldest: WarmContainer | undefined;
    for (const entry of this.warm.values()) {
      if (!oldest || entry.spawnedAt < oldest.spawnedAt) oldest = entry;
    }
    if (oldest) await this.reapWarmEntry(oldest, "cap-exceeded");
  }

  private async reapWarmEntry(
    entry: WarmContainer,
    reason: "idle" | "cap-exceeded",
  ): Promise<void> {
    this.warm.delete(entry.agentId);
    poolWarmContainers.set(this.warm.size);
    const ageSec = Math.round((Date.now() - entry.spawnedAt) / 1000);
    log.info(
      { agent_id: entry.agentId, reason, age_seconds: ageSec },
      "reaping warm container",
    );
    await entry.wsClient.close().catch(() => {
      /* best-effort */
    });
    await this.runtime.stop(entry.container.id).catch((err) => {
      log.warn(
        { err, container_id: entry.container.id },
        "warm reap stop failed",
      );
    });
  }
}
