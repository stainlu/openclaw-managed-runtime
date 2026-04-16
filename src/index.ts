import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
  // stateRoot is the in-process path of the SAME directory as seen from
  // inside the orchestrator container. The JSONL reader opens files via
  // this path. In docker-compose the two point to the same volume; in
  // local dev (pnpm dev) both must be set to the host directory.
  const stateRoot = env("OPENCLAW_STATE_ROOT", "/var/openclaw/sessions");
  const network = env("OPENCLAW_DOCKER_NETWORK", "openclaw-net");
  const gatewayPort = envInt("OPENCLAW_GATEWAY_PORT", 18789);
  const readyTimeoutMs = envInt("OPENCLAW_READY_TIMEOUT_MS", 60_000);
  const runTimeoutMs = envInt("OPENCLAW_RUN_TIMEOUT_MS", 10 * 60_000);
  const idleTimeoutMs = envInt("OPENCLAW_IDLE_TIMEOUT_MS", 10 * 60_000);
  const sweepIntervalMs = envInt("OPENCLAW_SWEEP_INTERVAL_MS", 60_000);

  const runtime = new DockerContainerRuntime({ network });
  await runtime.ensureNetwork();

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
    isBusy: (sessionId) => store.sessions.get(sessionId)?.status === "running",
    cleanupOnReap: async (sessionId) => {
      const session = store.sessions.get(sessionId);
      if (!session?.ephemeral) return;
      try {
        eventReader.deleteBySession(session.agentId, sessionId);
      } catch (err) {
        console.warn(
          `[pool cleanup] deleting JSONL for ephemeral ${sessionId} failed:`,
          err,
        );
      }
      store.sessions.delete(sessionId);
      console.log(`[pool cleanup] reaped ephemeral session ${sessionId}`);
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

  console.log(`[orchestrator] OpenClaw Managed Agents v${version} starting`);
  console.log(`[orchestrator] runtime image: ${runtimeImage}`);
  console.log(`[orchestrator] docker network: ${network}`);
  console.log(`[orchestrator] host state root: ${hostStateRoot}`);
  console.log(`[orchestrator] state root (in-process): ${stateRoot}`);
  console.log(`[orchestrator] orchestrator url (for in-container call_agent): ${orchestratorUrl}`);
  console.log(
    `[orchestrator] store: ${storeBackend}${storePath ? ` (${storePath})` : ""}`,
  );
  console.log(
    `[orchestrator] pool: idleTimeout=${idleTimeoutMs}ms sweepInterval=${sweepIntervalMs}ms readyTimeout=${readyTimeoutMs}ms`,
  );
  if (orphanedContainers > 0) {
    console.log(
      `[orchestrator] cleanup: reaped ${orphanedContainers} orphaned container(s) from a previous instance`,
    );
  }
  if (orphaned > 0) {
    console.log(
      `[orchestrator] rehydration: marked ${orphaned} running session(s) as failed after restart`,
    );
  }
  console.log(
    `[orchestrator] forwarding provider env vars (${passthroughEnvKeys.length}): ${
      passthroughEnvKeys.length > 0 ? passthroughEnvKeys.join(", ") : "(none detected)"
    }`,
  );
  if (passthroughEnvKeys.length === 0) {
    console.log(
      "[orchestrator] WARNING: no provider API keys detected in the host env. " +
        "Export at least one (e.g. MOONSHOT_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, " +
        "GEMINI_API_KEY) before spawning agents, or runs will fail.",
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
    },
    { port },
  );

  // Graceful shutdown: tear down all pool-managed containers (best-effort)
  // and close the SQLite store so WAL checkpoints flush cleanly. The HTTP
  // server is not explicitly stopped because Hono's node-server doesn't
  // expose a close() reference in this codebase yet — in practice the
  // process.exit() call takes the listener down with it.
  const shutdown = (signal: string): void => {
    console.log(`[orchestrator] received ${signal}, shutting down`);
    (async () => {
      try {
        await pool.shutdown();
      } catch (err) {
        console.warn("[orchestrator] pool shutdown error:", err);
      }
      store.close();
      process.exit(0);
    })();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("[orchestrator] fatal:", err);
  process.exit(1);
});
