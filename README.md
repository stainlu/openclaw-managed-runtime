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
   │ POST /v1/agents                     create reusable template
   │ POST /v1/sessions                   open long-lived session
   │ POST /v1/sessions/:id/events        post user message (queues if busy)
   │ GET  /v1/sessions/:id/events        snapshot or ?stream=true live SSE
   │ POST /v1/sessions/:id/cancel        abort the in-flight run
   │ POST /v1/chat/completions           OpenAI SDK drop-in (thin shim)
   ▼
Orchestrator (this repo, Hono HTTP service)
   │
   ├─ Store (src/store/) — SQLite by default, persists agents + sessions
   │                       across orchestrator restart. Events are NOT
   │                       stored here; they live in Pi's per-session JSONL.
   │
   ├─ SessionContainerPool (src/runtime/pool.ts) — one container per session,
   │                       reused across turns. First event spawns (~15 s);
   │                       subsequent turns reuse (~100 ms overhead). Idle
   │                       sweeper reaps after OPENCLAW_IDLE_TIMEOUT_MS and
   │                       cleans up ephemeral sessions on the same pass.
   │
   ├─ GatewayWebSocketClient (src/runtime/gateway-ws.ts) — operator-role WS
   │                       handshake per container. Used for cancel
   │                       (sessions.abort) and per-event model override
   │                       (sessions.patch). One WS lifetime per container.
   │
   ├─ PiJsonlEventReader (src/store/pi-jsonl.ts) — parses OpenClaw's
   │                       per-session JSONL for event list, latestAgentMessage,
   │                       and tail-follow SSE. Also the source of per-turn
   │                       cost (msg.usage.cost.total) for the session rollup.
   │
   └─ AgentRouter (src/orchestrator/router.ts) — idle runEvent spawns +
                          runs; running runEvent queues; cancel aborts via
                          WS + drains queue. Per-turn cost is read from the
                          JSONL after each completion.
   │
   │ runtime.spawn()              HTTP /v1/chat/completions + WS control
   ▼                              ▼
DockerContainerRuntime            OpenClaw container (one per session)
 (src/runtime/docker.ts)           - entrypoint generates openclaw.json
                                   - HTTP /v1/chat/completions (OpenAI-compat)
                                   - WebSocket control plane at /
                                   - runs the full agent loop (tool use, multi-turn)
                                   - persists session JSONL to mounted volume
```

One OpenClaw container per session. Each container is effectively single-user, which gives us true isolation for free — the orchestrator creates multi-user semantics externally without touching OpenClaw core. The session is durable across container restarts because Pi's `SessionManager` rebuilds the `AgentSession` from the JSONL on the host mount when a new container spawns under the same key.

## API

```
GET    /                                  # self-documenting root: name, version, endpoint map
GET    /healthz                           # liveness probe: { ok, version }
```

**Agent templates** — reusable config specs. Creating an agent does not spawn anything.

```
POST   /v1/agents                         # body: { model, tools, instructions, name?,
                                          #         callableAgents?, maxSubagentDepth? }
GET    /v1/agents                         # list all templates
GET    /v1/agents/:agentId                # fetch one template
DELETE /v1/agents/:agentId
```

`callableAgents` (default `[]`) is the delegation allowlist — other agent IDs this
template may invoke via the in-container `openclaw-call-agent` CLI. `maxSubagentDepth`
(default `0`) is the recursion cap. Both default to denying delegation; opt in per
template. See [Delegated subagents](#delegated-subagents) below.

**Sessions** — long-lived, multi-turn, the primary interaction API.

```
POST   /v1/sessions                       # body: { agentId }
GET    /v1/sessions                       # list all sessions
GET    /v1/sessions/:sessionId            # metadata: status, rolling tokens, cost_usd,
                                          #           error, created_at, last_event_at, output
                                          #           (output = content of the latest agent.message,
                                          #            computed from Pi's JSONL at query time)
DELETE /v1/sessions/:sessionId            # tears down container, deletes Pi JSONL + store row
POST   /v1/sessions/:sessionId/events     # body: { content, model?, type?: "user.message" }
                                          #   queues behind an in-flight run if the session is busy;
                                          #   auto-drains in-order when the current run completes;
                                          #   optional model override applies via the WS control plane
GET    /v1/sessions/:sessionId/events     # one-shot JSON array of every event in order
GET    /v1/sessions/:sessionId/events?stream=true
                                          # SSE: catch-up then tail-follow the Pi JSONL;
                                          #   15 s heartbeats; terminates on session idle + 30 s grace
POST   /v1/sessions/:sessionId/cancel     # aborts the in-flight run via the gateway WS control plane,
                                          #   drains queued events, leaves the session idle
```

**OpenAI compatibility** — thin shim over the session/event API. See "OpenAI SDK compatibility" below for the contract details.

```
POST   /v1/chat/completions               # x-openclaw-agent-id header required
                                          # body is permissive OpenAI ChatCompletionRequest;
                                          # stream=true is emulated (three chunks + [DONE]);
                                          # keyless calls create ephemeral sessions that are
                                          # reaped alongside their container by the idle sweeper
```

**Backwards-compat one-shot adapter** — kept for legacy callers. Thin wrapper over `createSession` + `runEvent`.

```
POST   /v1/agents/:agentId/run            # body: { task, sessionId? }
```

The orchestrator is self-documenting — `curl http://localhost:8080/` returns the full endpoint map, version, and docs link. You never need this section to discover the API.

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

Then in another terminal — the session-centric path (recommended for multi-turn):

```bash
# 1. Create a reusable agent template (config only, no containers spawned)
AGENT=$(curl -s -X POST http://localhost:8080/v1/agents \
  -H 'Content-Type: application/json' \
  -d '{"model": "moonshot/kimi-k2.5", "tools": [], "instructions": "You are a research assistant."}' \
  | jq -r '.agent_id')

# 2. Open a long-lived session bound to that agent
SESSION=$(curl -s -X POST http://localhost:8080/v1/sessions \
  -H 'Content-Type: application/json' \
  -d "{\"agentId\": \"${AGENT}\"}" | jq -r '.session_id')

# 3. Post a user message event. The FIRST event on a session spawns a
#    container (~15 s one-time cost); subsequent turns reuse the live
#    container via the pool (~100 ms overhead).
curl -s -X POST "http://localhost:8080/v1/sessions/${SESSION}/events" \
  -H 'Content-Type: application/json' \
  -d '{"content": "Remember: my favorite fruit is dragonfruit."}'

# 4. Poll until idle, then read the newest agent.message from the JSONL
while :; do
  STATUS=$(curl -s "http://localhost:8080/v1/sessions/${SESSION}" | jq -r '.status')
  [[ "$STATUS" != "running" ]] && break
  sleep 2
done
curl -s "http://localhost:8080/v1/sessions/${SESSION}/events" \
  | jq -r '[.events[] | select(.type=="agent.message")] | last | .content'

# 5. Session resume across turns is automatic — the JSONL is the source of truth
curl -s -X POST "http://localhost:8080/v1/sessions/${SESSION}/events" \
  -H 'Content-Type: application/json' \
  -d '{"content": "What is my favorite fruit?"}'

# 6. Rolling tokens + cost on the session row
curl -s "http://localhost:8080/v1/sessions/${SESSION}" | jq '{status, cost_usd, tokens}'
```

**Alternative 1 — OpenAI SDK drop-in.** Point your OpenAI SDK at `http://localhost:8080/v1` with `x-openclaw-agent-id` in `default_headers`. See the "OpenAI SDK compatibility" section above for the full contract.

**Alternative 2 — Legacy one-shot adapter.** For task-centric callers, `POST /v1/agents/:agentId/run { task }` is kept as a thin wrapper over `createSession` + `runEvent`:

```bash
curl -s -X POST "http://localhost:8080/v1/agents/${AGENT}/run" \
  -H 'Content-Type: application/json' \
  -d '{"task": "Summarize the agent platform landscape as of April 2026."}'
# → {"session_id":"ses_xyz789","agent_id":"agt_abc123","status":"running","started_at":...}
```

Live SSE streaming for any of the above:

```bash
curl -N "http://localhost:8080/v1/sessions/${SESSION}/events?stream=true"
# event: user.message
# id: <piEventId>
# data: {"event_id":"...","type":"user.message","content":"..."}
# ...
```

## Delegated subagents

> **Every agent in OpenClaw Managed Runtime is an inspectable session. That includes subagents.**
> Unlike Claude Managed Agents, there are no opaque delegated runs — you can subscribe to
> `GET /v1/sessions/<any_session_id>/events?stream=true` in real time, whether the session
> was created by a client or by another agent's `call_agent` tool call. The "black box
> within a black box" problem doesn't exist here by architectural construction.

An agent can delegate a task to another agent via the `openclaw-call-agent` CLI that ships
in the runtime image at `/usr/local/bin/openclaw-call-agent`. The parent agent invokes it
through its normal `exec` tool; the CLI makes authenticated HTTP calls back to the
orchestrator's existing `POST /v1/sessions` + `POST /events` + `GET /events?stream=true`
API. There are **no new HTTP endpoints** on the runtime — the subagent pattern rides on top
of the primitives that every external client already uses.

This follows [Mario Zechner's CLI-tools-with-README pattern](https://mariozechner.at/posts/2025-11-02-what-if-you-dont-need-mcp/)
literally: no Pi extension, no OpenClaw plugin, no built-in `call_agent` runtime endpoint.
Just a single-file Node CLI the agent shells out to.

### Enabling delegation on an agent template

Two optional fields on `POST /v1/agents`:

- **`callableAgents: string[]`** — allowlist of target agent IDs this template may invoke.
  Default `[]` (no delegation).
- **`maxSubagentDepth: number`** — how many levels of nested delegation this template's
  sessions may root. Default `0` (delegation disabled even if `callableAgents` is non-empty).
  Each `call_agent` invocation decrements a signed parent token's remaining depth; the
  orchestrator rejects further spawns when it reaches zero.

```bash
# Create a worker agent (leaf — no delegation)
curl -s -X POST http://localhost:8080/v1/agents \
  -H 'Content-Type: application/json' \
  -d '{"model": "moonshot/kimi-k2.5", "tools": [], "instructions": "You are a worker.",
       "name": "worker"}'
# → {"agent_id": "agt_worker", ...}

# Create a coordinator that may delegate to worker
curl -s -X POST http://localhost:8080/v1/agents \
  -H 'Content-Type: application/json' \
  -d '{"model": "moonshot/kimi-k2.5", "tools": [], "instructions": "You are a coordinator.
       When a task fits the worker, delegate via openclaw-call-agent.",
       "name": "coordinator",
       "callableAgents": ["agt_worker"],
       "maxSubagentDepth": 1}'
# → {"agent_id": "agt_coordinator", ...}
```

### How the agent uses it

The orchestrator detects `callableAgents.length > 0 && remainingDepth > 0` at container
spawn and appends a short delegation hint to the agent's system prompt:

> ## Delegation
> You can delegate tasks to other agents via the `openclaw-call-agent` CLI.
> Allowed target agents: agt_worker.
> Invoke it through your `exec` tool:
>   openclaw-call-agent --target <agent_id> --task "<prompt>"
> Run `openclaw-call-agent --help` for full usage. The tool returns JSON on stdout with
> the subagent's final reply and a `subagent_session_id` you can use to inspect the
> delegated run.

The model then invokes the CLI via its `exec` tool. The CLI blocks until the subagent's
run completes (10-minute cap), then prints one line of JSON to stdout:

```json
{"subagent_session_id":"ses_xyz","content":"...","events_url":"http://openclaw-orchestrator:8080/v1/sessions/ses_xyz/events"}
```

The parent agent reads that stdout through its `exec` tool result and uses the `content`
field in its own reasoning. If it wants to inspect the subagent's full run, it can curl
the `events_url` via `exec` as well — no special privilege needed.

### Observing a subagent externally

A subagent session is a normal session. Every orchestrator API works on it:

```bash
# List all sessions (parents + subagents)
curl -s http://localhost:8080/v1/sessions

# Fetch the subagent's metadata (status, rolling tokens, cost)
curl -s http://localhost:8080/v1/sessions/ses_xyz

# Read the subagent's full event log
curl -s http://localhost:8080/v1/sessions/ses_xyz/events

# Tail-follow the subagent while it runs (SSE)
curl -N http://localhost:8080/v1/sessions/ses_xyz/events?stream=true

# Cancel the subagent (aborts its in-flight run via the WS control plane)
curl -s -X POST http://localhost:8080/v1/sessions/ses_xyz/cancel
```

### Auth and safety

Each container gets an orchestrator-minted parent token in `OPENCLAW_ORCHESTRATOR_TOKEN`,
HMAC-signed by a per-process secret that regenerates on every orchestrator restart. The
token carries:

- `parentSessionId` / `parentAgentId` — who is calling
- `allowlist` — which agent IDs may be spawned (from the parent template's `callableAgents`)
- `remainingDepth` — how many more nesting levels are allowed (from the parent session's
  `remainingSubagentDepth`, decremented on each spawn)
- `expiresAt` — 24-hour TTL

`POST /v1/sessions` verifies the `X-OpenClaw-Parent-Token` header when present and
rejects (HTTP 403) if the target agent is not in the allowlist, the signature fails, the
token is expired, or remaining depth is zero. Defense in depth: the CLI itself also
validates args locally before the round trip, so bad inputs fail fast.

The parent-token secret is in-memory only — consistent with the runtime's other
"restart drops ephemeral state" invariants (post-restart running sessions become failed,
queued events are lost, in-flight subagent spawns rejected until the next container
respawn mints a fresh token).

### What's NOT here

- **No `POST /v1/agents/:id/call` or `POST /v1/sessions/:id/subagents` endpoint.** Existing
  `POST /v1/sessions` + `POST /events` IS the subagent API.
- **No Claude-Code-style description-based implicit delegation.** The model invokes the
  tool explicitly; no routing magic.
- **No orchestrator-side cost aggregation across subagents.** A client that wants a combined
  view walks the `subagent_session_id` pointers in the parent's event log and sums.
- **No recursion by default.** Opt in per agent template via `maxSubagentDepth > 0`.

## Status and roadmap

This is **early development**, but the runtime is end-to-end functional and every feature below is validated against a real provider in the e2e suite. See `docs/architecture.md` for the technical design.

**Shipped** (Items 1-9 on `main`):

- **Session-centric data model.** Reusable `Agent` templates, long-lived `Session` (status `idle|running|failed`), `Event` as the interaction primitive (`user.message` / `agent.message` / `agent.error`).
- **SQLite-backed persistent store** (`src/store/sqlite.ts`) — survives orchestrator restart; WAL journal + CHECK constraints; post-restart rehydration marks orphaned `running` sessions as `failed`.
- **Per-session container lifecycle with idle pool** (`src/runtime/pool.ts`) — first event spawns (~15 s), subsequent turns reuse (~100 ms), `setInterval` sweeper reaps after `OPENCLAW_IDLE_TIMEOUT_MS` (default 10 min).
- **Event log read from OpenClaw's JSONL** (`src/store/pi-jsonl.ts`) — the orchestrator does not write events; Pi's `SessionManager` is the sole writer. Single source of truth, zero sync bugs.
- **Live event streaming** via `GET /v1/sessions/:id/events?stream=true` — catch-up + tail-follow, 15 s heartbeats.
- **Control plane via the gateway's WebSocket** (`src/runtime/gateway-ws.ts`) — cancel uses `sessions.abort`, per-event `model` field uses `sessions.patch`. Queue-when-busy behavior drains automatically in order.
- **OpenAI-compat adapter** via `POST /v1/chat/completions` — sticky sessions via `user` field / `x-openclaw-session-key`, keyless calls create ephemeral sessions, reaped alongside their container.
- **Per-turn cost accounting** from Pi's provider catalogs — cache-aware, read from `msg.usage.cost.total` in the JSONL. No static price sheet in the orchestrator.
- **Delegated subagents as first-class inspectable sessions.** `callableAgents` + `maxSubagentDepth` on agent templates, HMAC-signed parent tokens, `openclaw-call-agent` CLI tool inside the container. Zero new HTTP endpoints; subagents spawn through the existing `POST /v1/sessions` + `POST /events` primitives. See [Delegated subagents](#delegated-subagents) above.

**Next** (Items 10-11):

- **Cloud container backends.** `ContainerRuntime` adapters for AWS ECS/Fargate, GCP Cloud Run, Azure Container Apps — drop-in, no orchestrator core changes.
- **Cloud-native session storage.** S3 / GCS / Azure Blob / Aliyun OSS / Volcengine TOS behind the same host-mount contract.
- **Cloud secrets integration.** `SecretRef`-style pulls from AWS Secrets Manager / GCP Secret Manager / Azure Key Vault, replacing env-var passthrough.
- **Upstream contributions** to OpenClaw: `defineSingleProviderPluginEntry` auto-register fix (eliminates the `PROVIDER_BLOCK_JSON` hack for Category B providers), and an HTTP/SSE wrapper around the Pi event bus if the orchestrator grows real-time delta forwarding.

**Later** (Items 12-14):

- **Multi-tenant delegated subagents at scale.** The current Item 12-14 release ships per-agent-template `callableAgents` + `maxSubagentDepth` + HMAC parent tokens; "Later" work adds tenant isolation, cross-tenant quota enforcement, and tree-view UI tooling for deeply nested delegations.
- **Enterprise features.** Multi-tenant orchestrator with auth, quotas, and per-tenant isolation. Audit logs. Policy enforcement. BYO-KMS.

**Out of scope** (deliberate, never becomes milestone work):

- Proprietary toolset spec — agents use Pi's typed `ToolDefinition` directly.
- Environment as a first-class API resource — the container IS the environment.
- Session-hour billing primitive — cloud partners bill, we don't.
- Closed SDKs or parallel skill registries — we use ClawHub and `pi-skills`.
- Claude Code's description-based implicit delegation — subagents are invoked explicitly via `call_agent(target, task)`.

## License

MIT. See `LICENSE`.

## Relationship to OpenClaw

This project uses [OpenClaw](https://github.com/openclaw/openclaw) as an npm dependency. It is not a fork. All agent execution, tool invocation, session management, and provider integration comes from OpenClaw core. This repo adds only the managed layer on top: the orchestrator service, the container entrypoint, and the cloud-specific adapters.

When OpenClaw upstream is ready, this project will migrate to `openclaw/managed-runtime` as a sibling repo under the official organization.
