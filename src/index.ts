import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getLogger, rootLogger } from "./log.js";
import { SessionEventQueue } from "./orchestrator/event-queue.js";
import { AgentRouter, type RouterConfig } from "./orchestrator/router.js";
import { startServer } from "./orchestrator/server.js";
import { DockerContainerRuntime } from "./runtime/docker.js";
import { ParentTokenMinter } from "./runtime/parent-token.js";
import { SessionContainerPool } from "./runtime/pool.js";
import {
  buildStore,
  PiJsonlEventReader,
  type StoreBackend,
} from "./store/index.js";

const log = getLogger("index");

function readPackageVersion(): string {
  // Resolve package.json relative to the compiled module location, so it works
  // both under `tsx watch src/index.ts` (dev) and `node dist/index.js` (prod).
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      resolve(here, "../package.json"), // dist/index.js -> ../package.json
      resolve(here, "../../package.json"), // dist/src/index.js -> ../../package.json (tsx)
    ];
    for (const path of candidates) {
      try {
        const raw = readFileSync(path, "utf8");
        const parsed = JSON.parse(raw) as { version?: unknown };
        if (typeof parsed.version === "string" && parsed.version.length > 0) {
          return parsed.version;
        }
      } catch {
        // try next candidate
      }
    }
  } catch {
    // fall through
  }
  return "0.0.0-unknown";
}

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v !== undefined && v !== "") return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`missing required env var: ${name}`);
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) {
    throw new Error(`env var ${name} must be an integer, got "${raw}"`);
  }
  return n;
}

function collectPassthroughEnv(): Record<string, string> {
  // Forward provider credentials to spawned agent containers. The default list
  // covers every major provider OpenClaw supports out of the box so the
  // runtime is genuinely provider-agnostic: whichever provider the agent's
  // model.primary points at will pick up its credentials via its standard
  // env-var name. Extend via OPENCLAW_PASSTHROUGH_ENV (comma-separated) for
  // custom providers or deploy-specific variables. A future item replaces
  // this with cloud secret managers (AWS Secrets Manager, GCP Secret Manager,
  // Azure Key Vault, etc.) via an upstream OpenClaw SecretRef extension.
  const defaultKeys = [
    // Amazon Bedrock (AWS credential chain — works with AWS_PROFILE too)
    "AWS_REGION",
    "AWS_DEFAULT_REGION",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_PROFILE",
    "AWS_BEARER_TOKEN_BEDROCK",
    // Direct provider API keys
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "MOONSHOT_API_KEY",
    "DEEPSEEK_API_KEY",
    "QWEN_API_KEY",
    "DASHSCOPE_API_KEY",
    "MISTRAL_API_KEY",
    "XAI_API_KEY",
    "TOGETHER_API_KEY",
    "OPENROUTER_API_KEY",
    "FIREWORKS_API_KEY",
    "GROQ_API_KEY",
  ];
  const extraKeys = (process.env.OPENCLAW_PASSTHROUGH_ENV ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
  const keys = [...new Set([...defaultKeys, ...extraKeys])];
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = process.env[k];
    if (v !== undefined && v !== "") out[k] = v;
  }
  return out;
}

async function main(): Promise<void> {
  const version = readPackageVersion();
  const port = envInt("PORT", 8080);
  // Item 12-14: the URL the in-container `call_agent` CLI uses to reach
  // back to the orchestrator HTTP API. Defaults to the docker-compose
  // service name + this port, which Just Works for the standard local
  // setup. Override for non-compose deployments (k8s Service, direct
  // docker with a different container name, etc.).
  const orchestratorUrl = env(
    "OPENCLAW_ORCHESTRATOR_URL",
    `http://openclaw-orchestrator:${port}`,
  );
  const runtimeImage = env("OPENCLAW_RUNTIME_IMAGE", "openclaw-managed-agents/agent:latest");
  // hostStateRoot is the host-side path, needed by dockerode for bind
  // mounts on spawned agent containers. The actual Docker daemon resolves
  // paths against the host filesystem, not the orchestrator's.
  const hostStateRoot = env("OPENCLAW_HOST_STATE_ROOT", "/var/openclaw/sessions");
  if (!hostStateRoot.startsWith("/")) {
    throw new Error(
      `OPENCLAW_HOST_STATE_ROOT must be an absolute HOST-side path (got ${JSON.stringify(hostStateRoot)}). ` +
        `If you see a relative path or $PWD artifact, docker compose was run from a directory other than ` +
        `the repo root — cd to the repo root before starting the stack.`,
    );
  }
  // stateRoot is the in-process path of the SAME directory as seen from
  // inside the orchestrator container. The JSONL reader opens files via
  // this path. In docker-compose the two point to the same volume; in
  // local dev (pnpm dev) both must be set to the host directory.
  const stateRoot = env("OPENCLAW_STATE_ROOT", "/var/openclaw/sessions");
  const network = env("OPENCLAW_DOCKER_NETWORK", "openclaw-net");
  // Internal Docker network carrying orchestrator↔agent control-plane
  // traffic for `networking: limited` sessions. Must be reachable by
  // the orchestrator container AND agent containers whose environments
  // are configured with limited networking. docker-compose declares
  // this network and attaches the orchestrator to both; for bespoke
  // deploys, `ensureNetwork` creates it on startup with internal=true
  // so it has no external egress.
  const controlPlaneNetwork = env(
    "OPENCLAW_CONTROL_PLANE_NETWORK",
    "openclaw-control-plane",
  );
  // Image used for the per-session egress-proxy sidecar when an
  // environment is configured with networking.type === "limited".
  const egressProxyImage = env(
    "OPENCLAW_EGRESS_PROXY_IMAGE",
    "ghcr.io/stainlu/openclaw-managed-agents-egress-proxy:latest",
  );
  const gatewayPort = envInt("OPENCLAW_GATEWAY_PORT", 18789);
  const readyTimeoutMs = envInt("OPENCLAW_READY_TIMEOUT_MS", 60_000);
  const runTimeoutMs = envInt("OPENCLAW_RUN_TIMEOUT_MS", 10 * 60_000);
  const idleTimeoutMs = envInt("OPENCLAW_IDLE_TIMEOUT_MS", 10 * 60_000);
  const sweepIntervalMs = envInt("OPENCLAW_SWEEP_INTERVAL_MS", 60_000);
  // Warm pool is bounded so a host with many agent templates does not
  // accumulate one persistent container per template. Default 5 warm
  // containers at 2 GiB each is comfortable on a 4-8 GiB host. Warm
  // idle timeout defaults to the active timeout — if a warm container
  // has been waiting that long unclaimed, its agent is rarely used.
  const maxWarmContainers = envInt("OPENCLAW_MAX_WARM_CONTAINERS", 5);
  const warmIdleTimeoutMs = envInt(
    "OPENCLAW_WARM_IDLE_TIMEOUT_MS",
    idleTimeoutMs,
  );
  // Optional baseline bearer-token auth for the public HTTP API. When
  // unset or empty, every route (except /healthz and /metrics) is open
  // — fine for `docker compose up` on localhost. Set on any deploy
  // exposing port 8080 beyond loopback. Matches Claude Managed Agents'
  // API-key depth: one shared token per deployment, nothing fancier.
  const apiToken = (process.env.OPENCLAW_API_TOKEN ?? "").trim();
  // Per-caller rate limit. 0 or unset = disabled. Keyed by Bearer token
  // when present, else client IP. `/healthz` and `/metrics` always bypass.
  // 120 req/min is generous for legitimate SDK traffic (2/s sustained,
  // 120-burst); stops blind-loop DoS without hindering real workloads.
  const rateLimitRpm = envInt("OPENCLAW_RATE_LIMIT_RPM", 120);

  const runtime = new DockerContainerRuntime({ network });
  await runtime.ensureNetwork();
  // Control-plane network for limited-networking sessions. Internal so
  // it has no external egress; only the orchestrator and limited-
  // session agents join it. Safe no-op when no limited sessions exist.
  await runtime.ensureNetwork(controlPlaneNetwork, { internal: true });

  // Reap any containers left behind by a previous orchestrator instance.
  // Matched by the `managed-by=openclaw-managed-agents` label so we do not
  // touch anything else running on the host's Docker daemon.
  const orphanedContainers = await runtime.cleanupOrphaned();

  const storeBackendRaw = env("OPENCLAW_STORE", "sqlite");
  if (storeBackendRaw !== "memory" && storeBackendRaw !== "sqlite") {
    throw new Error(
      `invalid OPENCLAW_STORE=${storeBackendRaw}, expected "memory" or "sqlite"`,
    );
  }
  const storeBackend: StoreBackend = storeBackendRaw;
  const storePath =
    storeBackend === "sqlite"
      ? env("OPENCLAW_STORE_PATH", "/var/openclaw/state/managed-runtime.db")
      : undefined;
  const store = buildStore({ backend: storeBackend, path: storePath });

  // Post-restart rehydration: any session still marked "running" after a
  // restart was, by definition, orphaned — its container was torn down or
  // is no longer tracked by this process. Flip them to "failed" so the
  // client sees a terminal state instead of a stuck session.
  const orphaned = store.sessions.failRunningSessions("orchestrator restarted mid-run");

  const passthroughEnv = collectPassthroughEnv();
  const passthroughEnvKeys = Object.keys(passthroughEnv).sort();

  // Event reader. Parses OpenClaw's per-session JSONL on the mounted state
  // directory at query time; the orchestrator never writes to those files.
  const eventReader = new PiJsonlEventReader(stateRoot);

  // Per-session container pool. isBusy closes over the session store so the
  // sweeper can skip containers whose session currently has a run in flight
  // — the pool itself has no store dependency. cleanupOnReap closes over
  // BOTH the store and the JSONL reader so it can tear down ephemeral
  // sessions (auto-created by keyless POST /v1/chat/completions) along with
  // their container. Called only on the idle-reap path; manual evictSession
  // and shutdown paths preserve session data.
  const pool = new SessionContainerPool(runtime, {
    idleTimeoutMs,
    readyTimeoutMs,
    sweepIntervalMs,
    maxWarmContainers,
    warmIdleTimeoutMs,
    limitedNetworking: {
      sidecarImage: egressProxyImage,
      controlPlaneNetwork,
    },
    isBusy: (sessionId) => store.sessions.get(sessionId)?.status === "running",
    cleanupOnReap: async (sessionId) => {
      const session = store.sessions.get(sessionId);
      if (!session?.ephemeral) return;
      try {
        eventReader.deleteBySession(session.agentId, sessionId);
      } catch (err) {
        log.warn(
          { err, session_id: sessionId },
          "deleting JSONL for ephemeral session failed",
        );
      }
      store.sessions.delete(sessionId);
      log.info({ session_id: sessionId }, "reaped ephemeral session");
    },
  });

  // Item 12-14: one minter per orchestrator process. Signed by an in-memory
  // random secret generated in the constructor. Restart regenerates the
  // secret, invalidating every outstanding token — consistent with the
  // runtime's other "restart drops ephemeral state" invariants.
  const tokenMinter = new ParentTokenMinter();

  const routerCfg: RouterConfig = {
    runtimeImage,
    hostStateRoot,
    network,
    gatewayPort,
    passthroughEnv,
    runTimeoutMs,
    orchestratorUrl,
    tokenMinter,
  };

  const eventQueue = new SessionEventQueue();

  const router = new AgentRouter(
    store.agents,
    store.environments,
    store.sessions,
    eventReader,
    pool,
    eventQueue,
    routerCfg,
  );

  log.info(
    {
      version,
      runtime_image: runtimeImage,
      docker_network: network,
      control_plane_network: controlPlaneNetwork,
      egress_proxy_image: egressProxyImage,
      host_state_root: hostStateRoot,
      state_root: stateRoot,
      orchestrator_url: orchestratorUrl,
      store: storeBackend,
      store_path: storePath,
      pool: {
        idle_timeout_ms: idleTimeoutMs,
        sweep_interval_ms: sweepIntervalMs,
        ready_timeout_ms: readyTimeoutMs,
        warm_max: maxWarmContainers,
        warm_idle_timeout_ms: warmIdleTimeoutMs,
      },
      orphaned_containers_reaped: orphanedContainers,
      orphaned_sessions_failed: orphaned,
      passthrough_env_keys: passthroughEnvKeys,
      api_auth: apiToken ? "bearer-token" : "disabled",
      rate_limit_rpm: rateLimitRpm > 0 ? rateLimitRpm : "disabled",
    },
    `OpenClaw Managed Agents v${version} starting`,
  );
  if (passthroughEnvKeys.length === 0) {
    log.warn(
      "no provider API keys detected in the host env. Export at least one (e.g. MOONSHOT_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY) before spawning agents, or runs will fail.",
    );
  }
  if (!apiToken) {
    log.warn(
      "OPENCLAW_API_TOKEN is unset — the public HTTP API on port 8080 is open to any caller. Set OPENCLAW_API_TOKEN on every deploy that exposes the port beyond loopback.",
    );
  }

  await startServer(
    {
      agents: store.agents,
      environments: store.environments,
      sessions: store.sessions,
      events: eventReader,
      router,
      tokenMinter,
      version,
      apiToken: apiToken || undefined,
      rateLimitRpm: rateLimitRpm > 0 ? rateLimitRpm : undefined,
    },
    { port },
  );

  // Graceful shutdown: tear down all pool-managed containers (best-effort)
  // and close the SQLite store so WAL checkpoints flush cleanly. The HTTP
  // server is not explicitly stopped because Hono's node-server doesn't
  // expose a close() reference in this codebase yet — in practice the
  // process.exit() call takes the listener down with it.
  const shutdown = (signal: string): void => {
    log.info({ signal }, "shutting down");
    (async () => {
      try {
        await pool.shutdown();
      } catch (err) {
        log.warn({ err }, "pool shutdown error");
      }
      store.close();
      process.exit(0);
    })();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  rootLogger.fatal({ err }, "orchestrator failed to start");
  process.exit(1);
});
