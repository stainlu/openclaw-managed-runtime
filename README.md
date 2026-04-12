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
POST   /v1/agents
       body: { model, tools, instructions }
       response: { agent_id }

POST   /v1/agents/:agent_id/run
       body: { task }
       response: { session_id, status }

GET    /v1/sessions/:session_id
       response: { status, output, cost_usd, tokens, events }

DELETE /v1/agents/:agent_id
       response: { deleted: true }

GET    /healthz
       response: { ok: true }
```

## Quick start (local Docker)

Requires: Docker, Node 22+, AWS credentials with Bedrock access in your environment.

```bash
git clone https://github.com/stainlu/openclaw-managed-runtime
cd openclaw-managed-runtime
pnpm install
docker compose up --build
```

Then in another terminal:

```bash
# Create an agent
curl -X POST http://localhost:8080/v1/agents \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "bedrock/anthropic.claude-sonnet-4-6",
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

This is **early development**. See `docs/architecture.md` for the plan and `/Users/stainlu/.claude/plans/rosy-dreaming-backus.md` locally for the strategic context.

**Phase 1 (MVP, current):** Docker-based local runtime, Bedrock default, single-cloud (AWS), in-memory agent registry, volume-mount session storage.

**Phase 2 (next):** ECS/Fargate container backend, S3 session storage, cloud secrets (AWS Secrets Manager), deployment guides.

**Phase 3 (later):** GCP, Azure, Aliyun, Volcengine backends. Multi-tenant orchestrator. Enterprise features.

## License

MIT. See `LICENSE`.

## Relationship to OpenClaw

This project uses [OpenClaw](https://github.com/openclaw/openclaw) as an npm dependency. It is not a fork. All agent execution, tool invocation, session management, and provider integration comes from OpenClaw core. This repo adds only the managed layer on top: the orchestrator service, the container entrypoint, and the cloud-specific adapters.

When OpenClaw upstream is ready, this project will migrate to `openclaw/managed-runtime` as a sibling repo under the official organization.
