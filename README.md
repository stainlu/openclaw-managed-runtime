# OpenClaw Managed Runtime

**The open alternative to Claude Managed Agents.** An API-first managed agent runtime built on top of OpenClaw.

> **Status:** currently hosted under `stainlu/` as the initial development location. Will migrate to `openclaw/managed-runtime` once upstream adoption is confirmed. Uses `openclaw` as a dependency, not a fork.

---

## What this is

OpenClaw Managed Runtime is an API-first service that runs agent tasks on demand. A developer sends an HTTP request to create an agent, submits a task, and receives results — with sandboxed tool execution, persistent sessions, and credential isolation, all without managing infrastructure.

It is the open counter to Anthropic's Claude Managed Agents:

| | Claude Managed Agents | OpenClaw Managed Runtime |
|---|---|---|
| Model | Claude only | Any model (Bedrock, Gemini, Qwen, GPT, ...) |
| Cloud | Anthropic-hosted only | Any cloud (AWS, GCP, Azure, Aliyun, Volcengine, self-hosted) |
| Source | Closed | Open source (MIT) |
| Session-hour tax | $0.08/hr | None |
| Data sovereignty | None | Full — your data, your cloud, your control |

## How it works

The runtime is one Docker image plus a thin orchestrator. Cloud providers wrap it under their own brand:

- **AWS OpenClaw** = this runtime + Bedrock default + ECS/Fargate orchestration + AWS Marketplace billing
- **Google OpenClaw** = this runtime + Gemini default + Cloud Run orchestration + GCP Marketplace billing
- **Azure OpenClaw** = this runtime + Azure AI Foundry default + Container Apps orchestration + Azure Marketplace billing
- **Aliyun OpenClaw** = this runtime + Qwen default + ECI orchestration + Aliyun Marketplace billing
- **Volcengine OpenClaw** = this runtime + Doubao default + VKE orchestration + Volcengine Marketplace billing

One codebase, one Docker image, all clouds.

## Architecture

```
Developer
   │ POST /v1/agents         create an agent
   │ POST /v1/agents/:id/run submit a task
   │ GET  /v1/sessions/:id   fetch result
   ▼
Orchestrator (this repo)
   │
   │ spawn()                  route()
   ▼                          ▼
ContainerRuntime         OpenClaw container
 (Docker/ECS/...)         - entrypoint generates openclaw.json
                          - exposes /v1/chat/completions
                          - runs the full agent loop (tool use, multi-turn)
                          - persists session JSONL to mounted volume
```

One OpenClaw container per agent. Each container is effectively single-user, which gives us true isolation for free — the orchestrator creates multi-user semantics externally without touching OpenClaw core.

## API

```
GET    /                       # self-documenting root: version, endpoints, docs link
GET    /healthz                # liveness probe: { ok, version }

POST   /v1/agents              # body: { model, tools, instructions, name? }
                               # → { agent_id, model, tools, instructions, name, created_at }

GET    /v1/agents              # → { agents: [...], count }
GET    /v1/agents/:agentId     # → full agent config
DELETE /v1/agents/:agentId     # → { deleted: true }

POST   /v1/agents/:agentId/run # body: { task, sessionId? }
                               # → { session_id, agent_id, status, started_at }

GET    /v1/sessions/:sessionId # → { session_id, agent_id, status, task, output,
                               #      error, tokens: { input, output }, cost_usd,
                               #      started_at, completed_at }
```

The orchestrator is self-documenting — `curl http://localhost:8080/` returns the full endpoint list, version, and links. You never need this section to discover the API, it's just here as a quick reference.

## OpenAI SDK compatibility

The runtime also exposes `POST /v1/chat/completions` with the OpenAI Chat Completions request/response shape. Existing OpenAI SDK integrations can point their `base_url` at the orchestrator and keep working.

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:8080/v1",
    api_key="unused",  # not checked; per-container auth is handled inside the runtime
    default_headers={"x-openclaw-agent-id": "agt_abc123"},
)

# One-shot (ephemeral session, auto-cleaned when its container is reaped)
response = client.chat.completions.create(
    model="placeholder",
    messages=[{"role": "user", "content": "Summarize the April 2026 agent platform landscape."}],
)
print(response.choices[0].message.content)

# Sticky session — same `user` field across calls retains history
user_id = "my-conversation-1"
client.chat.completions.create(
    model="placeholder",
    user=user_id,
    messages=[{"role": "user", "content": "Remember: my name is Alice."}],
)
r = client.chat.completions.create(
    model="placeholder",
    user=user_id,
    messages=[{"role": "user", "content": "What is my name?"}],
)
print(r.choices[0].message.content)  # "Alice"
```

**Load-bearing differences from the OpenAI API** (these are intentional, not bugs):

- **`x-openclaw-agent-id` header is required.** There is no default agent. Every request names the agent template it runs against. Missing header → 400.
- **The body `model` field is ignored.** The model comes from the agent template's `model` field (the argument to `POST /v1/agents`). To override the model for a given session, use the native `POST /v1/sessions/:id/events` endpoint with an optional `model` field — that routes through `sessions.patch` on the OpenClaw gateway control plane and persists for subsequent events.
- **`role: "system"` messages are ignored.** Use the agent template's `instructions` field (which becomes `systemPromptOverride` inside OpenClaw) — that's the canonical system prompt for the agent.
- **Only the last `role: "user"` message is read.** Pi's `SessionManager` owns history on sticky sessions, so you don't need to replay prior turns. For ephemeral sessions, only the final user message defines the turn.
- **`stream: true` is emulated.** The runtime blocks until the run completes, then emits three chunks (role → content → finish) followed by `[DONE]`. Real token-by-token delta streaming is planned for a future item.
- **Session resolution:** `x-openclaw-session-key` header or `user` body field → sticky session (reused across calls, auto-created if the key doesn't yet exist). Neither → ephemeral session with a generated id, reaped alongside its container by the idle sweeper. Client-supplied keys must match `^[a-zA-Z0-9_-]{1,128}$`.
- **Silently ignored fields:** `temperature`, `top_p`, `max_tokens`, `n`, `logprobs`, `stop`, `tools`, `functions`, `response_format`, `seed`, `tool_choice`, and any other OpenAI request fields beyond `messages`/`stream`/`user`/`model`. The runtime returns `n=1`, doesn't translate between OpenAI function calling and agent tools (agents use their own tool ecosystem via templates), and applies no custom output formatting.

**Production note:** the handler polls session status every 500 ms with a 10-minute cap. Behind load balancers or reverse proxies with idle timeouts shorter than 10 minutes, long runs may disconnect before returning. In that case, use the native `POST /v1/sessions/:id/events` pattern and subscribe to `GET /v1/sessions/:id/events?stream=true` for live progress instead of blocking on `/v1/chat/completions`.

## Quick start (local Docker)

Requires: Docker, Node 22+, and an API key for at least one provider OpenClaw supports. The default smoke path uses Moonshot Kimi K2.5 (`moonshot/kimi-k2.5`) because it works from any country Moonshot supports without needing a cloud account. Any OpenClaw provider works — just swap the `model` field and export the matching key.

```bash
git clone https://github.com/stainlu/openclaw-managed-runtime
cd openclaw-managed-runtime
pnpm install

# Pick your provider (examples — you only need one).
export MOONSHOT_API_KEY=sk-...      # moonshot/kimi-k2.5 (default)
# export ANTHROPIC_API_KEY=sk-...   # anthropic/claude-sonnet-4-6
# export OPENAI_API_KEY=sk-...      # openai/gpt-5.4
# export GEMINI_API_KEY=...         # google/gemini-2.5-pro
# export AWS_PROFILE=openclaw       # bedrock/anthropic.claude-sonnet-4-6

docker compose up --build
```

Then in another terminal:

```bash
# Create an agent
curl -X POST http://localhost:8080/v1/agents \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "moonshot/kimi-k2.5",
    "tools": [],
    "instructions": "You are a research assistant."
  }'
# → {"agent_id":"agt_abc123"}

# Run a task
curl -X POST http://localhost:8080/v1/agents/agt_abc123/run \
  -H 'Content-Type: application/json' \
  -d '{"task": "Summarize the agent platform landscape as of April 2026."}'
# → {"session_id":"ses_xyz789","status":"running"}

# Fetch the result
curl http://localhost:8080/v1/sessions/ses_xyz789
# → {"status":"completed","output":"...","cost_usd":0.12,"tokens":15420}
```

## Status and roadmap

This is **early development**. See `docs/architecture.md` for the technical design.

**Phase 1 (MVP, current — shipping today):** Docker-based local runtime, provider-agnostic default (ships with Moonshot Kimi K2.5 but swaps cleanly to any OpenClaw provider), in-memory agent + session registries, host-volume session storage, self-documenting API root, end-to-end validated against real inference.

**Phase 2 (next):** ECS/Fargate container backend, S3 session storage, cloud secrets (AWS Secrets Manager), Postgres-backed agent/session registries, deployment guides, per-provider cost accounting.

**Phase 3 (later):** GCP Cloud Run, Azure Container Apps, Aliyun ECI, Volcengine VKE backends. Multi-tenant orchestrator with auth and quotas. Enterprise features (audit logs, policy enforcement, tenant isolation).

## License

MIT. See `LICENSE`.

## Relationship to OpenClaw

This project uses [OpenClaw](https://github.com/openclaw/openclaw) as an npm dependency. It is not a fork. All agent execution, tool invocation, session management, and provider integration comes from OpenClaw core. This repo adds only the managed layer on top: the orchestrator service, the container entrypoint, and the cloud-specific adapters.

When OpenClaw upstream is ready, this project will migrate to `openclaw/managed-runtime` as a sibling repo under the official organization.
