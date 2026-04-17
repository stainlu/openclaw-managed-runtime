import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getLogger, rootLogger } from "./log.js";
import {
  startupAdoptionsTotal,
  startupQueueDrainedTotal,
} from "./metrics.js";
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

  // One minter per orchestrator process. The HMAC secret is loaded from
  // SecretStore so it survives restart — that's what keeps outstanding
  // subagent tokens valid across an orchestrator deploy or crash, which
  // is load-bearing for long-running delegation chains. On first boot
  // we generate a fresh 32-byte secret and persist it; on every boot
  // after that we reuse the persisted bytes. The secret never leaves
  // the process; rotating it requires explicit operator action
  // (delete the row) and invalidates every outstanding token.
  const PARENT_TOKEN_SECRET_KEY = "parent_token_hmac_secret";
  let parentSecret = store.secrets.get(PARENT_TOKEN_SECRET_KEY);
  let generatedParentSecret = false;
  if (!parentSecret) {
    parentSecret = randomBytes(32);
    store.secrets.set(PARENT_TOKEN_SECRET_KEY, parentSecret);
    generatedParentSecret = true;
  }
  const tokenMinter = new ParentTokenMinter(parentSecret);

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

  const router = new AgentRouter(
    store.agents,
    store.environments,
    store.sessions,
    eventReader,
    pool,
    store.queue,
    routerCfg,
  );

  // ---- Post-restart reattach + drain ----
  //
  // Before this block existed, startup was blunt: `cleanupOrphaned()`
  // stop-and-removed every labelled container, and `failRunningSessions()`
  // flipped every running session to failed. That threw away a lot of
  // correct state: idle-but-warm containers (forcing the next turn to
  // cold-spawn), and in-flight runs whose Pi sessions can actually be
  // resumed from the JSONL. The new flow preserves what can be preserved.
  //
  // Policy:
  //   - For every labelled container on the host, look up its session.
  //       * Session missing / archived / already failed → stop the container.
  //       * Session exists → try to adopt (readyz + WS handshake). On
  //         success the pool holds it just like a fresh spawn; on failure
  //         we stop the container and move on.
  //   - After adoption: any session that was `running` but whose container
  //     we could not adopt is an interrupted in-flight run. Mark it failed
  //     with a clear recoverable message and drop its queued events (they
  //     were predicated on the run we just failed continuing).
  //   - Idle sessions with queued events are an inconsistency only possible
  //     when the orchestrator crashed between endRunSuccess and queue.shift
  //     in the drain loop. Re-kick the first event so the commitment is
  //     honored — subsequent events drain naturally through the normal
  //     queue path.
  //
  // Warm containers are deliberately NOT adopted: the only thing that
  // identifies a warm container is its agentId label, but re-populating
  // the warm bucket with `spawnOptions` would require a matching agent
  // template, and the bound parent token in its env was minted for the
  // previous process's secret. Simpler and safer to stop them; the next
  // POST /v1/agents won't re-warm, so warmth is only lost until the
  // operator recreates the agent or issues the first session.
  const adopted = new Set<string>();
  let adoptionAttempts = 0;
  let adoptionReattached = 0;
  let adoptionStoppedOrphan = 0;
  let adoptionFailed = 0;
  const managedContainers = await runtime.listManaged();
  for (const info of managedContainers) {
    adoptionAttempts += 1;
    // Containers without a session-id label are legacy (pre-rename) or
    // unclaimed warm containers. Stop them — nothing durable to rebuild.
    const sessionId = info.sessionId;
    if (!sessionId || sessionId === "__warm__") {
      await runtime.stop(info.id).catch(() => { /* best-effort */ });
      adoptionStoppedOrphan += 1;
      startupAdoptionsTotal.labels({ outcome: "stopped_orphan" }).inc();
      continue;
    }
    const session = store.sessions.get(sessionId);
    if (!session || session.status === "failed") {
      await runtime.stop(info.id).catch(() => { /* best-effort */ });
      adoptionStoppedOrphan += 1;
      startupAdoptionsTotal.labels({ outcome: "stopped_orphan" }).inc();
      continue;
    }
    if (!info.running) {
      await runtime.stop(info.id).catch(() => { /* best-effort */ });
      adoptionStoppedOrphan += 1;
      startupAdoptionsTotal.labels({ outcome: "stopped_orphan" }).inc();
      continue;
    }
    try {
      await pool.adopt({
        sessionId,
        container: {
          id: info.id,
          name: info.name,
          baseUrl: info.baseUrl,
          token: info.token,
        },
      });
      adopted.add(sessionId);
      adoptionReattached += 1;
      startupAdoptionsTotal.labels({ outcome: "reattached" }).inc();
    } catch (err) {
      log.warn(
        { err, session_id: sessionId, container_id: info.id },
        "adopt failed; stopping container",
      );
      await runtime.stop(info.id).catch(() => { /* best-effort */ });
      adoptionFailed += 1;
      startupAdoptionsTotal.labels({ outcome: "reattach_failed" }).inc();
    }
  }

  // Selectively fail the running sessions we could not recover. These had
  // an HTTP request in flight at the moment the prior process died — we
  // can't reconstruct that request context, so the client has to re-post.
  // JSONL history is intact, so re-posting just continues the conversation.
  let orphanedRunningSessions = 0;
  for (const session of store.sessions.list()) {
    if (session.status !== "running") continue;
    if (adopted.has(session.sessionId)) continue;
    store.sessions.endRunFailure(
      session.sessionId,
      "orchestrator restarted mid-run; post a new message to resume",
    );
    store.queue.clear(session.sessionId);
    orphanedRunningSessions += 1;
  }

  // Drain queued events for idle sessions. Normal operation makes this
  // set empty (idle + non-empty queue violates the invariant that the
  // drain loop either dequeues or flips to idle). The only way to see
  // entries here is a crash between endRunSuccess and shift. Re-kick:
  // runEvent handles the "session is idle" branch by starting a fresh
  // run, which naturally drains any additional queued events.
  let drainedEvents = 0;
  for (const sessionId of store.queue.listSessionsWithQueued()) {
    const session = store.sessions.get(sessionId);
    if (!session) {
      store.queue.clear(sessionId);
      continue;
    }
    if (session.status !== "idle") continue;
    const head = store.queue.shift(sessionId);
    if (!head) continue;
    try {
      await router.runEvent({
        sessionId,
        content: head.content,
        model: head.model,
      });
      drainedEvents += 1;
      startupQueueDrainedTotal.inc();
    } catch (err) {
      log.warn(
        { err, session_id: sessionId },
        "startup queue drain failed; leaving remaining events for next boot",
      );
    }
  }

  log.info(
    {
      version,
      runtime_image: runtimeImage,
      docker_network: network,
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
      adoption: {
        attempts: adoptionAttempts,
        reattached: adoptionReattached,
        stopped_orphan: adoptionStoppedOrphan,
        reattach_failed: adoptionFailed,
        orphaned_running_sessions_failed: orphanedRunningSessions,
        drained_queued_events: drainedEvents,
      },
      passthrough_env_keys: passthroughEnvKeys,
      api_auth: apiToken ? "bearer-token" : "disabled",
      rate_limit_rpm: rateLimitRpm > 0 ? rateLimitRpm : "disabled",
      parent_token_secret: generatedParentSecret ? "generated" : "restored",
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
