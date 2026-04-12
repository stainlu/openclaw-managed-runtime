# Architecture

## Goal

Provide an API-first managed agent runtime that competes with Claude Managed Agents. Developers call a single HTTP API to create agents and run tasks; the runtime handles everything else. Cloud providers wrap this runtime under their own brand and sell it on their marketplaces.

## Key constraint: OpenClaw is single-user

OpenClaw is fundamentally designed as one instance per user. The config, sessions, credentials, and workspace are all instance-scoped. The obvious workaround would be to rewrite OpenClaw to be multi-tenant — this is the wrong move, because it would require months of architectural debate upstream and risks breaking every existing deployment.

**The elegant solution: run one OpenClaw container per agent.** Each container is single-user. The orchestrator creates multi-user semantics externally by spawning a fresh container per agent task. OpenClaw core stays exactly as it is.

This is also how Claude Managed Agents actually works under the hood — their engineering post describes stateless harnesses with many brains and many hands per session.

## Components

### Orchestrator (this repo)

A thin Node/TypeScript HTTP service. Exposes the managed agent API (`/v1/agents`, `/v1/agents/:id/run`, `/v1/sessions/:id`). Holds:

- `AgentRegistry` — in-memory `Map<agentId, AgentConfig>`. Phase 2 will back this with Postgres or Redis.
- `SessionRegistry` — in-memory `Map<sessionId, Session>` with status, output, token accounting. Phase 2 moves to a real store.
- `AgentRouter` — takes run requests, spawns a container, waits for `/readyz`, proxies the task to the container's `/v1/chat/completions`, captures the result, tears the container down.
- `DockerContainerRuntime` — spawns containers via dockerode on a shared Docker network.

### Agent container (Dockerfile.runtime)

A Docker image wrapping the `openclaw` npm package. At startup, the entrypoint script reads environment variables, generates a minimal `openclaw.json`, and execs `openclaw gateway run`. The container serves OpenClaw's existing OpenAI-compatible endpoint on port 18789.

Key config generated per container:

```json
{
  "gateway": {
    "port": 18789,
    "mode": "local",
    "bind": "lan",
    "allowInsecureAuth": true,
    "auth": { "mode": "none" },
    "http": {
      "endpoints": {
        "chatCompletions": { "enabled": true }
      }
    }
  },
  "agents": {
    "list": [{
      "id": "agt_xxx",
      "model": { "primary": "bedrock/anthropic.claude-sonnet-4-6" },
      "systemPromptOverride": "You are a research assistant."
    }]
  },
  "plugins": {
    "entries": {
      "amazon-bedrock": {
        "enabled": true,
        "config": { "discovery": { "enabled": true } }
      }
    }
  }
}
```

`chatCompletions.enabled` is critical — the OpenAI-compatible endpoint is disabled by default in OpenClaw.

**Model ID format:** the `bedrock/` prefix selects the amazon-bedrock provider; the part after it is the raw Bedrock model ID (either a foundation model like `anthropic.claude-3-5-sonnet-20241022-v2:0` or an inference profile like `anthropic.claude-sonnet-4-6`). The provider's discovery flow registers models under their raw IDs, so whatever `ListFoundationModels` / `ListInferenceProfiles` returns is what you pass here.

**Skill allowlist (omitted by default):** the entrypoint omits `agents.list[].tools.alsoAllow` entirely when `OPENCLAW_TOOLS` is empty, so the agent falls back to `agents.defaults.skills` (empty in our generated config → no tools wired). This is fine for pure-text MVP tasks. For tool-using agents, pass a comma-separated list of the skill IDs from the bundled OpenClaw `skills/` tree (real names include `github`, `coding-agent`, `notion`, `slack`, etc. — the project does not ship generic names like `web-search`).

### Session persistence

Each container bind-mounts `/workspace` from a host path. OpenClaw's existing session machinery writes JSONL files at `/workspace/agents/{agentId}/sessions/{sessionId}.jsonl`. When a container is torn down, the session files persist on the host volume. When a new run request comes in for the same agent (or with a specific session ID for resume), a new container is spawned with the same mount and OpenClaw's SessionManager reloads the session automatically.

For the MVP this is a local volume. Phase 2 replaces it with S3/GCS/Azure Blob via an upstream `SessionStorage` abstraction.

## Request flow

```
1.  Developer  → POST /v1/agents { model, tools, instructions }
                 Orchestrator records the config in AgentRegistry.
                 Response: { agent_id }

2.  Developer  → POST /v1/agents/agt_xxx/run { task }
                 Orchestrator creates a Session, returns { session_id, status: "running" }
                 (fire-and-track: the actual execution runs in the background)

3.  Background: Orchestrator calls runtime.spawn() with env vars derived from the
                agent config.
                runtime.spawn() → Docker API → new container on openclaw-net.
                Orchestrator waits for container's /readyz.
                Orchestrator POSTs to http://<container>:18789/v1/chat/completions
                  with the task as a single user message.
                OpenClaw's embedded agent loop runs tool-using multi-turn turns.
                The HTTP response contains the final completion.
                Orchestrator updates the Session with output + tokens.
                Orchestrator calls runtime.stop() to tear the container down.

4.  Developer  → GET /v1/sessions/ses_yyy
                 Orchestrator returns the Session from SessionRegistry.
```

## What stays in OpenClaw and what lives in the orchestrator

| Concern | Home |
|---|---|
| Agent loop (tool use, multi-turn) | OpenClaw (`src/gateway/openai-http.ts` → `agentCommandFromIngress` → embedded Pi runtime) |
| Tool execution | OpenClaw (plugin SDK, skills, sandbox) |
| Model provider integration | OpenClaw (`extensions/amazon-bedrock` etc.) |
| Session event log | OpenClaw (`src/config/sessions/session-file.ts`) |
| Managed-agent API surface | Orchestrator (this repo) |
| Multi-tenant isolation | Orchestrator (one container per agent) |
| Container lifecycle | Orchestrator (`src/runtime/docker.ts`) |
| Cloud adapters (Phase 2) | Orchestrator (`src/runtime/{ecs,cloudrun,...}.ts`) |

## Why this works with zero upstream changes

Everything the MVP needs already exists in OpenClaw:

| Need | Already exists |
|---|---|
| API-only startup | Yes — if no channels are configured, the gateway doesn't initialize any |
| HTTP agent API | Yes — `/v1/chat/completions` runs the full agent loop |
| Config from env | Yes — `OPENCLAW_CONFIG_PATH` env var points at a generated file |
| Health checks | Yes — `/healthz` and `/readyz` are built in |
| Bedrock provider | Yes — uses standard AWS credential chain |
| Session persistence | Yes — JSONL on disk, portable via mounted volume |
| Per-agent tool subsets | Yes — `agents.list[].tools.alsoAllow` |

Phase 2 will need upstream PRs to add a `SessionStorage` abstraction and cloud secrets backends, but the MVP requires none.
