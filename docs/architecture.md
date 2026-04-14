# Architecture

## Goal

Provide an API-first managed agent runtime that competes with Claude Managed Agents. Developers call a single HTTP API to create agents and run tasks; the runtime handles everything else — containerization, session persistence, provider integration, and cleanup. Cloud providers wrap this runtime under their own brand and sell it on their marketplaces.

## Key constraint: OpenClaw is single-user

OpenClaw is fundamentally designed as one instance per user. The config, sessions, credentials, and workspace are all instance-scoped. The obvious "fix" would be to rewrite OpenClaw to be multi-tenant — that is the wrong move, because it would require months of architectural debate upstream and risks breaking every existing deployment.

**The elegant solution: run one OpenClaw container per agent.** Each container is single-user. The orchestrator creates multi-user semantics externally by spawning a fresh container per agent task. OpenClaw core stays exactly as it is.

This is also how Claude Managed Agents actually works under the hood — Anthropic's engineering posts describe stateless harnesses with many brains and many hands per session.

## Zero upstream changes required

The MVP shipped today runs against the unmodified `openclaw` npm package (pinned to `openclaw@2026.4.11` in `Dockerfile.runtime`). There are no forks, no local patches, no upstream PRs waiting to land before the runtime works. The orchestrator and the entrypoint script together are the full delta.

The original strategic plan identified four OpenClaw-core changes that would make this cleaner (API-only startup mode, config from environment, session replay with pluggable cloud storage, pluggable cloud secrets). Those remain worthwhile Phase 2 optimizations — they reduce cold-start time from ~4s to under 1s and unlock cloud-native storage backends — but none of them are prerequisites. The runtime works today without any of them.

## Components

### Orchestrator (`src/orchestrator/`, `src/runtime/`)

A thin Node/TypeScript HTTP service built on Hono. Exposes the managed agent API (`/v1/agents`, `/v1/agents/:id/run`, `/v1/sessions/:id`). Holds:

- **`AgentRegistry`** (`src/orchestrator/agents.ts`) — in-memory `Map<agentId, AgentConfig>`. Phase 2 will back this with Postgres or Redis.
- **`SessionRegistry`** (`src/orchestrator/sessions.ts`) — in-memory `Map<sessionId, Session>` with status, output, token accounting. Phase 2 moves to a real store.
- **`AgentRouter`** (`src/orchestrator/router.ts`) — takes run requests, spawns a container, waits for `/readyz`, proxies the task to the container's `/v1/chat/completions`, captures the result, tears the container down.
- **`DockerContainerRuntime`** (`src/runtime/docker.ts`) — spawns containers via dockerode on a shared Docker network. Implements the `ContainerRuntime` interface so cloud backends (ECS, Cloud Run, Container Apps, etc.) can be dropped in later without touching the router.

The server is self-documenting at `GET /`: the root returns the version, a human description, and every endpoint it exposes. A developer landing on the orchestrator never needs to open a separate reference.

### Agent container (`Dockerfile.runtime`, `docker/entrypoint.sh`)

A Docker image wrapping the published `openclaw` npm package on `node:22-slim`. At startup, the entrypoint script reads environment variables, generates a minimal `openclaw.json`, and execs `openclaw gateway run`. The container serves OpenClaw's existing OpenAI-compatible endpoint on port 18789.

Environment the entrypoint reads:

| Variable | Purpose | Default |
|---|---|---|
| `OPENCLAW_AGENT_ID` | unique agent identifier | `default` |
| `OPENCLAW_MODEL` | `<provider>/<model-id>` reference | `moonshot/kimi-k2.5` |
| `OPENCLAW_PLUGIN` | provider plugin id to enable | derived from `OPENCLAW_MODEL` |
| `OPENCLAW_TOOLS` | comma-separated OpenClaw skill ids (empty = no allowlist) | `""` |
| `OPENCLAW_INSTRUCTIONS` | system prompt override | `"You are a helpful assistant."` |
| `OPENCLAW_STATE_DIR` | persistent volume mount path | `/workspace` |
| `OPENCLAW_GATEWAY_PORT` | HTTP port for the gateway | `18789` |
| `OPENCLAW_GATEWAY_TOKEN` | shared-secret bearer token (auto-generated if unset) | random 32-byte hex |
| `<PROVIDER>_API_KEY` | whichever API key the selected provider needs | forwarded from the host |

The orchestrator forwards whichever provider API keys are present in its own environment (`MOONSHOT_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `AWS_*`, etc.). See `collectPassthroughEnv()` in `src/index.ts` for the default allowlist and `OPENCLAW_PASSTHROUGH_ENV` for the escape hatch.

#### Generated `openclaw.json` (Moonshot example)

```json
{
  "gateway": {
    "port": 18789,
    "mode": "local",
    "bind": "lan",
    "http": {
      "endpoints": { "chatCompletions": { "enabled": true } }
    }
  },
  "agents": {
    "list": [
      {
        "id": "agt_xxx",
        "model": { "primary": "moonshot/kimi-k2.5" },
        "systemPromptOverride": "You are a helpful assistant."
      }
    ],
    "defaults": {
      "model": { "primary": "moonshot/kimi-k2.5" },
      "models": { "moonshot/kimi-k2.5": {} }
    }
  },
  "models": {
    "mode": "merge",
    "providers": {
      "moonshot": {
        "baseUrl": "https://api.moonshot.ai/v1",
        "api": "openai-completions",
        "models": [
          {
            "id": "kimi-k2.5",
            "name": "Kimi K2.5",
            "input": ["text", "image"],
            "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
            "contextWindow": 262144,
            "maxTokens": 262144
          }
        ]
      }
    }
  },
  "plugins": {
    "entries": { "moonshot": { "enabled": true } }
  }
}
```

Three things in this config are load-bearing and are not obvious from the OpenClaw docs:

1. **`gateway.http.endpoints.chatCompletions.enabled: true`** — the OpenAI-compatible endpoint is disabled by default in OpenClaw. The orchestrator calls this endpoint, so it has to be explicitly enabled here.
2. **`agents.defaults.models.<model-id>: {}`** — declares the model as the agent-level default. Without this block the runtime logs `Unknown model: <model-id>` at invocation time even when the plugin is loaded and auth is resolved.
3. **`models.providers.<plugin-id>`** — required for providers that do not auto-register their catalog. See the next section for the distinction.

**`bind: lan`** means the gateway binds to `0.0.0.0` inside the container so the orchestrator can reach it over the Docker network by container name. OpenClaw refuses to bind to non-loopback interfaces without a shared-secret auth token; the entrypoint generates one into `OPENCLAW_GATEWAY_TOKEN` (or uses the one the orchestrator injects), OpenClaw's CLI picks it up automatically via `resolveGatewayAuth`, and the orchestrator attaches it as a `Bearer` header on every call.

### Provider plugin categories

OpenClaw provider plugins fall into two categories, and the entrypoint handles each differently.

**Category A: auto-register their catalog at plugin load time.** Plugins built with `definePluginEntry` + `register(api)` — for example `anthropic`, `openai`, `google`, `xai`, `mistral`, `openrouter`, `amazon-bedrock` — register their full model catalog when the gateway starts. For these, the generated config only needs `plugins.entries.<id>: { enabled: true }` plus the agent block. Everything else works automatically.

**Category B: require an onboarding flow to materialize the catalog.** Plugins built with `defineSingleProviderPluginEntry` — for example `moonshot` — define their catalog declaratively through a `catalog.buildProvider` hook that is only invoked during the interactive `openclaw models auth login` flow (`applyMoonshotConfig` in `extensions/moonshot/onboard.ts`). Without that flow, the catalog never appears in the runtime registry and invocation fails with `Unknown model`.

For Category B providers the entrypoint writes a hardcoded `models.providers.<id>` block that mirrors what the interactive flow would produce. Extend `PROVIDER_BLOCK_JSON` in `docker/entrypoint.sh` when adding more Category B providers (DeepSeek and Qwen are likely candidates). A clean upstream fix is to make `defineSingleProviderPluginEntry` auto-register its default catalog — that is a follow-up contribution to OpenClaw proper, not something the runtime blocks on.

### Session persistence and continuity

Each container bind-mounts `/workspace` from a host path derived from the agent id: `<hostStateRoot>/<agentId>`. OpenClaw's session machinery (which wraps Pi's `SessionManager`) writes JSONL under `/workspace/agents/<agentId>/sessions/<sessionId>.jsonl`. When a container is torn down the session files persist on the host volume.

Session continuity across container restarts is carried in the HTTP call, not in env vars. The orchestrator sets **both** of these on every internal `/v1/chat/completions` request:

- `x-openclaw-session-key: <session_id>` header
- `user: <session_id>` field in the request body

OpenClaw's gateway picks the key up via `resolveSessionKey` in `src/gateway/http-utils.ts` (upstream openclaw repo) and maps it to a persistent session on disk. When the new container starts up and receives a request under a session key that already has a JSONL file, Pi's `SessionManager.open()` loads the prior events and constructs the `AgentSession` with full historical context. The embedded Pi runner (`src/agents/pi-embedded-runner/run/attempt.ts`) then invokes the model with the reconstructed context, so the agent sees the full conversation history, not just the latest user message.

For the MVP the JSONL files live on a local Docker volume. Phase 2 replaces it with S3 / GCS / Azure Blob / Aliyun OSS / Volcengine TOS via an upstream `SessionStorage` abstraction on OpenClaw.

## Request flow

```
1.  Developer  → POST /v1/agents { model, tools, instructions }
                 Orchestrator records the config in AgentRegistry.
                 Response: { agent_id }

2.  Developer  → POST /v1/agents/agt_xxx/run { task }
                 Orchestrator creates a Session, returns
                 { session_id, status: "running" }
                 (fire-and-track: the actual execution runs in the background).

3.  Background: Orchestrator derives env vars from the agent config and calls
                runtime.spawn() with passthroughEnv from the host merged in.
                runtime.spawn() → dockerode → new container on openclaw-net.
                Orchestrator polls container /readyz until 200.
                Orchestrator POSTs to http://<container>:18789/v1/chat/completions
                  with the task as a single user message and
                  Authorization: Bearer <OPENCLAW_GATEWAY_TOKEN>.
                OpenClaw's embedded agent loop runs tool-using multi-turn turns.
                The HTTP response contains the final completion.
                Orchestrator updates the Session with output + tokens.
                Orchestrator calls runtime.stop() to tear the container down.

4.  Developer  → GET /v1/sessions/ses_yyy
                 Orchestrator returns the Session from SessionRegistry with
                 status, output, tokens, and error if any.
```

## Token accounting

`invokeChatCompletions` captures `usage.prompt_tokens` and `usage.completion_tokens` from the OpenAI-compatible response and stores them on the session. `costUsd` is intentionally zero for the MVP — wiring per-provider price sheets is a Phase 2 concern that does not block the runtime.

## What lives where

| Concern | Home |
|---|---|
| Agent loop (tool use, multi-turn) | OpenClaw (`src/gateway/openai-http.ts` → `agentCommandFromIngress` → embedded Pi runtime) |
| Tool execution | OpenClaw (plugin SDK, skills, sandbox) |
| Model provider integration | OpenClaw (`extensions/<provider>/`) |
| Session event log | OpenClaw (`src/config/sessions/session-file.ts`) |
| Managed-agent API surface | Orchestrator (this repo, `src/orchestrator/server.ts`) |
| Multi-tenant isolation | Orchestrator (one container per agent, `src/orchestrator/router.ts`) |
| Container lifecycle | Orchestrator (`src/runtime/docker.ts`) |
| Config generation | Entrypoint (`docker/entrypoint.sh`) |
| Cloud adapters (Phase 2) | Orchestrator (`src/runtime/{ecs,cloudrun,...}.ts`) |

## Why this works with zero upstream changes

Everything the MVP needs already exists in OpenClaw:

| Need | Already exists |
|---|---|
| API-only startup | Yes — if no channels are configured, the gateway doesn't initialize any |
| HTTP agent API | Yes — `/v1/chat/completions` runs the full agent loop |
| Config from env | Yes — `OPENCLAW_CONFIG_PATH` points at a generated file |
| Health checks | Yes — `/healthz` and `/readyz` are built in |
| Model providers | Yes — bundled plugins for Anthropic, OpenAI, Google, Bedrock, Moonshot, DeepSeek, Qwen, Mistral, xAI, OpenRouter, and more |
| Session persistence | Yes — JSONL on disk, portable via mounted volume |
| Per-agent tool subsets | Yes — `agents.list[].tools.alsoAllow` |

Phase 2 will propose upstream PRs for session storage abstractions, cloud secrets backends, and auto-registration for Category B provider plugins — but none of them are required for the MVP to work.

## Security notes

- **Container auth.** Every spawned agent container gets a random 32-byte-hex `OPENCLAW_GATEWAY_TOKEN`. The orchestrator keeps the token in memory on the `Container` object and attaches it as a Bearer header on every call to that container. `/healthz` and `/readyz` bypass auth (they have to, for Docker healthchecks and orchestrator readiness polling); everything else requires the token.
- **Network isolation.** Containers join `openclaw-net` (a bridge network) and are addressable only by their container name. They do not publish ports to the host. The orchestrator reaches them by name over the shared network.
- **Resource limits.** Each container is capped at 2 GiB memory and 512 PIDs. Adjust in `src/runtime/docker.ts`:`spawn()` for production deploys.
- **Credential passthrough.** Provider API keys are passed as env vars from the orchestrator into each spawned container. Phase 2 replaces this with cloud-native secret managers (AWS Secrets Manager, GCP Secret Manager, Azure Key Vault, etc.) via an upstream OpenClaw `SecretRef` extension.

## Swapping providers

The runtime is provider-agnostic. To switch a running agent or the smoke default off Moonshot:

1. Export the matching API key on the host (e.g. `export OPENAI_API_KEY=sk-...`). `docker-compose.yml` forwards every common provider env var into the orchestrator by default.
2. Change `OPENCLAW_MODEL` in `Dockerfile.runtime` (or override per-agent in the `POST /v1/agents` body), e.g. `openai/gpt-5.4`, `anthropic/claude-sonnet-4-6`, `google/gemini-2.5-pro`, `bedrock/anthropic.claude-sonnet-4-6`, `openrouter/moonshotai/kimi-k2.5`.
3. If the provider is Category B (see "Provider plugin categories" above), extend `PROVIDER_BLOCK_JSON` in `docker/entrypoint.sh` with the equivalent `models.providers.<id>` block.
4. Rebuild the runtime image: `docker build -f Dockerfile.runtime -t openclaw-managed-runtime/agent:latest .`

No orchestrator changes are required for Category A providers.
