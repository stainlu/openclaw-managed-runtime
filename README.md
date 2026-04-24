# OpenClaw Managed Agents

The open alternative to Claude Managed Agents. Run autonomous AI agents via API — any model, any cloud, open source.

Built on [OpenClaw](https://github.com/openclaw/openclaw), the most popular open-source AI agent framework.

## What this is

**The name says it:** `openclaw-managed-agents` = **OpenClaw** (the agent runtime — multi-provider, 53 built-in skills, MCP-native, Pi's durable JSONL event log) + **Managed Agents** (the four-primitive API shape — Agent / Environment / Session / Event — that Claude Managed Agents made standard).

You POST an Agent (model + system prompt + tools + MCP servers), open a Session against it, send Events, stream back Events. Under the hood: one isolated Docker container per session running OpenClaw, SQLite for orchestrator metadata, SSE for streaming, WebSocket control plane for cancel / model-override / tool-confirmation. Deploy anywhere Docker runs.

It's the layer that turns OpenClaw from a personal AI assistant into a programmatic agent service your app can call.

## vs. Claude Managed Agents

| | Claude Managed Agents | OpenClaw Managed Agents |
|---|---|---|
| Models | Claude only | Any — Anthropic, OpenAI, Gemini, Moonshot, DeepSeek, Mistral, xAI, Bedrock, OpenRouter, Groq, and [more](https://openclaw.ai) |
| Hosting | Anthropic's cloud only | Any cloud or VPS with Docker — from $0/month (GCE free tier) to $4/month (Hetzner) |
| Source | Closed | Open source (MIT) |
| Platform tax | $0.08/session-hour on top of tokens | None |
| Data | Anthropic's infrastructure | Your disk, your VPC, your control |
| Multi-agent / subagents | Research preview (gated) | GA — children are first-class inspectable sessions |
| Permission policy | `always_allow` + `always_ask` | `always_allow` + `deny` + `always_ask` |
| Subagent observability | Opaque (tool result only) | First-class — every child session visible through the same API |
| Agent versioning | Immutable history + archive | Immutable history + archive + optimistic concurrency on `PATCH` |
| MCP servers | First-class `mcp_servers` field | First-class `mcpServers` field |
| Streaming | Real SSE token deltas | Real SSE token deltas |
| Restart safety | Not documented | Durable event queue, HMAC secret persistence, running-container adoption, observer-side run completion |
| Per-session quotas | Not exposed | `maxCostUsdPerSession`, `maxTokensPerSession`, `maxWallDurationMs` |
| Audit log | Telemetry only | Queryable `GET /v1/audit` |
| OpenTelemetry | Built-in | Config-passthrough to OpenClaw's built-in OTEL |
| SDK | 7 languages + CLI | Python + TypeScript + OpenAI drop-in |
| Production track record | Notion, Rakuten, Asana, Sentry, Vibecode | New project, no deployed customers yet |

Both are solid engineering. The choice is about model/cloud freedom, platform-tax economics, and whether you want the runtime as a black box or as code you can read.

## vs. running OpenClaw directly on a cloud VPS

[AWS's Lightsail OpenClaw blueprint](https://aws.amazon.com/blogs/aws/introducing-openclaw-on-amazon-lightsail-to-run-your-autonomous-private-ai-agents/) (or running OpenClaw yourself via its own CLI on a VPS) gives you a personal OpenClaw instance. That's great for *you* — one operator, one browser pairing, chat through WhatsApp / Telegram / Discord, use it as your Jarvis.

OpenClaw Managed Agents is for when you want to **build a product** with OpenClaw instead of just using one.

| | OpenClaw directly on a VPS (e.g. Lightsail blueprint) | OpenClaw Managed Agents |
|---|---|---|
| Who it's for | One human operator | Developers building programmatic agent products |
| Access | Browser pairing + SSH CLI | HTTP REST + SSE + WebSocket |
| Sessions | 1 shared operator pairing | N long-lived API sessions, 1 container each, isolated |
| Channels | WhatsApp / Telegram / Discord / Slack built-in | None — programmatic only |
| Agent management | Edit `openclaw.json` + restart the gateway | `POST /v1/agents` / `PATCH` / `archive` — versioned with optimistic concurrency, no restart needed |
| Session isolation | Single workspace | Per-session Docker container with cgroup limits + bind-mounted state |
| Restart safety | Personal data survives; in-flight work lost | Durable event queue, HMAC token persistence, container reattach on orchestrator restart |
| Concurrency | One user at a time | Warm pool + active pool; 5-7 concurrent sessions on a $4 Hetzner CAX11 |
| API shape | Gateway's OpenAI-compat + control plane | Full 4-primitive REST matching the Claude Managed Agents shape |
| Deploy | Click Lightsail blueprint | `./scripts/deploy-hetzner.sh` etc. |

Not a competitor to the personal OpenClaw — a different layer. OpenClaw is the framework inside each of our containers. This project is the managed service around it.

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
# Create an agent
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

Or point the **OpenAI SDK** at us — just change `base_url` and it Just Works, including real token-level streaming:

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:8080/v1",
    api_key="unused",
    default_headers={"x-openclaw-agent-id": "<your-agent-id>"},
)

# Non-streaming
r = client.chat.completions.create(
    model="placeholder",
    messages=[{"role": "user", "content": "Summarize the agent platform landscape."}],
)
print(r.choices[0].message.content)

# Streaming — real per-token SSE frames, not emulated
for chunk in client.chat.completions.create(
    model="placeholder",
    messages=[{"role": "user", "content": "Write a haiku about containers."}],
    stream=True,
):
    print(chunk.choices[0].delta.content or "", end="", flush=True)
```

## Core concepts

Four primitives, matching Claude Managed Agents' model:

| Concept | What it is | API |
|---|---|---|
| **Agent** | Reusable config: model, instructions, tools, MCP servers, permission policy, delegation rules, quotas. Versioned — updates create immutable history. | `POST/GET/PATCH/DELETE /v1/agents` |
| **Environment** | Container config: packages (pip / apt / npm), networking policy. Composed with agents at session time. | `POST/GET/DELETE /v1/environments` |
| **Session** | A running agent in an environment. Long-lived, multi-turn, one container per session. | `POST/GET/DELETE /v1/sessions` |
| **Event** | Messages, tool calls, thinking blocks, status changes in and out of a session. SSE streaming. | `POST/GET /v1/sessions/:id/events` |

## API reference

The orchestrator is self-documenting — `curl http://localhost:8080/` returns the full endpoint map.

**Agents** (versioned, archivable)

```
POST   /v1/agents                         # create
       body: { model, instructions, tools?, name?,
               permissionPolicy?, callableAgents?, maxSubagentDepth?,
               mcpServers?, quota? }
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

Per-session quotas (optional, on `quota`):
- `maxCostUsdPerSession` — refuse further turns once cumulative cost crosses the cap
- `maxTokensPerSession` — same, for `tokens_in + tokens_out`
- `maxWallDurationMs` — session expires after this many ms since creation

Rejected runs surface as `HTTP 429 quota_exceeded`.

**Environments** (container configuration)

```
POST   /v1/environments                   # { name, packages?: { pip?, apt?, npm? }, networking? }
GET    /v1/environments                   # list all
GET    /v1/environments/:id               # get one
DELETE /v1/environments/:id               # 409 if sessions reference it
```

Networking modes:
- `{"type":"unrestricted"}` (default) — full egress on the shared Docker bridge
- `{"type":"limited","allowedHosts":["api.openai.com","*.anthropic.com"]}` — per-session confined `--internal` network + egress-proxy sidecar. HTTP/HTTPS filtered at TCP 8118, DNS filtered at UDP 53. Enforced at the Docker bridge, not inside the agent container; raw-socket / DNS-exfil paths both closed. Enable by setting `OPENCLAW_EGRESS_PROXY_IMAGE` + `OPENCLAW_CONTROL_PLANE_NETWORK` on the orchestrator. See [`docs/designs/networking-limited.md`](./docs/designs/networking-limited.md) and [`test/e2e-networking.sh`](./test/e2e-networking.sh) for the design + 9-case enforcement proof.

**Sessions** (the main interaction surface)

```
POST   /v1/sessions                       # { agentId, environmentId? }
GET    /v1/sessions                       # list all
GET    /v1/sessions/:id                   # status, output, rolling tokens, cost_usd
DELETE /v1/sessions/:id                   # tears down container + data
POST   /v1/sessions/:id/events            # send message or tool confirmation (see below)
GET    /v1/sessions/:id/events            # full event history
GET    /v1/sessions/:id/events?stream=true  # SSE: catch-up + live tail-follow
                                           # supports Last-Event-ID header for resume
POST   /v1/sessions/:id/cancel            # abort in-flight run
```

POST events accepts two event types:
- `{"content":"...","model":"..."}` — user message (triggers agent loop, optional model override)
- `{"type":"user.tool_confirmation","toolUseId":"<approval_id>","result":"allow"}` — resolve a pending tool confirmation (`toolUseId` is a legacy field name; pass the `approval_id` from the SSE event)

**OpenAI compatibility**

```
POST   /v1/chat/completions              # OpenAI SDK drop-in (x-openclaw-agent-id header required)
```

Real per-token SSE streaming when `stream: true`. Busy sessions return `HTTP 409 session_busy` so streams don't interleave with the event queue.

**Audit log**

```
GET    /v1/audit?since=<ts>&until=<ts>&action=<verb>&target=<id>&limit=<n>
                                          # queryable structured log of mutating API calls;
                                          # all params optional; `action` supports LIKE
                                          # wildcards (e.g. "agent.%"); newest-first, limit
                                          # 1..1000 (default 100).
                                          # retained OPENCLAW_AUDIT_RETENTION_DAYS (default 30)
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

The SSE stream emits an initial status event on connect, checks for status transitions on every yielded event + every 15-second heartbeat, and accepts a resume cursor via the `Last-Event-ID` header or `?after=<event_id>` query param so reconnecting clients don't replay history they've already seen.

## Key features

**Agent versioning.** Every update creates an immutable version. Optimistic concurrency via `version` field on PATCH. List the full history. Archive agents without losing data.

**Permission policy.** Three modes: `always_allow` (default), `deny` (block specific tools entirely), and `always_ask` (pause for client confirmation before executing specific tools). The `always_ask` flow uses OpenClaw's `before_tool_call` plugin hook with `requireApproval` — the agent blocks, the orchestrator surfaces a confirmation request via SSE (`approval_id` for resolution, `tool_call_id` for correlation), rehydrates pending approvals from the gateway on warm reuse / adoption, and the client resolves it via `user.tool_confirmation`.

**MCP servers.** Agents declare `mcpServers` (object keyed by server name, value is either a stdio `{command, args, env, cwd}` or HTTP `{url, headers}` config). The orchestrator forwards them into the container's `openclaw.json` at spawn time; OpenClaw's MCP integration handles the rest. Matches Claude Managed Agents' shape so SDKs porting across translate without rewrites.

**Per-session quotas.** `maxCostUsdPerSession` / `maxTokensPerSession` / `maxWallDurationMs` set on the agent (inherited by every session derived from it). Enforced at the runtime edge before each turn; rejected runs return `HTTP 429 quota_exceeded` with a `quota_rejections_total{kind="cost"|"tokens"|"duration"}` metric increment. Soft-ceiling semantics: a session at $0.99 with a $1.00 cap gets one more turn, the next post rejects — matches operator intent without mid-turn aborts.

**Networking: `limited`.** Per-session confined `--internal` Docker network + egress-proxy sidecar filtering hostname allowlist at HTTP + DNS layers. Enforcement at the Docker bridge, not inside the container — raw-socket / DNS-exfil paths both closed. Proven with a 9-case E2E script in CI on native Linux (`test/e2e-networking.sh`).

**Pre-warmed container pool.** When a non-delegating agent is created, a template-level container boots in the background. The first session whose boot config is also template-level claims the pre-warmed container instead of cold-spawning. Sessions with session-specific boot inputs (vault credentials, `networking: limited`, package preinstalls) bypass warm reuse and cold-spawn their own sandbox. After a warm claim, the pool replenishes automatically. Active containers are reaped after `OPENCLAW_IDLE_TIMEOUT_MS` (default 10 min) of no use; the warm bucket is bounded by `OPENCLAW_MAX_WARM_CONTAINERS` (default 5) with oldest-first eviction. Measured pool reuse: 4 s vs 78 s cold-start on Hetzner CAX11.

**Delegated subagents.** An agent can delegate tasks to other agents via the `openclaw-call-agent` CLI. Children are first-class sessions — fully inspectable through the same API. Allowlists, depth caps, and HMAC-signed tokens enforce who can call whom. Subagent transcripts are not hidden behind an opaque tool result.

**Real token-level streaming on `POST /v1/chat/completions`.** `stream: true` pipes the container's real SSE chunks byte-for-byte to the caller — OpenAI-compatible `ChatCompletionChunk` frames with `[DONE]` terminator. A busy session returns `HTTP 409 session_busy` so streams don't interleave with the event queue; client disconnect aborts the relay but the container's turn continues server-side (Pi's JSONL retains truth).

**Restart safety.** Four invariants that survive orchestrator crash or deploy:
1. Parent-token HMAC secret persisted to SQLite — outstanding subagent delegation tokens stay valid across restarts.
2. Durable event queue (SQLite) — committed `{queued: true}` events are re-dispatched on startup.
3. Running-container adoption — `DockerContainerRuntime.listManaged()` + `SessionContainerPool.adopt()` reattach labelled containers whose sessions still exist; orphaned containers are selectively stopped. Running sessions that can't be adopted get a recoverable `"post a new message to resume"` error.
4. Observer-side run completion — WS `chat` event subscription on adopted running sessions finalizes the in-flight turn when Pi emits the final message, rolls up cost from JSONL, drains queued events.

**Cancel + queue.** Cancel aborts the in-flight run via the WebSocket control plane. Events posted to a busy session queue automatically and drain in order.

**Per-turn cost.** Each session tracks rolling `tokens_in`, `tokens_out`, and `cost_usd` from the provider's own billing data — cache-aware, not a static price sheet. Anthropic, OpenAI, Google, xAI, Mistral, OpenRouter, and Bedrock auto-report non-zero cost with no config. Moonshot and DeepSeek direct-provider v4 models currently get real non-zero cost via the runtime's `provider-prices.json` patches layered onto the bundled catalog; when upstream ships the same prices and model ids, deleting the local provider block cleanly defers back to upstream.

**OpenAI SDK drop-in.** Point any OpenAI SDK at `http://<host>:8080/v1` with an `x-openclaw-agent-id` header. Sticky sessions via the `user` field. Real per-token streaming (not emulated) when `stream: true`.

**Per-end-user credential vault.** `POST /v1/vaults {userId, name}` creates a bundle. `POST /v1/vaults/:id/credentials {name, type: "static_bearer", matchUrl, token}` adds a credential — the `token` is accepted on write but never returned from any GET/LIST (rotation = delete + re-add). `POST /v1/sessions {agentId, vaultId}` binds a vault to a session; at spawn time, the orchestrator walks `agent.mcpServers`, longest-prefix-matches each HTTP server's URL against vault `matchUrl`s, and merges `Authorization: Bearer <token>` into the server's headers before the container boots. Secret material never leaves the orchestrator. Vault-bound sessions bypass the warm pool (container env is immutable post-create, so a warm container can't carry session-specific credentials).

**First-party Telegram adapter.** `docker compose --profile telegram up -d` after setting `TELEGRAM_BOT_TOKEN` + `OPENCLAW_TELEGRAM_AGENT_ID` in `.env` brings up a bridge between Telegram chats and managed-agent sessions. Long-polling (no public HTTPS needed), session-per-chat, typing indicator, auto-split of long replies. Sessions persist across adapter restarts via `/state/chats.json`. See [`docker/telegram-adapter/README.md`](./docker/telegram-adapter/README.md).

**Persistent state.** SQLite (WAL mode) for agents, environments, session metadata, queued events, audit log, and the HMAC secret for subagent tokens. Pi's JSONL files for the event log. All of it survives orchestrator restarts. Pre-built multi-arch images (amd64 + arm64) published to GHCR on every push to `main`.

**Observability.** Structured pino logs in JSON (production) or pretty TTY (dev); every log line carries `request_id`, `agent_id`, `session_id` automatically via AsyncLocalStorage. Prometheus metrics at `GET /metrics` — HTTP counters + duration histograms, pool active/warm gauges, spawn + run duration histograms, per-source pool-acquire counters, quota rejections, JSONL size gauge with configurable warn threshold, startup adoption outcomes, rate-limit rejections. OpenTelemetry config-passthrough: set `OTEL_EXPORTER_OTLP_ENDPOINT` (and optional `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_SERVICE_NAME`, etc.) and OpenClaw's built-in OTEL exporter turns on traces + metrics + logs at boot. See [docs/architecture.md#observability](./docs/architecture.md#observability).

**Structured audit log.** Every mutating API call writes a row to `audit_events` (SQLite): `ts`, `request_id`, `actor` (token fingerprint or IP), `action`, `target`, `outcome`, optional metadata. Queryable via `GET /v1/audit?since=&until=&action=&target=&limit=` (all optional; `action` accepts LIKE wildcards like `agent.%`; newest-first; limit 1-1000, default 100). Retention via `OPENCLAW_AUDIT_RETENTION_DAYS` (default 30); hourly cleanup.

**Baseline bearer-token auth.** Set `OPENCLAW_API_TOKEN=<random-secret>` on the orchestrator host and every request must attach `Authorization: Bearer <token>` — except `/healthz` and `/metrics` (infra endpoints). Unset = auth disabled (localhost dev default). One-command rotation on any live deploy: `./scripts/rotate-api-token.sh hetzner|lightsail|gcp|local <host-or-instance>` (generates + applies + verifies with a 401-then-200 curl pair).

**Rate limiting.** Per-caller token-bucket in front of every route except `/healthz` and `/metrics`. Keyed by Bearer token when present, else client IP (`x-forwarded-for` first entry, else peer). Defaults to 120 req/min (2 req/s sustained, 120-burst). Override via `OPENCLAW_RATE_LIMIT_RPM` (0 = disabled). Runs BEFORE auth so unauthenticated floods can't exhaust the orchestrator even while auth middleware rejects them. Rejections surface as HTTP 429 with a `Retry-After` header and increment `rate_limit_rejections_total{kind="token"|"ip"}` on `/metrics`.

## Deploy

Three one-command deploy scripts, each using the same `DockerContainerRuntime` and the same multi-arch GHCR images.

### Hetzner Cloud (from $4/month)

```bash
export HCLOUD_TOKEN=<your-token>          # console.hetzner.cloud -> Security -> API Tokens
export MOONSHOT_API_KEY=sk-...            # or any provider key
./scripts/deploy-hetzner.sh
```

Measured on CAX11 (2 vCPU / 4 GB ARM, $4/month): 78 s cold start, 4 s pool reuse, 5-7 concurrent sessions.
[Full guide](./docs/deploying-on-hetzner.md)

### AWS Lightsail (from $12/month)

```bash
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
export MOONSHOT_API_KEY=sk-...
./scripts/deploy-aws-lightsail.sh
```

Measured on medium_3_0 (2 vCPU / 4 GB, $24/month): 294 s cold start, 5 s pool reuse, 5-7 concurrent sessions.
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

### Routine redeploy on an existing VM

```bash
ssh <user>@<host> 'cd /opt/openclaw && git pull && docker compose pull && docker pull ghcr.io/stainlu/openclaw-managed-agents-egress-proxy:latest && docker compose up -d'
```

Use `root` on the Hetzner path. On Lightsail and GCE, `/opt/openclaw` is root-owned, so wrap the inner command with `sudo bash -lc '...'`.

### Cost by deployment target (infrastructure only, no token costs)

| | 1 session 24/7 | 10 sessions 24/7 | 100 sessions 24/7 |
|---|---|---|---|
| **Claude Managed Agents** (for reference) | $57.60/mo | $576/mo | $5,760/mo |
| **Hetzner CAX11** | $4/mo | $8/mo (2 hosts) | $73/mo (17 hosts) |
| **AWS Lightsail medium_3_0** | $24/mo | $48/mo (2 hosts) | $408/mo (17 hosts) |
| **GCE e2-medium** | $25/mo | $50/mo (2 hosts) | $425/mo (17 hosts) |
| **GCE e2-micro** (free tier) | $0/mo* | $0/mo (1 host, 1 instance free-tier limit) | n/a |

*Free tier: 1 `e2-micro` in us-east1 / us-central1 / us-west1; 30 GB PD; 1 GB egress/month. Beyond the free tier, `e2-micro` is ~$7/mo. Token costs are separate and depend on the provider + model you choose.

## Architecture

```
Developer's app
     |
     | HTTP REST + SSE + WebSocket
     v
Orchestrator (Hono, TypeScript)
  |-- AgentStore + EnvironmentStore + SessionStore (SQLite, WAL)
  |-- QueueStore (durable per-session event queue)
  |-- SecretStore (HMAC secret for subagent tokens)
  |-- AuditStore (structured audit log with retention)
  |-- SessionContainerPool (per-session active + template-level warm pool + adopt on restart)
  |-- GatewayWebSocketClient (cancel, model override, tool confirmation, observer-resume)
  |-- PiJsonlEventReader (event log, cost, SSE, size sampler)
  |-- ParentTokenMinter (HMAC-SHA256 subagent auth, persisted)
  |
  v
OpenClaw containers (one per session, isolated)
  - Full agent loop (tool use, multi-turn, thinking)
  - Pi SessionManager (append-only JSONL)
  - Session resume from JSONL across container restarts
  - confirm-tools plugin (always_ask policy enforcement)
  - call-agent CLI (delegated subagent spawning)
  - egress-proxy sidecar (networking: limited enforcement)
  - openclaw's built-in OTEL exporter (when configured)
```

The orchestrator keeps only ephemeral caches in memory; all commitments live in SQLite and Pi's JSONL. Restart reattaches running containers, drains queued events, and subscribes to WS broadcasts to finalize in-flight turns. Pre-built multi-arch images (amd64 + arm64) are published to GHCR on every push to `main`.

## Test status

**195 tests pass**, covering unit + restart-safety + contract + integration shapes:

- Session-centric resume (multi-turn memory across turns, across container restart, across orchestrator restart)
- Cost accounting from provider billing data
- SQLite persistence across orchestrator restart (migrations, additive columns, audit retention)
- Durable event queue (FIFO, per-session isolation, survives close + reopen)
- HMAC secret persistence (outstanding subagent tokens survive deploys)
- Container pool adoption (reattach running + stop orphan + selectively fail unrecoverable)
- Observer-side run completion (WS `chat` event → finalize from JSONL, idempotent)
- Container pool reuse (4 s warm vs 78 s cold)
- Real SSE token streaming via OpenAI-compat endpoint
- SSE event stream with `Last-Event-ID` resume cursor
- Cancel via WebSocket control plane
- Event queue with ordered drain
- OpenAI SDK compatibility (shape, multi-turn memory, streaming, queue race)
- Delegated subagents (inspectable child sessions)
- Subagent allowlist rejection + depth-cap rejection
- Agent versioning (create, update, no-op detection, conflict rejection, archive)
- Environment abstraction (CRUD, session binding, deletion rejection, backward compat)
- Networking: `limited` enforcement (9-case E2E: allowed proxy, denied proxy, raw socket blocked, AWS IMDS blocked both layers, DNS NXDOMAIN, DNS resolve, sidecar logs)
- Per-session quotas (cost / tokens / duration refused pre-turn)
- Audit log (record, list with filters, retention)
- Permission policy (deny + always_ask approval flow)
- ContainerRuntime contract (any backend passing the shared suite is drop-in)

## Relationship to OpenClaw

This project uses [OpenClaw](https://github.com/openclaw/openclaw) as an npm dependency, not a fork. All agent execution, tool invocation, session management, provider integration, and 53 built-in skills come from OpenClaw core. This repo adds the managed layer: the orchestrator, the container lifecycle, the 4-primitive REST API, the deploy scripts, the restart-safety + audit + quota + observability primitives.

Think of OpenClaw as the runtime framework (the personal AI assistant) and OpenClaw Managed Agents as the cloud service around it (the programmatic agent platform your app calls). OpenClaw-the-framework stays personal and single-user; we bring the multi-session, API-first, restart-safe service layer.

## License

MIT
