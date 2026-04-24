import { createHash } from "node:crypto";
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
   * Invoked the instant a container becomes session-owned — either by
   * claiming a pre-warmed container or finishing a fresh spawn. The
   * orchestrator wires this to persist the session ↔ container mapping
   * into SessionContainerStore so that a subsequent orchestrator
   * restart can reattach instead of treating the container as an
   * orphan. Sync-void return signature: the pool does NOT await this
   * callback (the hot path is already serialized per-session through
   * `pending`, and blocking on a durability write here would stretch
   * pool_acquire_ms for no benefit — a crashed orchestrator that
   * failed to persist is equivalent to a lost container on reattach).
   */
  onContainerClaimed?: (args: {
    sessionId: string;
    agentId: string;
    container: Container;
    /**
     * Where the container came from. Used by the SessionContainerStore
     * persister so sessionResponse() can surface the pool_source on the
     * public API (and so the inspector's "boot 4.1s · cold" sub-label
     * isn't always a lie).
     */
    source: "cold" | "warm" | "limited" | "adopt";
    /**
     * Wall-clock milliseconds the pool spent on the acquire. 0 for
     * warm-reuse (instant), null for adopt (we didn't spawn it), full
     * spawn duration for cold / limited.
     */
    bootMs: number | null;
  }) => void;
  /**
   * Invoked after the pool releases a container back to the
   * not-a-session state: idle-sweeper reap, explicit evictSession
   * (cancel), or spawn failure rollback. Used to drop the persistent
   * mapping so adoption doesn't resurrect a dead session on the next
   * restart.
   */
  onContainerReleased?: (sessionId: string) => void;
  /**
   * Invoked when a warm container is claimed by a session. The pool
   * passes the warm mount's host path and the session ID so the caller
   * can rename the workspace directory from its warm-key location to
   * the session's permanent location. The bind mount follows the inode
   * — the container doesn't notice.
   */
  renameWorkspaceOnClaim?: (warmHostPath: string, sessionId: string) => void;
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
  /** Fingerprint of the boot-time config baked into this container. */
  configSignature: string;
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
  configSignature: string;
  spawnedAt: number;
};

function stableSortRecord(
  input: Record<string, string>,
  opts?: { exclude?: string[] },
): Record<string, string> {
  const exclude = new Set(opts?.exclude ?? []);
  return Object.fromEntries(
    Object.entries(input)
      .filter(([key]) => !exclude.has(key))
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

function normalizeNetworkingSpec(
  spec: NetworkingSpec | undefined,
): Record<string, unknown> | null {
  if (!spec) return null;
  if (spec.type === "unrestricted") {
    return { type: "unrestricted" };
  }
  return {
    type: "limited",
    allowedHosts: [...spec.allowedHosts].sort(),
    allowMcpServers: Boolean(spec.allowMcpServers),
    allowPackageManagers: Boolean(spec.allowPackageManagers),
  };
}

export function buildContainerConfigSignature(args: {
  spawnOptions: SpawnOptions;
  networking?: NetworkingSpec;
}): string {
  const normalized = {
    image: args.spawnOptions.image,
    env: stableSortRecord(args.spawnOptions.env, {
      exclude: [
        "OPENCLAW_GATEWAY_TOKEN",
        "OPENCLAW_ORCHESTRATOR_TOKEN",
      ],
    }),
    mounts: args.spawnOptions.mounts.map((mount) => ({
      containerPath: mount.containerPath,
      readOnly: Boolean(mount.readOnly),
    })),
    containerPort: args.spawnOptions.containerPort,
    network: args.spawnOptions.network ?? null,
    additionalNetworks: [...(args.spawnOptions.additionalNetworks ?? [])].sort(),
    dns: [...(args.spawnOptions.dns ?? [])].sort(),
    labels: stableSortRecord(args.spawnOptions.labels ?? {}, {
      exclude: [
        "orchestrator-session-id",
      ],
    }),
    networking: normalizeNetworkingSpec(args.networking),
  };
  return createHash("sha256")
    .update(JSON.stringify(normalized))
    .digest("hex")
    .slice(0, 16);
}

export class SessionContainerPool {
  private readonly active = new Map<string, ActiveContainer>();
  private readonly pending = new Map<string, Promise<Container>>();
  /** Pre-warmed containers keyed by agentId, waiting to be claimed. */
  private readonly warm = new Map<string, WarmContainer>();
  /**
   * Inflight speculative warm promises keyed by agentId. Used only to
   * dedupe concurrent template-level `warmForAgent()` calls with each
   * other. Real session acquires must not wait on this map — warming is
   * best-effort and outside the user's critical path.
   */
  private readonly pendingByAgent = new Map<
    string,
    { configSignature: string; promise: Promise<void> }
  >();
  private readonly desiredWarmSignature = new Map<string, string>();
  private sweeperHandle: NodeJS.Timeout | undefined;

  constructor(
    readonly runtime: ContainerRuntime,
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
    // warm-pool disabled → every warm path is a no-op. Applies to
    // startup warming, agent-create warming, session-create warming,
    // and post-claim replenishment. The session still works; the
    // first event just pays cold-spawn latency. Default for local
    // dev; production deploys override via OPENCLAW_MAX_WARM_CONTAINERS.
    if (this.cfg.maxWarmContainers <= 0) return;
    const configSignature = buildContainerConfigSignature({ spawnOptions });
    const existingWarm = this.warm.get(agentId);
    if (existingWarm?.configSignature === configSignature) return;
    this.desiredWarmSignature.set(agentId, configSignature);
    if (existingWarm && existingWarm.configSignature !== configSignature) {
      this.warm.delete(agentId);
      poolWarmContainers.set(this.warm.size);
      await existingWarm.wsClient.close().catch(() => {
        /* best-effort */
      });
      await this.runtime.stop(existingWarm.container.id).catch((err) => {
        log.warn({ err, container_id: existingWarm.container.id, agent_id: agentId }, "stale warm stop failed");
      });
    }
    const inflight = this.pendingByAgent.get(agentId);
    if (inflight?.configSignature === configSignature) return inflight.promise;
    const promise = this.doWarmForAgent(agentId, spawnOptions, configSignature);
    this.pendingByAgent.set(agentId, { configSignature, promise });
    try {
      await promise;
    } finally {
      const current = this.pendingByAgent.get(agentId);
      if (current?.configSignature === configSignature) {
        this.pendingByAgent.delete(agentId);
      }
    }
  }

  private async doWarmForAgent(
    agentId: string,
    spawnOptions: SpawnOptions,
    configSignature: string,
  ): Promise<void> {
    const t0 = Date.now();
    await this.evictOldestWarmIfAtCap();
    const container = await this.runtime.spawn(spawnOptions);
    const tCreated = Date.now();
    try {
      await this.runtime.waitForReady(container, this.cfg.readyTimeoutMs);
    } catch (err) {
      await this.runtime.stop(container.id).catch(() => { /* best-effort */ });
      throw err;
    }
    const tReady = Date.now();
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
    const tConnected = Date.now();
    if (this.desiredWarmSignature.get(agentId) !== configSignature) {
      await wsClient.close().catch(() => { /* best-effort */ });
      await this.runtime.stop(container.id).catch(() => { /* best-effort */ });
      return;
    }
    this.warm.set(agentId, {
      agentId,
      container,
      wsClient,
      spawnOptions,
      configSignature,
      spawnedAt: Date.now(),
    });
    poolWarmContainers.set(this.warm.size);
    log.info(
      {
        agent_id: agentId,
        container_create_ms: tCreated - t0,
        ready_wait_ms: tReady - tCreated,
        ws_connect_ms: tConnected - tReady,
        total_warm_ms: tConnected - t0,
      },
      "pre-warmed container for agent",
    );
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
    /**
     * True when this session's spawn env embeds session-specific config
     * that warm-pool containers (built with placeholder "__warm__"
     * session context) cannot carry. Today that includes vault-bound
     * sessions (MCP credentials injected into OPENCLAW_MCP_SERVERS_JSON)
     * and sessions with environment package preinstalls. Bypass warm
     * pool for those — same rationale as the networking: limited branch
     * below.
     */
    bypassWarmPool?: boolean;
  }): Promise<Container> {
    const configSignature = buildContainerConfigSignature({
      spawnOptions: args.spawnOptions,
      networking: args.networking,
    });
    const existing = this.active.get(args.sessionId);
    if (existing) {
      if (
        existing.configSignature !== "adopted"
        && existing.configSignature !== configSignature
      ) {
        await this.evictSession(args.sessionId);
      } else {
        existing.lastUsedAt = Date.now();
        poolAcquireTotal.labels({ source: "active" }).inc();
        return existing.container;
      }
    }

    const freshExisting = this.active.get(args.sessionId);
    if (freshExisting) {
      freshExisting.lastUsedAt = Date.now();
      poolAcquireTotal.labels({ source: "active" }).inc();
      return freshExisting.container;
    }

    // Limited networking forks off to its own spawn path — warm pool
    // reuse doesn't apply (the per-session confined network + sidecar
    // are minted fresh per session).
    if (args.networking?.type === "limited") {
      return await this.doLimitedSpawn({
        sessionId: args.sessionId,
        spawnOptions: args.spawnOptions,
        allowedHosts: args.networking.allowedHosts,
        allowMcpServers: args.networking.allowMcpServers,
        allowPackageManagers: args.networking.allowPackageManagers,
      });
    }

    // IMPORTANT: do NOT wait for an inflight warm spawn here.
    //
    // Warming is speculative. Session-create, agent-create, and startup
    // all kick warmForAgent() in the background with the documented
    // promise that failure is non-fatal and the first real event can
    // still cold-spawn. Waiting here breaks that contract and turns a
    // broken/speculative warm into head-of-line blocking for the user's
    // first turn (up to readyTimeoutMs, which is 10 minutes in prod).
    //
    // Correct behavior:
    //   - if a ready warm container already exists, claim it below
    //   - otherwise ignore any inflight warm and cold-spawn now
    //
    // The warm promise is still useful for deduping warmForAgent() calls
    // with each other; it just must not sit on the critical path of a
    // real session acquire.

    // Check the warm pool for a matching pre-warmed container — but
    // only if the caller is willing to claim one. Sessions with
    // session-specific env (for example vault-bound MCP credentials or
    // environment package preinstalls) cannot safely reuse a generic
    // template warm built with placeholder "__warm__" context.
    if (args.agentId && !args.bypassWarmPool) {
      const warmEntry = this.warm.get(args.agentId);
      if (warmEntry) {
        if (warmEntry.configSignature !== configSignature) {
          this.warm.delete(args.agentId);
          poolWarmContainers.set(this.warm.size);
          await warmEntry.wsClient.close().catch(() => {
            /* best-effort */
          });
          await this.runtime.stop(warmEntry.container.id).catch((err) => {
            log.warn(
              { err, container_id: warmEntry.container.id, agent_id: args.agentId },
              "stale warm stop failed during claim",
            );
          });
        } else {
          this.warm.delete(args.agentId);
          poolWarmContainers.set(this.warm.size);
          const warmHostPath = warmEntry.spawnOptions.mounts[0]?.hostPath;
          if (warmHostPath && this.cfg.renameWorkspaceOnClaim) {
            this.cfg.renameWorkspaceOnClaim(warmHostPath, args.sessionId);
          }
          const now = Date.now();
          this.active.set(args.sessionId, {
            sessionId: args.sessionId,
            container: warmEntry.container,
            wsClient: warmEntry.wsClient,
            configSignature,
            spawnedAt: warmEntry.spawnedAt,
            lastUsedAt: now,
          });
          poolActiveContainers.set(this.active.size);
          poolAcquireTotal.labels({ source: "warm" }).inc();
          this.cfg.onContainerClaimed?.({
            sessionId: args.sessionId,
            agentId: args.agentId,
            container: warmEntry.container,
            source: "warm",
            // Warm-reuse is instant from the session's perspective. The
            // container was fully booted before this session existed;
            // reporting its original spawn duration would mis-represent
            // the perceived latency of this session's first event.
            bootMs: 0,
          });
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
    }

    // Deduplicate concurrent acquires for the same session. This covers
    // duplicate client submits / retries on the same session, not the
    // speculative warm path above (which has its own per-agent map).
    const inflight = this.pending.get(args.sessionId);
    if (inflight) return inflight;

    const spawnPromise = this.doSpawn(args, configSignature);
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
  }, configSignature: string): Promise<Container> {
    const spawnEnd = poolSpawnDurationSeconds.startTimer();
    const t0 = Date.now();
    const container = await this.runtime.spawn(args.spawnOptions);
    const tCreated = Date.now();
    try {
      await this.runtime.waitForReady(container, this.cfg.readyTimeoutMs);
    } catch (err) {
      await this.runtime.stop(container.id).catch(() => {
        /* best-effort */
      });
      throw err;
    }
    const tReady = Date.now();

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
    const tConnected = Date.now();

    const now = Date.now();
    this.active.set(args.sessionId, {
      sessionId: args.sessionId,
      container,
      wsClient,
      configSignature,
      spawnedAt: now,
      lastUsedAt: now,
    });
    poolActiveContainers.set(this.active.size);
    poolAcquireTotal.labels({ source: "spawn" }).inc();
    spawnEnd();
    const agentIdForClaim = args.spawnOptions.labels?.["orchestrator-agent-id"];
    const totalSpawnMs = tConnected - t0;
    if (agentIdForClaim) {
      this.cfg.onContainerClaimed?.({
        sessionId: args.sessionId,
        agentId: agentIdForClaim,
        container,
        source: "cold",
        bootMs: totalSpawnMs,
      });
    }
    log.info(
      {
        session_id: args.sessionId,
        container_create_ms: tCreated - t0,
        ready_wait_ms: tReady - tCreated,
        ws_connect_ms: tConnected - tReady,
        total_spawn_ms: totalSpawnMs,
      },
      "fresh container spawn completed",
    );
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
    allowMcpServers?: boolean;
    allowPackageManagers?: boolean;
  }): Promise<Container> {
    if (!this.cfg.limitedNetworking) {
      throw new Error(
        "networking: limited requested but pool was not configured with limitedNetworking; " +
          "wire cfg.limitedNetworking in index.ts before spawning a confined session",
      );
    }
    const netCfg = this.cfg.limitedNetworking;
    const spawnEnd = poolSpawnDurationSeconds.startTimer();
    const limitedT0 = Date.now();
    const configSignature = buildContainerConfigSignature({
      spawnOptions: args.spawnOptions,
      networking: {
        type: "limited",
        allowedHosts: args.allowedHosts,
        allowMcpServers: args.allowMcpServers,
        allowPackageManagers: args.allowPackageManagers,
      },
    });

    // Full session id, sanitized to Docker's name rules ([a-z0-9-_]).
    // Do NOT truncate: nanoid session ids are 12 chars and prefix
    // truncation would let two sessions with the same prefix collide
    // on the same network + sidecar (`ensureNetwork` is idempotent so
    // it wouldn't error — it would silently share the sidecar).
    // Underscores in nanoids do not occur (alphabet is a-z0-9), but
    // test ids may have them; replace to keep Docker's parser happy.
    const safeId = args.sessionId
      .replace(/^ses_/, "")
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-");
    const confinedNet = `openclaw-sess-${safeId}-confined`;
    const egressNet = `openclaw-sess-${safeId}-egress`;
    const sidecarName = `openclaw-sess-${safeId}-proxy`;
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
      //    path out) and control-plane (so the orchestrator can hit its
      //    readiness probe). Allowed hosts delivered via env as a JSON
      //    array, matching the schema proxy.mjs expects.
      const sidecar = await this.runtime.spawn({
        image: netCfg.sidecarImage,
        name: sidecarName,
        containerPort: httpPort,
        network: confinedNet,
        additionalNetworks: [egressNet, netCfg.controlPlaneNetwork],
        mounts: [],
        env: {
          OPENCLAW_EGRESS_ALLOWED_HOSTS: JSON.stringify(args.allowedHosts),
          OPENCLAW_EGRESS_SESSION_ID: args.sessionId,
          OPENCLAW_EGRESS_HTTP_PORT: String(httpPort),
          OPENCLAW_EGRESS_HEALTHZ_PORT: String(healthzPort),
          OPENCLAW_EGRESS_DNS_PORT: String(dnsPort),
          ...(args.allowMcpServers ? { OPENCLAW_EGRESS_ALLOW_MCP_SERVERS: "true" } : {}),
          ...(args.allowPackageManagers ? { OPENCLAW_EGRESS_ALLOW_PACKAGE_MANAGERS: "true" } : {}),
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
      //    Two layers of confinement wire up here:
      //
      //    a) HTTP_PROXY / HTTPS_PROXY → sidecar's name on the confined
      //       network. HTTP clients (Node fetch, Python requests, curl,
      //       git) route through it automatically.
      //    b) Dns: [sidecarIp] → sidecar's IP on the confined network,
      //       written into /etc/resolv.conf. Catches the gap where a
      //       caller doesn't respect HTTP_PROXY (raw sockets, direct
      //       getaddrinfo). With the filter at DNS layer, a denied
      //       hostname returns NXDOMAIN; with the --internal network
      //       topology, there's no egress for an IP-literal either.
      //
      //    NO_PROXY excludes localhost + the orchestrator (reached via
      //    control-plane, not the sidecar).
      const sidecarConfinedIp =
        sidecar.networks?.[confinedNet] ??
        // Fallback: use the sidecar name. Docker's per-network alias
        // resolution makes this work via /etc/hosts inside containers
        // on the same network, but only for hostname lookups — Dns
        // only accepts IPs. The name here is effectively a smoke-test
        // fallback for the FakeRuntime in unit tests; production
        // paths always have a real IP from the post-spawn inspect.
        sidecarName;
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
        dns: [sidecarConfinedIp],
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
        configSignature,
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
      const agentIdForClaim = args.spawnOptions.labels?.["orchestrator-agent-id"];
      const limitedBootMs = Date.now() - limitedT0;
      if (agentIdForClaim) {
        this.cfg.onContainerClaimed?.({
          sessionId: args.sessionId,
          agentId: agentIdForClaim,
          container: agent,
          source: "limited",
          bootMs: limitedBootMs,
        });
      }
      log.info(
        {
          session_id: args.sessionId,
          confined_network: confinedNet,
          egress_network: egressNet,
          allowed_hosts: args.allowedHosts.length,
          total_spawn_ms: limitedBootMs,
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

  /** Returns the container id of this session's active container, if any. */
  getContainerId(sessionId: string): string | undefined {
    return this.active.get(sessionId)?.container.id;
  }

  /** Expose read-only metadata about an active container for staleness checks. */
  getActiveEntry(sessionId: string): { spawnedAt: number; lastUsedAt: number } | undefined {
    const entry = this.active.get(sessionId);
    if (!entry) return undefined;
    return { spawnedAt: entry.spawnedAt, lastUsedAt: entry.lastUsedAt };
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
    this.cfg.onContainerReleased?.(sessionId);
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

  /**
   * Adopt a container that was already running before this process
   * started. Runs the same /readyz probe + WS handshake as a fresh
   * spawn but skips the create+start. On success the session is
   * registered in the active pool exactly as if we had spawned it
   * ourselves; on failure the caller is responsible for stopping the
   * container. Throws if the session already has an active entry.
   */
  async adopt(args: { sessionId: string; container: Container; agentId?: string }): Promise<void> {
    if (this.active.has(args.sessionId)) {
      throw new Error(
        `session ${args.sessionId} already has an active container in the pool`,
      );
    }
    await this.runtime.waitForReady(args.container, this.cfg.readyTimeoutMs);
    const wsClient = new GatewayWebSocketClient({
      baseUrl: args.container.baseUrl,
      token: args.container.token,
      clientName: "openclaw-managed-agents",
    });
    try {
      await wsClient.connect();
    } catch (err) {
      await wsClient.close().catch(() => {
        /* best-effort */
      });
      throw err;
    }
    const now = Date.now();
    this.active.set(args.sessionId, {
      sessionId: args.sessionId,
      container: args.container,
      wsClient,
      configSignature: "adopted",
      spawnedAt: now,
      lastUsedAt: now,
    });
    poolActiveContainers.set(this.active.size);
    poolAcquireTotal.labels({ source: "adopt" }).inc();
    // Re-assert the session↔container mapping after adoption. If the
    // mapping was already in SQLite this is a no-op; if not (e.g.,
    // container pre-dates this feature), it recovers it so subsequent
    // restarts also reattach cleanly. Agent id is looked up from the
    // caller's args via spawnOptions is unavailable here, so read it
    // from the adopted session's store entry.
    if (args.agentId) {
      this.cfg.onContainerClaimed?.({
        sessionId: args.sessionId,
        agentId: args.agentId,
        container: args.container,
        source: "adopt",
        // Adoption means this orchestrator process didn't spawn the
        // container — recording a bootMs here would be a fabricated
        // wallclock. Preserve null so the UI can render "—".
        bootMs: null,
      });
    }
    log.info(
      { session_id: args.sessionId, container_id: args.container.id },
      "adopted existing container",
    );
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
      this.cfg.onContainerReleased?.(entry.sessionId);
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

  /**
   * Drop any pre-warmed container held for the given agent template.
   * No-op if the agent isn't warmed. Intended for the agent-delete
   * HTTP path — without this the warm container lingers until the
   * idle-timeout sweeper fires (default 30 min), burning memory and
   * container-slot budget on a template that no longer exists.
   * Fire-and-forget; failures are logged but don't throw.
   */
  async dropWarmForAgent(agentId: string): Promise<void> {
    const entry = this.warm.get(agentId);
    if (!entry) return;
    await this.reapWarmEntry(entry, "deleted");
  }

  private async reapWarmEntry(
    entry: WarmContainer,
    reason: "idle" | "cap-exceeded" | "deleted",
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
