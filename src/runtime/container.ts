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
   * Docker network the container should join. If set, the orchestrator can
   * reach the container by its name on this network rather than via published
   * host ports.
   */
  network?: string;
  /** Optional label map for listing/filtering. */
  labels?: Record<string, string>;
};

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
};

export interface ContainerRuntime {
  spawn(opts: SpawnOptions): Promise<Container>;
  stop(id: string): Promise<void>;
  /** Poll the container's /readyz until it returns 200 or the timeout is hit. */
  waitForReady(container: Container, timeoutMs: number): Promise<void>;
}
