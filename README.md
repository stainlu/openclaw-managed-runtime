# OpenClaw Managed Agents

The open alternative to Claude Managed Agents. Run autonomous AI agents via API — any model, any cloud, open source.

Built on [OpenClaw](https://github.com/openclaw/openclaw), the most popular open-source AI agent framework.

## Why this exists

Anthropic's [Claude Managed Agents](https://www.anthropic.com/engineering/managed-agents) is Claude-only, Anthropic-hosted, and charges $0.08/session-hour on top of tokens. OpenClaw Managed Agents is the open counter: same architectural pattern (stateless orchestrator + per-session container + append-only event log), but you pick the model, you pick the cloud, and there's no platform tax.

| | Claude Managed Agents | OpenClaw Managed Agents |
|---|---|---|
| Models | Claude only | Any — Anthropic, OpenAI, Gemini, Moonshot, DeepSeek, Mistral, xAI, and [15+ more](https://openclaw.ai) |
| Hosting | Anthropic's cloud only | Any cloud or VPS with Docker — from $0/month (Oracle free tier) to $4/month (Hetzner) |
| Source | Closed | Open source (MIT) |
| Platform tax | $0.08/session-hour | None |
| Data | Anthropic's infrastructure | Your disk, your VPC, your control |
| Multi-agent | Research preview (gated) | GA — inspectable child sessions, allowlists, depth caps |
| Permission policy | `always_allow` + `always_ask` | `always_allow` + `deny` + `always_ask` |
| Subagent observability | Opaque (tool result only) | First-class — every child session is inspectable via the same API |
| Event types | 12+ types | 10 types + synthetic session status events |
| Agent versioning | Immutable history | Immutable history + optimistic concurrency + archive |
| SDK | 7 languages + CLI | Python + TypeScript + OpenAI drop-in |

## Quick start

Requires Docker and an API key for any [OpenClaw-supported provider](https://openclaw.ai).

```bash
git clone https://github.com/stainlu/openclaw-managed-agents
cd openclaw-managed-agents

export MOONSHOT_API_KEY=sk-...    # or ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, etc.
docker compose up --build -d
```

Create an agent, open a session, send a message:

```bash
# Create an agent template
AGENT=$(curl -s -X POST http://localhost:8080/v1/agents \
  -H 'Content-Type: application/json' \
  -d '{"model":"moonshot/kimi-k2.5","instructions":"You are a research assistant."}' \
  | jq -r '.agent_id')

# Open a session (container starts booting in the background)
SESSION=$(curl -s -X POST http://localhost:8080/v1/sessions \
  -H 'Content-Type: application/json' \
  -d "{\"agentId\":\"$AGENT\"}" | jq -r '.session_id')

# Send a message — first turn spawns the container; subsequent turns reuse it
curl -s -X POST "http://localhost:8080/v1/sessions/$SESSION/events" \
  -H 'Content-Type: application/json' \
  -d '{"content":"What is 2+2? Reply with just the number."}'

# Poll until done
while [ "$(curl -s http://localhost:8080/v1/sessions/$SESSION | jq -r .status)" = "running" ]; do sleep 2; done

# Read the answer
curl -s "http://localhost:8080/v1/sessions/$SESSION" | jq .output
```

Or use the Python SDK:

```python
from openclaw_managed_agents import OpenClawClient

client = OpenClawClient(base_url="http://localhost:8080")
agent = client.agents.create(model="moonshot/kimi-k2.5", instructions="You are helpful.")
session = client.sessions.create(agent_id=agent.agent_id)
client.sessions.send(session.session_id, content="What is 2+2?")
for event in client.sessions.stream(session.session_id):
    if event.type == "agent.message":
        print(event.content)
        break
```

See [`examples/research-assistant/`](./examples/research-assistant/) for a ~200-line copy-paste starting point that streams events in real time.

Or use the TypeScript SDK:

```ts
import { OpenClawClient } from "@stainlu/openclaw-managed-agents";

const client = new OpenClawClient({ baseUrl: "http://localhost:8080" });
const agent = await client.agents.create({ model: "moonshot/kimi-k2.5", instructions: "You are helpful." });
const session = await client.sessions.create({ agentId: agent.agent_id });
await client.sessions.send(session.session_id, { content: "What is 2+2?" });
for await (const event of client.sessions.stream(session.session_id)) {
  if (event.type === "agent.message") { console.log(event.content); break; }
}
```

Or use the OpenAI SDK — just change `base_url`:

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:8080/v1",
    api_key="unused",
    default_headers={"x-openclaw-agent-id": "<your-agent-id>"},
)

r = client.chat.completions.create(
    model="placeholder",
    messages=[{"role": "user", "content": "Summarize the agent platform landscape."}],
)
print(r.choices[0].message.content)
```

## Core concepts

Four primitives, matching Claude Managed Agents' model:

| Concept | What it is | API |
|---|---|---|
| **Agent** | Reusable config: model, instructions, tools, permission policy, delegation rules. Versioned — updates create immutable history. | `POST/GET/PATCH/DELETE /v1/agents` |
| **Environment** | Container config: packages (pip/apt/npm), networking. Composed with agents at session time. | `POST/GET/DELETE /v1/environments` |
| **Session** | A running agent in an environment. Long-lived, multi-turn, one container per session. | `POST/GET/DELETE /v1/sessions` |
| **Event** | Messages, tool calls, thinking blocks, status changes in and out of a session. SSE streaming. | `POST/GET /v1/sessions/:id/events` |

## API reference

The orchestrator is self-documenting — `curl http://localhost:8080/` returns the full endpoint map.

**Agents** (versioned, archivable)

```
POST   /v1/agents                         # create
       body: { model, instructions, tools?, name?,
               permissionPolicy?, callableAgents?, maxSubagentDepth? }
GET    /v1/agents                         # list all
GET    /v1/agents/:id                     # get latest version
PATCH  /v1/agents/:id                     # update — { version, ...fields }, 409 on conflict
GET    /v1/agents/:id/versions            # immutable version history
POST   /v1/agents/:id/archive             # soft-delete; blocks new sessions
DELETE /v1/agents/:id                     # hard-delete
```

Permission policy options for `permissionPolicy`:
- `{"type":"always_allow"}` (default) — all tools execute automatically
- `{"type":"deny","tools":["bash","write"]}` — specified tools are blocked entirely
- `{"type":"always_ask","tools":["bash"]}` — specified tools pause for client confirmation via `user.tool_confirmation`

**Environments** (container configuration)

```
POST   /v1/environments                   # { name, packages?: { pip?, apt?, npm? }, networking? }
GET    /v1/environments                   # list all
GET    /v1/environments/:id               # get one
DELETE /v1/environments/:id               # 409 if sessions reference it
```

**Sessions** (the main interaction surface)

```
POST   /v1/sessions                       # { agentId, environmentId? }
GET    /v1/sessions                       # list all
GET    /v1/sessions/:id                   # status, output, rolling tokens, cost_usd
DELETE /v1/sessions/:id                   # tears down container + data
POST   /v1/sessions/:id/events            # send message or tool confirmation (see below)
GET    /v1/sessions/:id/events            # full event history
GET    /v1/sessions/:id/events?stream=true  # SSE: catch-up + live tail-follow
POST   /v1/sessions/:id/cancel            # abort in-flight run
```

POST events accepts two event types:
- `{"content":"...","model":"..."}` — user message (triggers agent loop, optional model override)
- `{"type":"user.tool_confirmation","toolUseId":"...","result":"allow"}` — resolve a pending tool confirmation

**OpenAI compatibility**

```
POST   /v1/chat/completions              # OpenAI SDK drop-in (x-openclaw-agent-id header required)
```

## Event types

Events from `GET /v1/sessions/:id/events` and the SSE stream:

| Type | Source | Description |
|---|---|---|
| `user.message` | JSONL | Client message posted via POST /events |
| `agent.message` | JSONL | Agent's text response with tokens, cost, model |
| `agent.tool_use` | JSONL | Tool invocation: name, arguments, call ID |
| `agent.tool_result` | JSONL | Tool execution result (content, isError) |
| `agent.thinking` | JSONL | Thinking blocks (when model supports extended thinking) |
| `agent.tool_confirmation_request` | Orchestrator | Tool paused for client approval (`always_ask` policy) |
| `session.model_change` | JSONL | Model switched mid-session |
| `session.thinking_level_change` | JSONL | Thinking mode toggled |
| `session.compaction` | JSONL | Context compaction summary |
| `session.status_idle` | SSE only | Session transitioned to idle |
| `session.status_running` | SSE only | Session transitioned to running |
| `session.status_failed` | SSE only | Session transitioned to failed |

The SSE stream emits an initial status event on connect and checks for status transitions on every yielded event and every 15-second heartbeat.

## Key features

**Agent versioning.** Every update creates an immutable version. Optimistic concurrency via `version` field on PATCH. List the full history. Archive agents without losing data.

**Permission policy.** Three modes: `always_allow` (default), `deny` (block specific tools entirely), and `always_ask` (pause for client confirmation before executing specific tools). The `always_ask` flow uses OpenClaw's `before_tool_call` plugin hook with `requireApproval` — the agent blocks, the orchestrator surfaces a confirmation request via SSE, and the client resolves it via `user.tool_confirmation`.

**Environments.** Declare packages (`pip`, `apt`, `npm`) and networking policy per environment. Compose any agent with any environment at session creation. Packages install inside the container before the agent boots. Two properties worth calling out: `networking: "limited"` enforces a hostname allowlist per session via a confined `--internal` Docker network + an egress-proxy sidecar that filters HTTP/HTTPS at TCP 8118 and DNS at UDP 53 (see [`docs/designs/networking-limited.md`](./docs/designs/networking-limited.md) and [`test/e2e-networking.sh`](./test/e2e-networking.sh) for the 9-case enforcement proof, run in CI on native Linux); enable by setting `OPENCLAW_EGRESS_PROXY_IMAGE` + `OPENCLAW_CONTROL_PLANE_NETWORK`; and `npm install` runs arbitrary package postinstall scripts at container boot, so when agent creation is open to untrusted users, package names should come from a trusted source.

**Pre-warmed container pool.** When a non-delegating agent is created, a container boots in the background. The first session on that agent claims the pre-warmed container instead of cold-spawning. After claiming, the pool replenishes automatically. Active containers are reaped after `OPENCLAW_IDLE_TIMEOUT_MS` (default 10 min) of no use; the warm bucket is bounded by `OPENCLAW_MAX_WARM_CONTAINERS` (default 5) with oldest-first eviction and reaps entries after `OPENCLAW_WARM_IDLE_TIMEOUT_MS`. Pool reuse measured at 4s vs 78s cold-start. Delegating agents (`callableAgents` or `maxSubagentDepth > 0`) skip warm-up to keep subagent token lineage correct.

**Delegated subagents.** An agent can delegate tasks to other agents via the `openclaw-call-agent` CLI. Children are first-class sessions — fully inspectable through the same API. Allowlists, depth caps, and HMAC-signed tokens enforce who can call whom. Unlike Claude Managed Agents, subagent transcripts are not hidden behind an opaque tool result.

**Rich event stream.** 10 event types from the JSONL (messages, tool calls, tool results, thinking blocks, model changes, compaction summaries) plus synthetic session status events in the SSE stream. `GET /v1/sessions/:id/events?stream=true` catches up on past events then tail-follows new ones in real time.

**Cancel + queue.** Cancel aborts the in-flight run via the WebSocket control plane. Events posted to a busy session queue automatically and drain in order.

**Per-turn cost.** Each session tracks rolling `tokens_in`, `tokens_out`, and `cost_usd` from the provider's own billing data — cache-aware, not a static price sheet. Anthropic, OpenAI, Google, xAI, Mistral, OpenRouter, and Bedrock auto-report non-zero cost with no config. Moonshot's upstream catalog currently ships zero prices (real prices tracked in [openclaw/openclaw#67928](https://github.com/openclaw/openclaw/pull/67928)); once that PR lands and the openclaw pin bumps, Moonshot reports real cost via the same path with zero runtime changes.

**OpenAI SDK drop-in.** Point any OpenAI SDK at `http://<host>:8080/v1` with an `x-openclaw-agent-id` header. Sticky sessions via the `user` field. `stream: true` pipes real token-level SSE chunks from the provider through the container's OpenClaw gateway straight to the client (OpenAI-compatible `ChatCompletionChunk` frames with `[DONE]` terminator) — a busy session returns HTTP 409 `session_busy` so streaming doesn't interleave with the event queue.

**Persistent state.** SQLite (WAL mode) for agent templates, environments, and session metadata. Pi's JSONL files for the event log. Both survive orchestrator restarts. Pre-built multi-arch images (amd64 + arm64) published to GHCR on every push to `main`.

**Observability.** Structured pino logs in JSON (production) or pretty TTY (dev); every log line carries `request_id`, `agent_id`, `session_id` automatically via AsyncLocalStorage. Prometheus metrics at `GET /metrics` — HTTP counters + duration histograms, pool active/warm gauges, spawn + run duration histograms, per-source pool-acquire counters. See [docs/architecture.md#observability](./docs/architecture.md#observability).

**Baseline bearer-token auth.** Set `OPENCLAW_API_TOKEN=<random-secret>` on the orchestrator host and every request must attach `Authorization: Bearer <token>` — except `/healthz` and `/metrics` (infra endpoints). Unset = auth disabled (localhost dev default). One token per deployment, matching Claude Managed Agents' API-key depth. Multi-tenancy / per-user ACLs are deliberately out of scope today; stack a reverse proxy (Caddy, Cloudflare Access) when you need them. One-command rotation on any live deploy: `./scripts/rotate-api-token.sh hetzner|lightsail|gcp|local <host-or-instance>` (generates + applies + verifies with a 401-then-200 curl pair).

**Rate limiting.** Per-caller token-bucket in front of every route except `/healthz` and `/metrics`. Keyed by Bearer token when present, else client IP (`x-forwarded-for` first entry, else peer). Defaults to 120 req/min (2 req/s sustained, 120-burst). Override via `OPENCLAW_RATE_LIMIT_RPM` (0 = disabled). Runs BEFORE auth so unauthenticated floods can't exhaust the orchestrator even while auth middleware rejects them. Rejections surface as HTTP 429 with a `Retry-After` header and increment `rate_limit_rejections_total{kind="token"|"ip"}` on the metrics endpoint.

## Deploy

Three one-command deploy scripts, each using the same `DockerContainerRuntime` and the same multi-arch GHCR images.

### Hetzner Cloud (from $4/month)

```bash
export HCLOUD_TOKEN=<your-token>          # console.hetzner.cloud -> Security -> API Tokens
export MOONSHOT_API_KEY=sk-...            # or any provider key
./scripts/deploy-hetzner.sh
```

Measured on CAX11 (2 vCPU / 4 GB ARM, $4/month): 78s cold start, 4s pool reuse, 5-7 concurrent sessions.
[Full guide](./docs/deploying-on-hetzner.md)

### AWS Lightsail (from $12/month)

```bash
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
export MOONSHOT_API_KEY=sk-...
./scripts/deploy-aws-lightsail.sh
```

Measured on medium_3_0 (2 vCPU / 4 GB, $24/month): 294s cold start, 5s pool reuse, 5-7 concurrent sessions.
[Full guide](./docs/deploying-on-aws-lightsail.md)

### Google Cloud Compute Engine (from $0/month on free tier, $25/month default)

```bash
gcloud auth login                          # once per machine
gcloud config set project <your-project>   # once per machine
export MOONSHOT_API_KEY=sk-...
./scripts/deploy-gcp-compute.sh
```

`e2-medium` (1 vCPU burstable / 4 GB / 20 GB PD, ~$25/month) is the default and matches the Hetzner/Lightsail capacity floor. Override `GCE_MACHINE_TYPE=e2-micro` for the Always Free tier ($0/mo in us-east1/us-central1/us-west1, 1 GB RAM — good for smoke testing). GCE's NVMe-backed disk puts first-turn cold spawn in Hetzner territory (~80 s), not Lightsail territory (~5 min).
[Full guide](./docs/deploying-on-gcp-compute.md)

### Cost comparison (infrastructure only, no token costs)

| | 1 session 24/7 | 10 sessions 24/7 | 100 sessions 24/7 |
|---|---|---|---|
| **Claude Managed Agents** | $57.60/mo | $576/mo | $5,760/mo |
| **Hetzner CAX11** | $4/mo | $8/mo (2 hosts) | $73/mo (17 hosts) |
| **AWS Lightsail medium_3_0** | $24/mo | $48/mo (2 hosts) | $408/mo (17 hosts) |
| **GCE e2-medium** | $25/mo | $50/mo (2 hosts) | $425/mo (17 hosts) |
| **GCE e2-micro (free tier)** | $0/mo* | $0/mo (1 host, 1 instance free-tier limit) | n/a |

*Free tier: 1 `e2-micro` instance in us-east1, us-central1, or us-west1; 30 GB PD; 1 GB egress/month. Beyond the free tier, `e2-micro` is ~$7/mo.

## Architecture

```
Developer
   |
   | HTTP API (Hono)
   v
Orchestrator
   |-- AgentStore + EnvironmentStore + SessionStore (SQLite, WAL)
   |-- SessionContainerPool (per-session active + per-agent pre-warmed)
   |-- GatewayWebSocketClient (cancel, model override, tool confirmation)
   |-- PiJsonlEventReader (event log, cost, SSE)
   |-- ParentTokenMinter (HMAC-SHA256 subagent auth)
   |
   v
OpenClaw containers (one per session)
   - Full agent loop (tool use, multi-turn, thinking)
   - Pi SessionManager (append-only JSONL)
   - Session resume from JSONL across container restarts
   - confirm-tools plugin (always_ask policy enforcement)
   - call-agent CLI (delegated subagent spawning)
```

The orchestrator is stateless — all durable state lives in SQLite (agents, environments, sessions) and Pi's JSONL files (events). Pre-built multi-arch images (amd64 + arm64) are published to GHCR on every push to `main`.

## Test status

28 end-to-end checks, all passing against real Moonshot Kimi K2.5:

- Session-centric resume (multi-turn memory across turns)
- Cost accounting from provider billing data
- SQLite persistence across orchestrator restart
- Container pool reuse (41s faster than cold-start)
- SSE live event streaming
- Cancel via WebSocket control plane
- Event queue with ordered drain
- OpenAI SDK compatibility (shape, multi-turn memory, streaming, queue race)
- Delegated subagents (inspectable child sessions)
- Rich event stream (tool_use + tool_result events)
- Subagent allowlist rejection
- Agent versioning (create, update, no-op detection, conflict rejection, archive)
- Environment abstraction (CRUD, session binding, deletion rejection, backward compat)

## Relationship to OpenClaw

This project uses [OpenClaw](https://github.com/openclaw/openclaw) as an npm dependency, not a fork. All agent execution, tool invocation, session management, and provider integration comes from OpenClaw core. This repo adds the managed layer: the orchestrator, the container lifecycle, the API, and the deploy scripts.

## License

MIT
