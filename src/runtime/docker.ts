import { randomBytes } from "node:crypto";
import Docker from "dockerode";
import type { Container, ContainerRuntime, SpawnOptions } from "./container.js";

/**
 * A container that was previously spawned by this orchestrator (labeled
 * `managed-by=openclaw-managed-agents`) and is still present on the
 * Docker daemon after a restart. Populated from `docker inspect` so the
 * startup adoption path can rebuild a Container struct without
 * respawning.
 */
export type ManagedContainerInfo = {
  id: string;
  name: string;
  baseUrl: string;
  token: string;
  sessionId: string | undefined;
  agentId: string | undefined;
  running: boolean;
};

/**
 * Docker backend for the managed runtime. Spawns one container per agent/session,
 * attached to a shared Docker network so the orchestrator can reach it by name.
 *
 * MVP assumptions:
 *   - Orchestrator and agent containers share a single Docker network
 *     (configured via `OPENCLAW_DOCKER_NETWORK`, default "openclaw-net").
 *   - Session state is mounted from a host path the orchestrator controls.
 *   - Bedrock credentials are forwarded via env vars from the orchestrator.
 */
export class DockerContainerRuntime implements ContainerRuntime {
  private readonly docker: Docker;
  private readonly defaultNetwork: string;

  constructor(opts: { socketPath?: string; network?: string } = {}) {
    this.docker = new Docker(
      opts.socketPath ? { socketPath: opts.socketPath } : {},
    );
    this.defaultNetwork = opts.network ?? "openclaw-net";
  }

  async spawn(opts: SpawnOptions): Promise<Container> {
    const name = opts.name ?? `openclaw-agt-${randomSuffix()}`;
    const network = opts.network ?? this.defaultNetwork;

    // Per-container shared-secret token. OpenClaw requires this to bind to
    // non-loopback interfaces. We inject it as OPENCLAW_GATEWAY_TOKEN (picked
    // up automatically by the openclaw gateway CLI via resolveGatewayAuth) and
    // return it on the Container so the orchestrator can attach it as a
    // Bearer header when calling the container's /v1/chat/completions.
    const token = opts.env.OPENCLAW_GATEWAY_TOKEN ?? randomBytes(32).toString("hex");
    const envWithToken: Record<string, string> = {
      ...opts.env,
      OPENCLAW_GATEWAY_TOKEN: token,
    };

    const envArray = Object.entries(envWithToken).map(([k, v]) => `${k}=${v}`);

    const binds = opts.mounts.map((m) => {
      const mode = m.readOnly ? "ro" : "rw";
      return `${m.hostPath}:${m.containerPath}:${mode}`;
    });

    const labels = {
      "managed-by": "openclaw-managed-agents",
      ...(opts.labels ?? {}),
    };

    const container = await this.docker.createContainer({
      name,
      Image: opts.image,
      Env: envArray,
      Labels: labels,
      ExposedPorts: { [`${opts.containerPort}/tcp`]: {} },
      HostConfig: {
        Binds: binds,
        // Don't publish ports to the host — the orchestrator reaches containers
        // over the shared Docker network by name.
        RestartPolicy: { Name: "no" },
        // Sensible resource limits for a single agent worker.
        Memory: 2 * 1024 * 1024 * 1024, // 2 GB
        PidsLimit: 512,
        // Override the container's /etc/resolv.conf when dns is supplied.
        // Used by networking: limited agents to route all DNS through the
        // egress-proxy sidecar's UDP 53 filter. Only the sidecar's IP
        // ends up here — Docker does NOT also append its embedded resolver
        // (127.0.0.11) when Dns is set, which is what we want: every
        // hostname lookup from inside the agent goes through the filter.
        Dns: opts.dns,
      },
      NetworkingConfig: {
        EndpointsConfig: {
          [network]: { Aliases: [name] },
        },
      },
    });

    await container.start();

    // Attach additional networks after boot — Docker's CreateContainer
    // only accepts one primary NetworkMode at a time. For limited-
    // networking sessions the agent joins confined+control-plane, and
    // the sidecar joins confined+egress; the second network on each is
    // wired here.
    if (opts.additionalNetworks && opts.additionalNetworks.length > 0) {
      for (const n of opts.additionalNetworks) {
        await this.docker.getNetwork(n).connect({
          Container: container.id,
          EndpointConfig: { Aliases: [name] },
        });
      }
    }

    // Inspect once post-connect so the caller can read per-network IPs
    // (needed for Dns wiring on limited-networking sessions — the pool
    // queries the sidecar's confined-network IP and passes it to the
    // agent's Dns option).
    const networks = await this.readNetworkIps(container.id);

    // The container is reachable over the Docker network by its name.
    const baseUrl = `http://${name}:${opts.containerPort}`;
    return { id: container.id, name, baseUrl, token, networks };
  }

  private async readNetworkIps(
    id: string,
  ): Promise<Record<string, string> | undefined> {
    try {
      const info = await this.docker.getContainer(id).inspect();
      const nets = info.NetworkSettings?.Networks;
      if (!nets) return undefined;
      const out: Record<string, string> = {};
      for (const [name, cfg] of Object.entries(nets)) {
        const ip = cfg?.IPAddress;
        if (typeof ip === "string" && ip.length > 0) out[name] = ip;
      }
      return Object.keys(out).length > 0 ? out : undefined;
    } catch {
      return undefined;
    }
  }

  async stop(id: string): Promise<void> {
    const c = this.docker.getContainer(id);
    try {
      await c.stop({ t: 5 });
    } catch (err) {
      // Already stopped — ignore.
      if (!isNotRunningError(err)) throw err;
    }
    try {
      await c.remove({ force: true });
    } catch (err) {
      if (!isNotFoundError(err)) throw err;
    }
  }

  async waitForReady(container: Container, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown = null;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${container.baseUrl}/readyz`, {
          signal: AbortSignal.timeout(1500),
        });
        if (res.ok) return;
        lastError = new Error(`/readyz returned ${res.status}`);
      } catch (err) {
        lastError = err;
      }
      await sleep(500);
    }
    throw new Error(
      `container ${container.name} did not become ready within ${timeoutMs}ms: ${String(lastError)}`,
    );
  }

  /**
   * Idempotently create a Docker bridge network. Call this at
   * orchestrator startup for shared networks (openclaw-net,
   * openclaw-control-plane), and per-session for limited-networking
   * confinement. When `internal: true`, the network has no external
   * egress — Docker drops every packet headed for a non-member.
   * Called with no args, creates the backend's default network.
   */
  async ensureNetwork(
    name?: string,
    opts?: { internal?: boolean },
  ): Promise<void> {
    const target = name ?? this.defaultNetwork;
    const internal = opts?.internal ?? false;
    const existing = await this.docker.listNetworks({
      filters: { name: [target] },
    });
    if (existing.some((n) => n.Name === target)) return;
    await this.docker.createNetwork({
      Name: target,
      Driver: "bridge",
      Internal: internal,
    });
  }

  /**
   * Remove a Docker network. Used to clean up per-session networks
   * created for limited-networking sessions. Best-effort: silently
   * tolerates "network not found" (already cleaned up) and does NOT
   * force-disconnect attached containers (the caller is responsible
   * for stopping them first).
   */
  async removeNetwork(name: string): Promise<void> {
    try {
      await this.docker.getNetwork(name).remove();
    } catch (err) {
      if (!isNotFoundError(err)) throw err;
    }
  }

  /**
   * Attach a running container to an additional network. Used when a
   * container needs membership in more than one network — the Docker
   * API's CreateContainer accepts one `NetworkMode` at boot, so any
   * additional networks go via `network connect` post-spawn.
   */
  async connectNetwork(
    containerId: string,
    network: string,
    opts?: { aliases?: string[] },
  ): Promise<void> {
    await this.docker.getNetwork(network).connect({
      Container: containerId,
      EndpointConfig: opts?.aliases ? { Aliases: opts.aliases } : undefined,
    });
  }

  /**
   * Enumerate every container previously spawned by this orchestrator
   * (matched by the `managed-by=openclaw-managed-agents` label) along
   * with the metadata needed to adopt it without respawning: the
   * gateway token (read from env), the session/agent ids (from
   * labels), and the reconstructed in-network base URL. Consumed by
   * the startup adoption path in src/index.ts to preserve warm
   * containers across an orchestrator restart. Skips containers the
   * daemon reports as missing between list and inspect (race with
   * parallel teardown).
   */
  async listManaged(): Promise<ManagedContainerInfo[]> {
    const [current, legacy] = await Promise.all([
      this.docker.listContainers({
        all: true,
        filters: { label: ["managed-by=openclaw-managed-agents"] },
      }),
      this.docker.listContainers({
        all: true,
        filters: { label: ["managed-by=openclaw-managed-runtime"] },
      }),
    ]);
    const seen = new Set<string>();
    const infos = [...current, ...legacy].filter((c) => {
      if (seen.has(c.Id)) return false;
      seen.add(c.Id);
      return true;
    });
    const out: ManagedContainerInfo[] = [];
    for (const info of infos) {
      try {
        const inspect = await this.docker.getContainer(info.Id).inspect();
        const env = inspect.Config?.Env ?? [];
        const getEnv = (k: string): string | undefined => {
          const prefix = `${k}=`;
          const found = env.find((e) => e.startsWith(prefix));
          return found ? found.slice(prefix.length) : undefined;
        };
        const token = getEnv("OPENCLAW_GATEWAY_TOKEN");
        const portStr = getEnv("OPENCLAW_GATEWAY_PORT");
        const name = (info.Names[0] ?? "").replace(/^\//, "");
        if (!token || !name || !portStr) continue;
        const port = Number.parseInt(portStr, 10);
        if (!Number.isFinite(port)) continue;
        out.push({
          id: info.Id,
          name,
          baseUrl: `http://${name}:${port}`,
          token,
          sessionId: info.Labels?.["orchestrator-session-id"],
          agentId: info.Labels?.["orchestrator-agent-id"],
          running: info.State === "running",
        });
      } catch {
        // Container disappeared between list and inspect — skip.
      }
    }
    return out;
  }

  /**
   * Legacy hard-reset: force-remove every container labelled as managed
   * by this orchestrator. Kept for operators who want to wipe the
   * host's runtime state (via a script) but NO LONGER CALLED on normal
   * startup — the adoption path in src/index.ts preserves healthy
   * containers across a restart instead of killing them. Returns the
   * number reaped.
   */
  async cleanupOrphaned(): Promise<number> {
    // Match both the current label AND the pre-rename label so containers
    // spawned before the Item 16 rename are also cleaned up on startup.
    const [current, legacy] = await Promise.all([
      this.docker.listContainers({ all: true, filters: { label: ["managed-by=openclaw-managed-agents"] } }),
      this.docker.listContainers({ all: true, filters: { label: ["managed-by=openclaw-managed-runtime"] } }),
    ]);
    const seen = new Set<string>();
    const infos = [...current, ...legacy].filter((c) => {
      if (seen.has(c.Id)) return false;
      seen.add(c.Id);
      return true;
    });
    let reaped = 0;
    for (const info of infos) {
      try {
        await this.docker.getContainer(info.Id).remove({ force: true });
        reaped++;
      } catch {
        // Best-effort — a container might already be gone or belong to a
        // parallel cleanup. Either way, move on.
      }
    }
    return reaped;
  }
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isNotRunningError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /is not running|is already stopped|not running/i.test(msg);
}

function isNotFoundError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /no such container|not found/i.test(msg);
}
