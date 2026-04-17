export type Mount = {
  /** Absolute path on the host. */
  hostPath: string;
  /** Absolute path inside the container. */
  containerPath: string;
  readOnly?: boolean;
};

export type SpawnOptions = {
  /** Container image reference, e.g. "openclaw-managed-agents/agent:latest". */
  image: string;
  /** Environment variables injected into the container. */
  env: Record<string, string>;
  /** Bind mounts for persistent state (sessions, etc.). */
  mounts: Mount[];
  /** Container port to expose (OpenClaw gateway). */
  containerPort: number;
  /** Optional stable container name (used as an addressable hostname in Docker networks). */
  name?: string;
  /**
   * Docker network the container should join at boot. The container is
   * reachable by its name on this network; the orchestrator uses that
   * form rather than published host ports.
   */
  network?: string;
  /**
   * Optional additional networks to connect this container to AFTER it
   * boots (via `docker network connect`). Used when a container needs
   * membership in more than one network — e.g., `networking: limited`
   * agents that live on both a session-confined internal network AND
   * the orchestrator's control-plane network.
   */
  additionalNetworks?: string[];
  /**
   * Optional DNS resolver IPs to write into the container's
   * `/etc/resolv.conf`. When set, the container uses these resolvers
   * instead of the Docker host's default. Used for `networking:
   * limited` agents so that hostname lookups route through the egress-
   * proxy sidecar's filter instead of the embedded resolver.
   */
  dns?: string[];
  /** Optional label map for listing/filtering. */
  labels?: Record<string, string>;
};

/**
 * Egress policy for a session's agent container.
 *
 * - "unrestricted": the container joins the default bridge network and
 *   can reach anything on the internet. Legacy behavior.
 * - "limited": the container is spawned on a --internal network and
 *   paired with an egress-proxy sidecar that filters outbound traffic
 *   against the allowlist. Only the sidecar has external egress.
 */
export type NetworkingSpec =
  | { type: "unrestricted" }
  | { type: "limited"; allowedHosts: string[] };

export type Container = {
  /** Backend-specific container ID. */
  id: string;
  /** Stable name used for intra-network routing. */
  name: string;
  /**
   * A fetchable HTTP base URL for the OpenClaw gateway. The orchestrator should
   * use this to call `/v1/chat/completions`, `/healthz`, `/readyz`.
   * Example: "http://openclaw-agt-abc.openclaw-net:18789"
   */
  baseUrl: string;
  /**
   * Shared-secret token for authenticated requests to this container's HTTP
   * endpoints (other than `/healthz` and `/readyz`, which bypass auth).
   * The runtime backend generates this per container and passes it in via
   * the OPENCLAW_GATEWAY_TOKEN env var. OpenClaw refuses to bind to non-
   * loopback interfaces without a shared secret — see
   * /src/cli/gateway-cli/run.ts:505-528.
   */
  token: string;
  /**
   * Resolved IP address on each network this container is attached to.
   * Map key is the Docker network name, value is the IPv4 address
   * assigned on that network. Populated after spawn. Used by the pool
   * to hand sidecar IPs to agent spawns for Dns config.
   */
  networks?: Record<string, string>;
};

export interface ContainerRuntime {
  spawn(opts: SpawnOptions): Promise<Container>;
  stop(id: string): Promise<void>;
  /** Poll the container's /readyz until it returns 200 or the timeout is hit. */
  waitForReady(container: Container, timeoutMs: number): Promise<void>;
  /**
   * Idempotently create a Docker network. If it already exists, no-op.
   *
   * Called with no args, creates the backend's default network
   * (`openclaw-net`). `internal: true` creates a network with no
   * external egress — Docker drops any packet leaving the bridge.
   * Used for `networking: limited` session confinement and for the
   * orchestrator↔agent control-plane network.
   */
  ensureNetwork(name?: string, opts?: { internal?: boolean }): Promise<void>;
  /**
   * Tear down a Docker network. Used to drop per-session networks when
   * a limited-networking session is evicted. No-op if the network
   * doesn't exist or still has attached containers (the caller should
   * stop those first).
   */
  removeNetwork(name: string): Promise<void>;
  /**
   * Attach a running container to an additional network after spawn.
   * Used when a container needs membership in multiple networks (e.g.,
   * a limited-networking agent on confined+control-plane, or a sidecar
   * on confined+egress).
   */
  connectNetwork(
    containerId: string,
    network: string,
    opts?: { aliases?: string[] },
  ): Promise<void>;
}
