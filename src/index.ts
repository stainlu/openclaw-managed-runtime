import { AgentRegistry } from "./orchestrator/agents.js";
import { AgentRouter, type RouterConfig } from "./orchestrator/router.js";
import { startServer } from "./orchestrator/server.js";
import { SessionRegistry } from "./orchestrator/sessions.js";
import { DockerContainerRuntime } from "./runtime/docker.js";

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
  // custom providers or deploy-specific variables. Phase 2 replaces this with
  // cloud secret managers.
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
  const port = envInt("PORT", 8080);
  const runtimeImage = env("OPENCLAW_RUNTIME_IMAGE", "openclaw-managed-runtime/agent:latest");
  const hostStateRoot = env("OPENCLAW_HOST_STATE_ROOT", "/var/openclaw/sessions");
  const network = env("OPENCLAW_DOCKER_NETWORK", "openclaw-net");
  const gatewayPort = envInt("OPENCLAW_GATEWAY_PORT", 18789);
  const readyTimeoutMs = envInt("OPENCLAW_READY_TIMEOUT_MS", 60_000);
  const runTimeoutMs = envInt("OPENCLAW_RUN_TIMEOUT_MS", 10 * 60_000);

  const runtime = new DockerContainerRuntime({ network });
  await runtime.ensureNetwork();

  const agents = new AgentRegistry();
  const sessions = new SessionRegistry();

  const routerCfg: RouterConfig = {
    runtimeImage,
    hostStateRoot,
    network,
    gatewayPort,
    passthroughEnv: collectPassthroughEnv(),
    readyTimeoutMs,
    runTimeoutMs,
  };

  const router = new AgentRouter(agents, sessions, runtime, routerCfg);

  console.log("[orchestrator] OpenClaw Managed Runtime starting");
  console.log(`[orchestrator] runtime image: ${runtimeImage}`);
  console.log(`[orchestrator] docker network: ${network}`);
  console.log(`[orchestrator] host state root: ${hostStateRoot}`);

  await startServer({ agents, sessions, router, runtime }, { port });
}

main().catch((err) => {
  console.error("[orchestrator] fatal:", err);
  process.exit(1);
});
