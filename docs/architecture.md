# Architecture

## Goal

Provide an API-first managed agent runtime that competes with Claude Managed Agents. Developers call a single HTTP API to create agents and run tasks; the runtime handles everything else — containerization, session persistence, provider integration, and cleanup. Cloud providers wrap this runtime under their own brand and sell it on their marketplaces.

## Key constraint: OpenClaw is single-user

OpenClaw is fundamentally designed as one instance per user. The config, sessions, credentials, and workspace are all instance-scoped. The obvious "fix" would be to rewrite OpenClaw to be multi-tenant — that is the wrong move, because it would require months of architectural debate upstream and risks breaking every existing deployment.

**The elegant solution: run one OpenClaw container per session.** Each container is single-user. The orchestrator creates multi-user semantics externally by owning a `SessionContainerPool` that spawns a fresh container for each new session's first event, reuses it across subsequent turns on that session, and reaps it after an idle timeout. OpenClaw core stays exactly as it is.

Container vs. session lifetime: sessions are durable (SQLite row + JSONL on the host mount). Containers are ephemeral (spawned on first event, reaped after idle). When a new container spawns under an existing session, Pi's `SessionManager.open()` rebuilds the `AgentSession` from the JSONL, so the agent sees the full conversation history. "Cattle, not pets" for compute; "pets, not cattle" for session state.

This is also how Claude Managed Agents works under the hood — Anthropic's engineering posts describe stateless harnesses with many brains and many hands per session. We just formalized it on top of Pi + OpenClaw instead of building the whole stack ourselves.

## Zero upstream changes required

Everything shipped so far runs against the unmodified `openclaw` npm package (pinned in `Dockerfile.runtime`). There are no forks, no local patches, no upstream PRs waiting to land before the runtime works. The orchestrator, the entrypoint script, and a Docker image layer together are the full delta. The orchestrator directly uses OpenClaw's existing HTTP OpenAI-compat endpoint, its existing WebSocket control plane, its existing session-key resolver, its existing `/readyz` gate, its existing bearer-token auth, and its existing JSONL session format.

The strategic doc flagged four potential upstream changes that would make this cleaner (API-only startup, config-from-env, pluggable session storage, pluggable secrets). Two of them (API-only startup, config-from-env) are already satisfied by OpenClaw's existing behavior — we just didn't need them to be dedicated code paths. The other two (pluggable storage, pluggable secrets) remain worthwhile contributions when we wire up cloud backends, but they do not block local or single-host deployments. See "Why this works with zero upstream changes" below for the full checklist.

## Components

A thin Node/TypeScript HTTP service built on Hono, plus a small runtime layer for container lifecycle and WebSocket control. The orchestrator is split so each module has one job:

### Store (`src/store/`)

The durable state — agents and sessions. Events are NOT stored here; they live in OpenClaw's per-session JSONL on the host mount, written by Pi's `SessionManager`, and the orchestrator reads them at query time via `PiJsonlEventReader`.

- **`AgentStore`**, **`EnvironmentStore`**, and **`SessionStore`** — interfaces in `src/store/types.ts`. Synchronous methods (both backends are sync; we don't introduce speculative async).
- **`SqliteStore`** (default, `src/store/sqlite.ts`) — `better-sqlite3`, WAL journal mode, `foreign_keys = ON`, CHECK constraints on session status. Four tables: `agents`, `agent_versions` (immutable version history), `environments`, `sessions`. Sessions cascade on agent delete is **off** — sessions outlive their template. Additive column migrations (e.g., `ephemeral`, `environment_id`, `version`, `archived_at`, `permission_policy_json`) are gated on `PRAGMA table_info` checks and ALTERs on startup.
- **`InMemoryStore`** (`src/store/memory.ts`) — `Map`-backed, used in tests. Same interface, so the router takes store interfaces, not concrete classes.
- **`buildStore`** (`src/store/index.ts`) — factory keyed on `OPENCLAW_STORE=sqlite|memory` and `OPENCLAW_STORE_PATH`.

**Agent versioning**: `AgentStore.update()` implements optimistic concurrency — the caller must supply `version` (the current version they read), and the store rejects with a version conflict if it doesn't match. Each successful update inserts an immutable row into `agent_versions` and bumps the agent's version counter. No-op detection: if the update produces no field changes, the version is not bumped. `AgentStore.archive()` sets `archived_at` — archived agents block new session creation but existing sessions continue.

**Environments**: `EnvironmentStore` is a simple CRUD store for container configuration templates (packages, networking). Sessions reference an environment at creation time via `environmentId`. Environment deletion is rejected (409) while sessions reference it.

On startup, `store.sessions.failRunningSessions("orchestrator restarted mid-run")` marks any session still in `running` as `failed` — those runs were orphaned when the prior orchestrator process exited. SIGTERM/SIGINT wire to `store.close()` so the SQLite WAL flushes cleanly.

### PiJsonlEventReader (`src/store/pi-jsonl.ts`)

Parses OpenClaw's per-session JSONL at query time. Resolves our `session_id` → the Pi session file via `<stateRoot>/<agentId>/agents/main/sessions/sessions.json` keyed by the canonical `agent:main:<session_id>` form, then opens `<stateRoot>/<agentId>/agents/main/sessions/<piSessionId>.jsonl`.

- **`listBySession(agentId, sessionId): Event[]`** — parses the JSONL and maps entries to typed `Event` objects. Handles four JSONL line types: `message` (user/assistant/toolResult roles), `model_change`, `thinking_level_change`, and `compaction`. Within assistant messages, extracts three content block types: `text` (→ `agent.message`), `toolCall` (→ `agent.tool_use`), and `thinking` (→ `agent.thinking`). Empty-content assistant messages are dropped (Pi's auto-retry noise). Returns 10 event types: `user.message`, `agent.message`, `agent.tool_use`, `agent.tool_result`, `agent.thinking`, `session.model_change`, `session.thinking_level_change`, `session.compaction`, plus `agent.error` (from the store) and `agent.tool_confirmation_request` (synthetic, from the orchestrator).
- **`latestAgentMessage(agentId, sessionId): Event | undefined`** — used by (a) the server's `sessionResponse.output` computed field, (b) the router's Item 9 cost rollup, and (c) the chat-completions handler's `beforeEventId` stale-detection snapshot.
- **`deleteBySession(agentId, sessionId)`** — called by `DELETE /v1/sessions/:id`, by the pool's `cleanupOnReap` callback for ephemeral sessions (Item 8), and by the chat-completions handler's error path.
- **`follow(agentId, sessionId, opts)`** — async generator that yields existing events (catch-up) then tail-follows via a 250 ms poll loop. Powers `GET /v1/sessions/:id/events?stream=true` (Item 6). Terminates on `AbortSignal` or when the caller's `isSessionRunning()` predicate returns `false` AND nothing new has landed for 30 s.

### SessionContainerPool (`src/runtime/pool.ts`)

Two pools in one: an **active** pool (per-session, reused across turns) and a **warm** pool (per-agent, pre-booted). When an agent is created, a container boots in the background and waits in the warm bucket. The first session on that agent claims the pre-warmed container instead of cold-spawning (near-zero latency). Subsequent events reuse the active container (~100 ms overhead).

An unref'd `setInterval` sweeper reaps idle containers on both halves:

- **Active containers** are reaped after `OPENCLAW_IDLE_TIMEOUT_MS` (default 10 min) of no use. `isBusy(sessionId)` is checked first so a session with a run in flight is never evicted mid-turn.
- **Warm containers** are reaped after `OPENCLAW_WARM_IDLE_TIMEOUT_MS` (default: same as active idle timeout) without being claimed, and the warm pool is bounded by `OPENCLAW_MAX_WARM_CONTAINERS` (default 5). When a new `warmForAgent` would exceed the cap, the oldest-spawned warm entry is reaped first. This keeps a host with many distinct agent templates from accumulating one persistent 2 GiB container per template.

- **`warmForAgent(agentId, spawnOptions)`** — pre-boots a container (spawn + `/readyz` + WS handshake) and stores it in the warm bucket keyed by agentId. Called by the server after `POST /v1/agents`. No-ops if a warm container already exists for this agent. Evicts the oldest warm entry first when the pool is at `OPENCLAW_MAX_WARM_CONTAINERS`. **The router skips this call entirely for delegating agents** (`callableAgents.length > 0 || maxSubagentDepth > 0`) — see the note under AgentRouter.warmForAgent for why.
- **`acquireForSession({sessionId, spawnOptions, agentId?})`** — returns a live `Container` for the session. Checks three sources in order: (1) existing active container, (2) pre-warmed container matching the agentId, (3) fresh spawn. When claiming from the warm pool, auto-replenishes in the background. Bumps `lastUsedAt` on reuse.
- **`getWsClient(sessionId)`** — lookup used by the router for cancel (`sessions.abort`) and per-event model override (`sessions.patch`).
- **`evictSession(sessionId)`** — manual teardown (closes WS, stops container). Called by `DELETE /v1/sessions/:id` and the router's infra-failure path.
- **`shutdown()`** — SIGTERM path. Clears the sweeper, closes every WS, stops every container. Best-effort (errors are swallowed so one stuck stop doesn't block the process).
- **`cleanupOnReap?: (sessionId) => Promise<void>`** — **only** called from the idle-reap path (not manual evict, not shutdown). `index.ts` wires this to check `store.sessions.get(sessionId)?.ephemeral` and, if true, delete the Pi JSONL + store row. This is how Item 8's keyless `/v1/chat/completions` calls get cleaned up without accumulating forever.

The pool has **no direct dependency on the store**. It takes an `isBusy: (sessionId) => boolean` predicate in config; `index.ts` closes over the session store to provide it. This keeps the runtime layer decoupled from the orchestrator layer. `cleanupOnReap` follows the same shape — the pool calls the callback and lets the caller decide what cleanup means.

Orphan reaping: at startup, `DockerContainerRuntime.cleanupOrphaned()` finds any containers left behind by a previous orchestrator process (matched by the `managed-by=openclaw-managed-agents` Docker label) and stops them.

### GatewayWebSocketClient (`src/runtime/gateway-ws.ts`)

Operator-role WebSocket client to each live container's gateway control plane. Documented upstream at `openclaw/docs/gateway/protocol.md`. One client per container; lifetime tracks the container's lifetime.

- **`connect()`** — opens the WS, sends a `connect` request with `role: "operator"`, `scopes: ["operator.read", "operator.write", "operator.admin"]`, and `client: { id: "openclaw-tui", mode: "ui" }`. The `openclaw-tui` client id is load-bearing: it's recognized by `isOperatorUiClient()` (so the gateway's `controlUi.dangerouslyDisableDeviceAuth: true` bypass applies) AND it's NOT recognized by `isBrowserOperatorUiClient()` (so the browser-origin allowlist check does not fire — we can connect from Node without an Origin header).
- **`abort(sessionKey, runId?)`** → `sessions.abort` — aborts the in-flight run for the given session. Backs `POST /v1/sessions/:id/cancel`.
- **`steer(sessionKey, message)`** → `sessions.steer` — interrupt the active run with a new message. Not currently wired to an HTTP surface (see "Item 7b deferred" in the plan).
- **`send(sessionKey, message)`** → `sessions.send` — send without interrupting. Not currently wired.
- **`patch(sessionKey, fields)`** → `sessions.patch` — mutate session fields. Used for the per-event `model` override on `POST /v1/sessions/:id/events`.
- **`approvalResolve(id, decision, denyMessage?)`** → `plugin.approval.resolve` — resolves a pending tool-confirmation approval. Backs the `user.tool_confirmation` event type when the agent template has `always_ask` permission policy.
- **`onEvent(eventName, handler)`** — subscribes to gateway broadcast events. Returns an unsubscribe function. Used by the orchestrator to listen for `plugin.approval.requested` events.
- **`close()`** — shuts the socket down, rejects every outstanding request.

Auth is the same `OPENCLAW_GATEWAY_TOKEN` the orchestrator uses on HTTP. The `dangerouslyDisableDeviceAuth: true` flag in the generated `openclaw.json` is safe because the gateway is bound to `openclaw-net` (a private Docker bridge), only the orchestrator ever reaches it, and the token is per-container random.

### SessionEventQueue (`src/orchestrator/event-queue.ts`)

In-memory per-session FIFO. When `POST /v1/sessions/:id/events` arrives while the session is already `running`, the event is enqueued instead of returning 409. The router's `executeInBackground` success path pops the queue and recursively starts the next run without flipping status to `idle` — polling clients never observe a brief idle window between queued runs.

Queue is lost on orchestrator restart, consistent with Item 3's rehydration semantics.

### AgentRouter (`src/orchestrator/router.ts`)

The brain of the orchestrator. Takes the store, the pool, the JSONL reader, the event queue, and a config bundle. Exposes six methods:

- **`createSession(agentId, opts?)`** — pure metadata: allocates a store row, no container spawn, no JSONL write. Validates the agent is not archived. The container is only spawned when the first event arrives (or earlier via warm-up).
- **`warmSession(sessionId)`** — proactively boots a container for a session so it's ready by the time the first event arrives. Called by the server right after `createSession`. Fire-and-forget.
- **`warmForAgent(agentId)`** — pre-warms a container for an agent template. Called by the server after `POST /v1/agents`. The warm container waits in the pool until claimed by a session. **Skipped for delegating agents** (`callableAgents.length > 0 || maxSubagentDepth > 0`). `buildSpawnOptions` bakes the sessionId into both Docker labels and the signed `OPENCLAW_ORCHESTRATOR_TOKEN` env var, and Docker env is immutable post-create; a warm container built with the `__warm__` placeholder would carry that placeholder into every subagent spawn the claimed session later hosts, producing wrong token lineage (the orchestrator doesn't currently verify `parentSessionId` against the session store, so the failure would be silent rather than a crash). Skipping the warm pool for delegating agents preserves the latency benefit for the common non-delegating case without the identity smear.
- **`runEvent({sessionId, content, model?})`** — idle path starts a background run (`beginRun` + fire-and-forget `executeInBackground`); running path enqueues. Returns `{session, queued}`.
- **`cancel(sessionId)`** — looks up the pool's WS client, calls `abort(canonicalKey)`, drains the queue, calls `endRunCancelled`. Cancellation is a deliberate stop, not an agent failure.
- **`confirmTool(sessionId, approvalId, decision, denyMessage?)`** — resolves a pending tool-confirmation approval via the container's WS `plugin.approval.resolve`. Used when the agent template has `always_ask` permission policy.
- **`executeInBackground`** (private) — acquires a container via the pool (with agentId for warm-pool matching), optionally applies a WS `patch` for model override, invokes the container's `/v1/chat/completions`, reads `latestAgentMessage` from the JSONL for cost rollup, then either drains the queue or calls `endRunSuccess`. Injects `OPENCLAW_PACKAGES_JSON` (from environment config), `OPENCLAW_DENIED_TOOLS` (from deny policy), and `OPENCLAW_CONFIRM_TOOLS` (from always_ask policy) into the container env.
- **`handleBackgroundFailure`** (private) — guard against overwriting a cancel's idle state with an in-flight HTTP error. If `session.status !== "running"` at catch time, the failure is a side-effect of an external cancel and we leave the session alone. Otherwise drain the queue + evict the container + `endRunFailure`.

### Server (`src/orchestrator/server.ts`)

The Hono app. Every route in the API section of the README registers here. Notable pieces:

- **`handleRouterError`** — centralized error translator. `RouterError` codes map to HTTP status: `agent_not_found`/`session_not_found` → 404, `session_busy`/`session_not_running`/`agent_archived` → 409, everything else → 500.
- **Agent routes** — full CRUD plus `PATCH` (versioned update with optimistic concurrency), `GET .../versions` (immutable history), `POST .../archive` (soft-delete). `POST /v1/agents` fires `warmForAgent` in the background after creation.
- **Environment routes** — CRUD. Deletion rejected (409) while sessions reference the environment.
- **Session routes** — `POST /v1/sessions` validates environmentId if provided, fires proactive `warmSession` in the background. `POST /v1/sessions/:id/events` dispatches on event type: `user.message` triggers `runEvent`, `user.tool_confirmation` triggers `confirmTool`.
- **SSE streaming** — `GET /v1/sessions/:id/events?stream=true` uses `streamSSE` from `hono/streaming`, wires `AbortController` from `sse.onAbort` into `PiJsonlEventReader.follow`. Emits an initial `session.status_*` event on connect, checks for status transitions on every yielded event and on every 15 s heartbeat tick, and emits a final status event when the follow loop ends.
- **`POST /v1/chat/completions`** — OpenAI-compat handler. Required `x-openclaw-agent-id` header, sticky session via `x-openclaw-session-key` or body `user`, keyless calls create ephemeral sessions. Stale-detection via `beforeEventId` snapshot. Polls every 500 ms with a 600 s cap. `stream: true` is emulated (three chunks + `[DONE]`).

### Delegated subagents (`src/runtime/parent-token.ts` + `docker/call-agent.mjs`)

The Item 12-14 delegation story is **entirely additive on top of the existing session/event API**. No new HTTP routes, no new Session type, no orchestrator-side "subagent" concept — a subagent is simply a `Session` created by an in-container CLI tool that calls back to `POST /v1/sessions`.

- **`ParentTokenMinter`** (`src/runtime/parent-token.ts`) — one instance per orchestrator process. Generates a random 32-byte HMAC secret in its constructor; `mint()` produces compact `<base64url-payload>.<base64url-mac>` tokens containing `{parentSessionId, parentAgentId, allowlist, remainingDepth, expiresAt}`; `verify()` checks the signature in constant time, validates expiration, and returns the payload or undefined. The secret never leaves the process and regenerates on every restart, invalidating every outstanding token — consistent with the runtime's other "restart drops ephemeral state" invariants (Items 3, 7).
- **`openclaw-call-agent` CLI** (`docker/call-agent.mjs`, installed into the runtime image at `/usr/local/bin/openclaw-call-agent`) — a single-file Node script the agent invokes through its built-in `exec` tool. Reads `OPENCLAW_ORCHESTRATOR_URL` and `OPENCLAW_ORCHESTRATOR_TOKEN` from the container env (injected at spawn time by `AgentRouter.executeInBackground`), posts `POST /v1/sessions` + `POST /events`, polls for completion, extracts the subagent's final `agent.message` from the JSONL event log, prints one line of JSON to stdout, exits. No Pi extension, no OpenClaw plugin — this matches [Mario Zechner's own MCP critique](https://mariozechner.at/posts/2025-11-02-what-if-you-dont-need-mcp/) literally ("Build CLI tools with README files"). Progressive disclosure via `openclaw-call-agent --help`.
- **Policy surface** — agent templates gain `callableAgents: string[]` (default `[]`) and `maxSubagentDepth: number` (default `0`). The router's `executeInBackground` reads both off the agent template when minting a token, and appends a short delegation hint to `OPENCLAW_INSTRUCTIONS` only when `callableAgents.length > 0 && remainingSubagentDepth > 0`. The orchestrator's `POST /v1/sessions` handler verifies the `X-OpenClaw-Parent-Token` header when present: rejects with HTTP 403 if the target agent is not in the allowlist, if the signature fails, if the token is expired, or if remaining depth is zero. Child sessions inherit `parent.remainingDepth - 1` as their own `remainingSubagentDepth`, persisted on the sessions table so container respawn mints a correctly-scoped token.
- **Observability is a side-effect, not new plumbing.** A subagent session is a first-class `Session` — visible via `GET /v1/sessions`, inspectable via `GET /v1/sessions/:id/events`, streamable via `?stream=true`, cancellable via `POST /v1/sessions/:id/cancel`. Cost is rolled up per Item 9. The parent's `exec` tool output captures the CLI's stdout (which includes the `subagent_session_id` and `events_url`), so a reader of the parent's JSONL can navigate directly to the child.

The architectural payoff: the "observability gap" documented by [three open issues on `anthropics/claude-code`](https://github.com/anthropics/claude-code/issues/2685) ([also #6007](https://github.com/anthropics/claude-code/issues/6007), [#9521](https://github.com/anthropics/claude-code/issues/9521)) and Pi's "use tmux instead" stance both exist because there is no managed runtime where subagents are first-class HTTP resources. That's the door Items 12-14 walk through.

### Permission policy + confirm-tools plugin (`docker/confirm-tools-plugin/`)

Agent templates support three permission policies:

- **`always_allow`** (default) — all tools execute automatically
- **`deny`** — specified tools are blocked entirely via OpenClaw's `tools.deny` config
- **`always_ask`** — specified tools pause for client confirmation before execution

The `always_ask` flow uses an OpenClaw plugin installed in the runtime container image at `/opt/openclaw-plugins/confirm-tools/`. The entrypoint copies it to `/workspace/extensions/confirm-tools/` (the plugin discovery path, derived from `OPENCLAW_STATE_DIR`) when `OPENCLAW_CONFIRM_TOOLS` is set. The plugin registers a `before_tool_call` hook via `definePluginEntry` (from `openclaw/plugin-sdk/core`) that returns `requireApproval` for matching tools. The gateway then broadcasts `plugin.approval.requested` to WS clients; the orchestrator's `GatewayWebSocketClient.onEvent()` listener receives it and can surface it as an `agent.tool_confirmation_request` SSE event. The client resolves it via `POST /v1/sessions/:id/events { type: "user.tool_confirmation", toolUseId, result }`, which the server routes to `router.confirmTool()` → `wsClient.approvalResolve()`.

### Python SDK (`sdk/python/`)

Typed Python client publishable to PyPI as `openclaw-managed-agents`. Uses `httpx` for HTTP and `httpx-sse` for SSE streaming. Covers the full API: `client.agents`, `client.environments`, `client.sessions` (including `send`, `stream`, `cancel`, `confirm_tool`, `events`). Dataclass types for `Agent`, `Environment`, `Session`, `Event`. Context manager support.

### DockerContainerRuntime (`src/runtime/docker.ts`)

`dockerode`-backed implementation of the `ContainerRuntime` interface. Spawns containers on `openclaw-net` (a Docker bridge), labels them `managed-by=openclaw-managed-agents` for orphan detection, caps memory at 2 GiB and PIDs at 512, waits for `/readyz` on the gateway port. `cleanupOrphaned()` is called by `index.ts` at startup — it's a concrete method on the Docker implementation, not on the interface, because the Docker-label filter is backend-specific.

The interface is the seam for cloud backends (ECS, Cloud Run, Container Apps, ECI, VKE) — new backends are drop-in alongside `docker.ts` without touching the pool, router, or server.

The server is self-documenting at `GET /`: the root returns name, description, version, and the full endpoint map. A developer landing on the orchestrator never needs to open a separate reference.

### Orchestrator configuration (`src/index.ts`)

The orchestrator process itself reads a small set of env vars at startup. Everything has a reasonable default; the only variables that are load-bearing under docker-compose are `OPENCLAW_HOST_STATE_ROOT` (host-side bind path for agent containers) and `OPENCLAW_RUNTIME_IMAGE` (which image to spawn).

| Variable | Purpose | Default |
|---|---|---|
| `PORT` | HTTP port for the orchestrator API | `8080` |
| `OPENCLAW_STORE` | `sqlite` \| `memory`. Memory is for tests only — data is lost on restart | `sqlite` |
| `OPENCLAW_STORE_PATH` | SQLite file path (when `OPENCLAW_STORE=sqlite`) | `/var/openclaw/state/managed-runtime.db` |
| `OPENCLAW_STATE_ROOT` | **In-process** path of the mounted sessions directory — used by `PiJsonlEventReader` to open JSONL files | `/var/openclaw/sessions` |
| `OPENCLAW_HOST_STATE_ROOT` | **Host-side** path of the same directory — passed to dockerode when spawning agent containers (the Docker daemon resolves against the host filesystem, so a container-relative path would fail). Must be absolute; startup throws if not | `/var/openclaw/sessions` |
| `OPENCLAW_RUNTIME_IMAGE` | Docker image reference the orchestrator spawns per session | `openclaw-managed-agents/agent:latest` |
| `OPENCLAW_DOCKER_NETWORK` | Docker bridge network the orchestrator and agent containers share | `openclaw-net` |
| `OPENCLAW_GATEWAY_PORT` | Port exposed inside each agent container for its gateway | `18789` |
| `OPENCLAW_READY_TIMEOUT_MS` | Max wait for a newly-spawned container's `/readyz` to respond | `60000` (60 s); `600000` (10 min) in `docker-compose.yml` to accommodate Lightsail's burstable-disk first-boot |
| `OPENCLAW_RUN_TIMEOUT_MS` | Max end-to-end time for a single turn's `/v1/chat/completions` call | `600000` (10 min) |
| `OPENCLAW_IDLE_TIMEOUT_MS` | Active-pool idle timeout before the sweeper reaps a session container | `600000` (10 min) |
| `OPENCLAW_SWEEP_INTERVAL_MS` | How often the pool sweeper runs | `60000` (60 s) |
| `OPENCLAW_MAX_WARM_CONTAINERS` | Cap on pre-warmed containers. Oldest-first eviction when exceeded | `5` |
| `OPENCLAW_WARM_IDLE_TIMEOUT_MS` | Unclaimed-warm reap threshold | same as `OPENCLAW_IDLE_TIMEOUT_MS` |
| `OPENCLAW_ORCHESTRATOR_URL` | URL injected into each spawned container so `openclaw-call-agent` can reach back | `http://openclaw-orchestrator:${PORT}` |
| `OPENCLAW_PASSTHROUGH_ENV` | Comma-separated extra env var names to forward into agent containers | `""` |

Provider API keys (`MOONSHOT_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `AWS_*`, etc.) are forwarded via the `collectPassthroughEnv()` allowlist in `src/index.ts`. Add custom vars via `OPENCLAW_PASSTHROUGH_ENV`. The four `OPENCLAW_MOONSHOT_PRICE_*_USD_PER_M` overrides are in that allowlist by default.

### Agent container (`Dockerfile.runtime`, `docker/entrypoint.sh`)

A Docker image wrapping the published `openclaw` npm package on `node:22-slim`. At startup, the entrypoint script reads environment variables, generates a minimal `openclaw.json`, and execs `openclaw gateway run`. The container serves OpenClaw's existing OpenAI-compatible endpoint on port 18789.

Environment the entrypoint reads:

| Variable | Purpose | Default |
|---|---|---|
| `OPENCLAW_AGENT_ID` | agent id written into `agents.list[].id` — the orchestrator always passes `main` so OpenClaw's `DEFAULT_AGENT_ID` resolver and orphan-key migration Just Work | required |
| `OPENCLAW_MODEL` | `<provider>/<model-id>` reference for the agent's `model.primary` | required |
| `OPENCLAW_PLUGIN` | provider plugin id to enable | derived from `OPENCLAW_MODEL` |
| `OPENCLAW_TOOLS` | comma-separated OpenClaw skill ids (empty = no allowlist) | `""` |
| `OPENCLAW_INSTRUCTIONS` | system prompt override written into `agents.list[].systemPromptOverride` | `""` |
| `OPENCLAW_STATE_DIR` | persistent volume mount path | `/workspace` |
| `OPENCLAW_GATEWAY_PORT` | HTTP port for the gateway | `18789` |
| `OPENCLAW_GATEWAY_TOKEN` | shared-secret bearer token (auto-generated at entrypoint if unset) | orchestrator-injected per container |
| `OPENCLAW_PACKAGES_JSON` | JSON with `pip`, `apt`, `npm` arrays (from environment config) | `""` |
| `OPENCLAW_DENIED_TOOLS` | comma-separated tool names to block (from `deny` permission policy) | `""` |
| `OPENCLAW_CONFIRM_TOOLS` | comma-separated tool names requiring confirmation, or `__ALL__` (from `always_ask` policy) | `""` |
| `OPENCLAW_ORCHESTRATOR_URL` | URL for the in-container `call_agent` CLI to reach the orchestrator | injected per container |
| `OPENCLAW_ORCHESTRATOR_TOKEN` | HMAC-signed parent token for subagent delegation | injected per container |
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
    },
    "controlUi": {
      "dangerouslyDisableDeviceAuth": true
    }
  },
  "agents": {
    "list": [
      {
        "id": "main",
        "model": { "primary": "moonshot/kimi-k2.5" }
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
      "moonshot": { /* full catalog injected at startup by apply-provider-config.mjs
                       from the bundled openclaw extension's buildMoonshotProvider() */ }
    }
  },
  "plugins": {
    "entries": {
      "moonshot": { "enabled": true },
      "confirm-tools": { "enabled": true }
    }
  }
}
```

The `confirm-tools` plugin entry is only present when the agent has `always_ask` permission policy. Similarly, `tools.deny` is only populated when the agent has `deny` policy.

```json
// With deny policy: tools.deny is populated
"tools": { "deny": ["bash", "write"] }

// With always_ask policy: OPENCLAW_CONFIRM_TOOLS env var is set,
// confirm-tools plugin is enabled
```

Four things in this config are load-bearing and are not obvious from the OpenClaw docs:

1. **`gateway.http.endpoints.chatCompletions.enabled: true`** — the OpenAI-compatible endpoint is disabled by default in OpenClaw. The orchestrator calls this endpoint, so it has to be explicitly enabled here.
2. **`gateway.controlUi.dangerouslyDisableDeviceAuth: true`** — lets the orchestrator's `GatewayWebSocketClient` connect as `client.id="openclaw-tui"` with token auth only, skipping the Ed25519 device-signing handshake. Without this, token-auth clients have their operator scopes silently CLEARED and `sessions.abort` returns `missing scope: operator.write`. Safe in our topology because the gateway is bound to `openclaw-net` (a private Docker bridge), only the orchestrator we control reaches it, and the token is per-container random. **Never enable on a gateway bound to a public interface.**
3. **`agents.defaults.models.<model-id>: {}`** — declares the model as the agent-level default. Without this block the runtime logs `Unknown model: <model-id>` at invocation time even when the plugin is loaded and auth is resolved.
4. **`models.providers.<plugin-id>`** — required for providers that do not auto-register their catalog. See the next section for the distinction.

**`bind: lan`** means the gateway binds to `0.0.0.0` inside the container so the orchestrator can reach it over the Docker network by container name. OpenClaw refuses to bind to non-loopback interfaces without a shared-secret auth token; the entrypoint generates one into `OPENCLAW_GATEWAY_TOKEN` (or uses the one the orchestrator injects), OpenClaw's CLI picks it up automatically via `resolveGatewayAuth`, and the orchestrator attaches it as a `Bearer` header on every call.

### Provider plugin categories

OpenClaw provider plugins fall into two categories, and the entrypoint handles each differently.

**Category A: auto-register their catalog at plugin load time.** Plugins built with `definePluginEntry` + `register(api)` — for example `anthropic`, `openai`, `google`, `xai`, `mistral`, `openrouter`, `amazon-bedrock` — register their full model catalog when the gateway starts. For these, the generated config only needs `plugins.entries.<id>: { enabled: true }` plus the agent block. Everything else works automatically.

**Category B: require an onboarding flow to materialize the catalog.** Plugins built with `defineSingleProviderPluginEntry` — for example `moonshot` — define their catalog declaratively through a `catalog.buildProvider` hook that is only invoked during the interactive `openclaw models auth login` flow (`applyMoonshotConfig` in `extensions/moonshot/onboard.ts`). Without that flow, the catalog never appears in the runtime registry and invocation fails with `Unknown model`.

For Category B providers the entrypoint runs `docker/apply-provider-config.mjs` at container startup. That script dynamic-imports the bundled openclaw extension's catalog-builder (e.g. `buildMoonshotProvider()` from `openclaw/dist/extensions/moonshot/provider-catalog.js`) and merges the full catalog into `config.models.providers.<id>`. The upstream catalog is the source of truth — when upstream prices or model IDs change (see [openclaw/openclaw#67928](https://github.com/openclaw/openclaw/pull/67928) for real Moonshot prices), we pick up the change on the next image rebuild with no downstream edit required.

Earlier versions of this runtime hand-mirrored the provider block inside `docker/entrypoint.sh` (the old `PROVIDER_BLOCK_JSON` variable) and had a parallel `OPENCLAW_MOONSHOT_PRICE_*_USD_PER_M` env-var override path to compensate for the upstream catalog's zero prices. Both are gone; the bundled extension is now the single source of truth. Adding another Category B provider (deepseek, qwen, fireworks, together, kilocode) is one line in `PROVIDER_CATALOGS` at the top of `apply-provider-config.mjs`.

### Session persistence and continuity

Each container bind-mounts `/workspace` from a host path derived from the orchestrator-side agent id: `<hostStateRoot>/<agentId>`. Inside the container, OpenClaw always sees itself as agent `main` (OpenClaw's `DEFAULT_AGENT_ID`). That alignment is load-bearing: the session store lives at `agents/main/sessions/sessions.json`, which is where OpenClaw's session-key resolver and orphan-key migration both look by default, and the canonical session key form `agent:main:<session_id>` matches `buildAgentMainSessionKey`'s output so startup migrations don't wipe our mappings as "orphaned". Multi-tenancy is provided by the mount path (one orchestrator agent = one mount = one container at a time), not by naming — the orchestrator's agent id lives in the mount path and Docker label, but inside the container everything is "main".

OpenClaw's session machinery (which wraps Pi's `SessionManager`) writes JSONL under `/workspace/agents/main/sessions/<piSessionId>.jsonl`, plus a `sessions.json` index that maps canonical session keys to those JSONL file ids. When a container is torn down — whether by the pool's idle sweeper, a manual `DELETE /v1/sessions/:id`, or a crash — the files persist on the host volume.

Session continuity across container restarts is carried in the HTTP call, not in env vars. The orchestrator sets **both** of these on every internal `/v1/chat/completions` request:

- `x-openclaw-session-key: agent:main:<session_id>` header (canonical form so OpenClaw's startup orphan-key migration treats it as already-canonicalized and doesn't rewrite it)
- `user: <session_id>` field in the request body

OpenClaw's gateway picks the key up via `resolveSessionKey` in `src/gateway/http-utils.ts` (upstream openclaw repo) and maps it to a persistent session on disk. When a new container starts up and receives a request under a session key that already has a JSONL file, Pi's `SessionManager.open()` loads the prior events and constructs the `AgentSession` with full historical context. The embedded Pi runner (`src/agents/pi-embedded-runner/run/attempt.ts`) then invokes the model with the reconstructed context, so the agent sees the full conversation history, not just the latest user message.

The orchestrator is a **reader-only** participant in this file system. It does NOT write to sessions.json or any JSONL. The only file operations it performs are:

- `PiJsonlEventReader.listBySession` — read + parse for `GET /v1/sessions/:id/events`
- `PiJsonlEventReader.latestAgentMessage` — read + parse for the `sessionResponse.output` field, the Item 9 cost rollup, and the Item 8 chat-completions stale-detection snapshot
- `PiJsonlEventReader.follow` — poll + parse for the SSE streaming endpoint (`?stream=true`)
- `PiJsonlEventReader.deleteBySession` — remove the JSONL + its `sessions.json` entry on `DELETE /v1/sessions/:id` and on ephemeral session reap (Item 8)

Because OpenClaw is the sole writer, there is no sync bug between the orchestrator's view of the event log and Pi's actual state — if you want to know what's in a session, there is exactly one place to look.

For the MVP the JSONL files live on a local Docker bind mount. A future item replaces it with S3 / GCS / Azure Blob / Aliyun OSS / Volcengine TOS via an upstream `SessionStorage` abstraction on OpenClaw.

## Request flow

### Creating an agent template and opening a session

```
1.  Developer  → POST /v1/agents { model, tools, instructions, permissionPolicy?, ... }
                 Server validates + calls agents.create(), which inserts
                 a row in SQLite (version=1) and returns the AgentConfig.
                 Immediately fires router.warmForAgent(agentId) in the
                 background to pre-boot a container in the warm pool.
                 Response: { agent_id, model, tools, instructions, permission_policy,
                   version, created_at, updated_at, ... }
                 Container is already booting — will be claimed by the
                 first session on this agent.

2.  Developer  → POST /v1/sessions { agentId, environmentId? }
                 Server validates environmentId (if provided) exists, checks
                 agent is not archived, calls router.createSession(agentId,
                 {environmentId}), which inserts a sessions row with
                 status=idle, tokensIn=0, tokensOut=0, costUsd=0.
                 Immediately fires router.warmSession(sessionId) in the
                 background (fire-and-forget) to start booting a container.
                 Response: { session_id, agent_id, status: "idle", ... }
                 Container may already be booting from the warm pool (if
                 a pre-warmed container exists for this agent, it's claimed
                 instantly).
```

### First event on a session (cold path — spawns a container)

```
3.  Developer  → POST /v1/sessions/ses_yyy/events { content: "..." }
                 Server calls router.runEvent({sessionId, content}).
                 Session is idle → router calls sessions.beginRun (status → running),
                 returns { session, queued: false } immediately, and schedules
                 executeInBackground as a fire-and-forget task.
                 Response: { session_id, session_status: "running", queued: false }

4.  Background: executeInBackground:
                (a) pool.acquireForSession() — no live container for this session,
                    so runtime.spawn() creates one with the agent's env +
                    passthrough provider keys, mounts <hostStateRoot>/<agentId>
                    at /workspace, joins openclaw-net. Waits for /readyz.
                    Opens a GatewayWebSocketClient and runs the operator
                    handshake. Cache entry stored in active Map, spawnedAt/
                    lastUsedAt stamped.
                (b) If modelOverride was supplied (from the Item 7 model field
                    on POST /events), calls wsClient.patch(canonicalKey,
                    { model }) via the gateway WS.
                (c) invokeChatCompletions — POST http://<container>/v1/chat/completions
                    with Authorization: Bearer <OPENCLAW_GATEWAY_TOKEN>,
                    x-openclaw-agent-id: main, x-openclaw-session-key:
                    agent:main:<session_id>, body { model: "openclaw/main",
                    user: <session_id>, messages: [{role: "user", content}],
                    stream: false }. OpenClaw's embedded agent loop runs
                    tool-using multi-turn turns and returns the final
                    completion. Returns { output, tokensIn, tokensOut }.
                (d) events.latestAgentMessage(agentId, sessionId) reads the
                    newest agent.message from the just-written JSONL and
                    pulls its costUsd (Pi's per-turn cost.total from the
                    provider catalog; Item 9).
                (e) queue.shift(sessionId) — if another event was queued
                    while this run was in flight, the session stays
                    "running", usage is rolled up via addUsage (no status
                    flip), and executeInBackground recurses on the next
                    queued event. Otherwise sessions.endRunSuccess rolls
                    up usage and flips status to idle.

5.  Developer  → GET /v1/sessions/ses_yyy
                 Server reads the session row from SQLite and the newest
                 agent.message from the JSONL via
                 PiJsonlEventReader.latestAgentMessage (that's the
                 computed `output` field on the response).

6.  Developer  → GET /v1/sessions/ses_yyy/events
                 Server iterates the JSONL once and returns the typed
                 Event array.
```

### Subsequent events on the same session (warm path — reuses the container)

Identical to the cold path, except `pool.acquireForSession()` finds the live entry in the active Map, bumps `lastUsedAt`, and returns the existing `Container` + `GatewayWebSocketClient` without spawning anything. Container spawn time (~15 s for Docker local) collapses to ~100 ms of pool overhead.

### Queue path (event arrives while the session is already running)

```
runEvent sees session.status === "running"
  → queue.enqueue(sessionId, { content, model? })
  → returns { session, queued: true }
  Response: { session_id, session_status: "running", queued: true }

  No new run is scheduled. The in-flight executeInBackground will pop
  the queue on its success path and recurse. Session status stays
  "running" for the whole chain so polling clients never observe a
  brief idle window between queued runs.
```

### Cancel path (`POST /v1/sessions/:id/cancel`)

```
router.cancel(sessionId):
  (a) validate session.status === "running", else 409
  (b) pool.getWsClient(sessionId) — must exist since the session is running
  (c) wsClient.abort("agent:main:<session_id>") via the gateway WS
      (wraps the gateway's sessions.abort method)
  (d) queue.clear(sessionId) so the success path doesn't auto-restart
  (e) sessions.endRunCancelled — flips status to idle, clears error
  Response: { session_id, session_status: "idle", cancelled: true }

The in-flight chat completions HTTP request inside executeInBackground
errors out as a side effect of the WS abort. handleBackgroundFailure
checks session.status before transitioning — finds it already idle —
and leaves the session + container alone. The container stays healthy
in the pool for the next event.
```

### OpenAI-compat adapter (`POST /v1/chat/completions`)

```
1.  Validate x-openclaw-agent-id header + agent exists.
2.  Parse body (permissive .passthrough() Zod schema).
3.  Extract the trailing role=user message with string content.
4.  Session resolution:
      sessionKey = header("x-openclaw-session-key") ?? body.user
      - If present and matches ^[a-zA-Z0-9_-]{1,128}$:
          existing → reuse (409 on agent mismatch)
          missing  → create with that key, non-ephemeral
      - If absent → create with generated id, ephemeral=true
5.  Stale-detection snapshot: beforeEventId = events.latestAgentMessage?.eventId
6.  router.runEvent({sessionId, content}) — idle path starts a run,
    running path queues. The handler doesn't care which.
7.  Poll sessions.get(sessionId) every 500 ms, 600 s cap:
      status === "failed" → cleanup-if-ephemeral + 500
      timeout              → cleanup-if-ephemeral + 504
      status !== "running" → break
8.  afterMsg = events.latestAgentMessage(agentId, sessionId)
    If !afterMsg or afterMsg.eventId === beforeEventId → 500
    (Guards the subtle race where the JSONL write is delayed or
     a status flip happens without a new message. Also guards the
     queue-drain intersection — a chat.completions call on an
     already-running session must return ITS reply, not a prior
     run's reply that's still the newest thing in the JSONL until
     the new reply lands.)
9.  Build OpenAI-shaped response:
      id: chatcmpl-<afterMsg.eventId>
      object: chat.completion
      created: afterMsg.createdAt (Unix seconds)
      model: afterMsg.model ?? agent.model.primary
      choices: [{index: 0, message: {role: "assistant", content: afterMsg.content}, finish_reason: "stop"}]
      usage: { prompt_tokens, completion_tokens, total_tokens } from afterMsg
10. If body.stream === true, write the same content as an emulated
    SSE stream (three chunks: role → content → finish, then [DONE]).
```

### Live event streaming (`GET /v1/sessions/:id/events?stream=true`)

```
Server wires an AbortController from sse.onAbort and starts a 15 s
heartbeat interval that also checks for session status transitions.

1. Emit initial session.status_<status> SSE event on connect.
2. PiJsonlEventReader.follow() runs:
     Phase 1 — catch-up: yield every existing event in order
     Phase 2 — tail-follow: 250 ms poll loop, emit any events whose
               Pi event_id is new since the last yield
3. On each yielded event and each heartbeat tick, check if session
   status changed → emit session.status_<new> SSE event.
4. After follow() returns, emit a final status event if it changed.

Terminates on AbortSignal OR when isSessionRunning() returns false
AND nothing new has landed for 30 s (grace period so clients can
stream across multiple turns without reconnecting).

Event types in the stream: all 10 JSONL-derived types (user.message,
agent.message, agent.tool_use, agent.tool_result, agent.thinking,
session.model_change, session.thinking_level_change, session.compaction)
plus synthetic session.status_idle / session.status_running /
session.status_failed and 15 s heartbeat events.
```

## Token and cost accounting

**Tokens** come from the OpenAI-compat HTTP response. `invokeChatCompletions` reads `usage.prompt_tokens` and `usage.completion_tokens` from the container's reply and passes them through to the `RunUsage` that `endRunSuccess` / `addUsage` rolls into the session.

**Cost** comes from Pi's JSONL. After `invokeChatCompletions` returns, `executeInBackground` calls `events.latestAgentMessage(agentId, sessionId)` and reads `costUsd` off the returned event. `PiJsonlEventReader.mapLineToEvent` surfaces it from `message.usage.cost.total` in the JSONL, which Pi's provider plugins compute from their catalogs.

Why read from the JSONL instead of computing cost in the orchestrator:

1. **Pi is already the authority.** Its provider plugins know the catalogs, the cache-aware rates, and the provider-specific quirks. Maintaining a second static price sheet in the orchestrator would drift from the real provider prices within weeks.
2. **Cache-aware for free.** Moonshot and Anthropic both bill `cacheRead` tokens at a much lower rate than fresh input. A naive `tokens * perMillion` sheet ignores that and reports the wrong number. Pi's per-turn cost already includes the cache discount.
3. **Zero hardcoding.** The orchestrator is provider-agnostic. It does not embed knowledge of any particular provider's pricing.

When cost is zero: if a provider plugin does not report cost, `message.usage.cost.total` stays 0, and that's what the orchestrator rolls up. Moonshot's upstream catalog currently ships zero prices (tracked by [openclaw/openclaw#67928](https://github.com/openclaw/openclaw/pull/67928), which populates real per-token prices); once that PR lands and we bump the `openclaw` pin in `Dockerfile.runtime`, Moonshot runs start reporting real `cost_usd` through `apply-provider-config.mjs` with no other code change required. Any Category A provider (anthropic, openai, google, xai, mistral, openrouter, amazon-bedrock) whose plugin auto-registers its catalog reports a real non-zero value today without any operator action.

## What lives where

| Concern | Home |
|---|---|
| Agent loop (tool use, multi-turn) | OpenClaw (`src/gateway/openai-http.ts` → `agentCommandFromIngress` → embedded Pi runtime) |
| Tool execution | OpenClaw (plugin SDK, skills, sandbox) |
| Model provider integration | OpenClaw (`extensions/<provider>/`) |
| Per-turn cost from provider catalogs (cache-aware) | OpenClaw / Pi — `message.usage.cost.total` in the JSONL |
| Session event log (source of truth) | OpenClaw / Pi `SessionManager` — `<stateRoot>/<agentId>/agents/main/sessions/<piId>.jsonl` |
| Gateway WebSocket control plane (abort, steer, patch) | OpenClaw (`docs/gateway/protocol.md`) |
| Managed-agent HTTP API surface | Orchestrator (`src/orchestrator/server.ts`) |
| OpenAI-compat adapter (`POST /v1/chat/completions`) | Orchestrator (`src/orchestrator/server.ts` — handler block) |
| Durable state for agents + environments + sessions + versions | Orchestrator (`src/store/sqlite.ts`, with `InMemoryStore` for tests) |
| Event log read path (list, latest, tail-follow) | Orchestrator (`src/store/pi-jsonl.ts`) |
| Multi-tenant isolation | Orchestrator — one container per session, owned by `SessionContainerPool` |
| Per-session container lifecycle + reuse | Orchestrator (`src/runtime/pool.ts`) |
| Ephemeral session cleanup (Item 8) | Orchestrator — pool's `cleanupOnReap` callback wired in `src/index.ts` |
| WebSocket control client per container | Orchestrator (`src/runtime/gateway-ws.ts`) |
| In-memory per-session event queue | Orchestrator (`src/orchestrator/event-queue.ts`) |
| Run orchestration + queue drain + cost rollup | Orchestrator (`src/orchestrator/router.ts`) |
| Parent-token minting + verification (Item 12-14) | Orchestrator (`src/runtime/parent-token.ts`) |
| In-container delegation CLI (`openclaw-call-agent`) | Runtime image (`docker/call-agent.mjs` → `/usr/local/bin/openclaw-call-agent`) |
| Per-session remaining subagent depth | SQLite `sessions.remaining_subagent_depth` + TS `Session.remainingSubagentDepth` |
| Delegation allowlist + recursion cap | SQLite `agents.callable_agents_json` + `agents.max_subagent_depth` on the template row |
| Agent versioning + archive | Orchestrator (`src/store/sqlite.ts` — `agents` + `agent_versions` tables) |
| Environment abstraction | Orchestrator (`src/store/sqlite.ts` — `environments` table, wired into session creation) |
| Permission policy enforcement (deny) | Container — `tools.deny` in generated `openclaw.json` |
| Permission policy enforcement (always_ask) | Container — `confirm-tools` plugin + orchestrator WS approval flow |
| Pre-warmed container pool | Orchestrator (`src/runtime/pool.ts` — `warm` Map alongside `active`) |
| Python SDK | `sdk/python/openclaw_managed_agents/` — httpx + httpx-sse, publishable to PyPI |
| Local container backend | Orchestrator (`src/runtime/docker.ts`, implements `ContainerRuntime`) |
| Config generation for each container | Entrypoint (`docker/entrypoint.sh`) |
| Cloud container backends | Orchestrator (`src/runtime/{ecs,cloudrun,container-apps,...}.ts`, same `ContainerRuntime` interface — Item 10) |
| Cloud session storage | Orchestrator + upstream OpenClaw `SessionStorage` abstraction — future |
| Cloud secrets integration | Orchestrator + upstream OpenClaw `SecretRef` extension — future |

## Why this works with zero upstream changes

Everything the runtime needs is already in OpenClaw. There is no fork, no local patch, no upstream PR blocking any of the items shipped so far.

| Need | Already exists in OpenClaw |
|---|---|
| API-only startup | Yes — if no channels are configured, the gateway doesn't initialize any |
| HTTP agent API | Yes — `/v1/chat/completions` runs the full agent loop |
| WebSocket control plane (abort, steer, patch) | Yes — documented at `openclaw/docs/gateway/protocol.md` |
| Config from env | Yes — `OPENCLAW_CONFIG_PATH` points at a generated file |
| Health checks | Yes — `/healthz` and `/readyz` are built in |
| Model providers | Yes — bundled plugins for Anthropic, OpenAI, Google, Bedrock, Moonshot, DeepSeek, Qwen, Mistral, xAI, OpenRouter, and more |
| Session persistence | Yes — JSONL on disk, portable via mounted volume |
| Session resume across container restarts | Yes — Pi `SessionManager.open()` rebuilds the `AgentSession` from the JSONL when the next container spawns under the same canonical key |
| Per-turn cost from provider catalogs (cache-aware) | Yes — `message.usage.cost.total` written to JSONL by Pi's provider plugins |
| Per-agent tool subsets | Yes — `agents.list[].tools.alsoAllow` |
| Session-key resolver that honors `agent:main:<id>` | Yes — `resolveSessionKey` in `src/gateway/http-utils.ts` plus the orphan-key migration |
| Bearer-token auth on non-loopback binds | Yes — `OPENCLAW_GATEWAY_TOKEN` |

Future upstream contributions (nice-to-have, not blocking):

- **`defineSingleProviderPluginEntry` auto-register** — would eliminate the `PROVIDER_BLOCK_JSON` hack in `docker/entrypoint.sh` for Category B providers (currently moonshot; likely deepseek, qwen in the future).
- **`SessionStorage` abstraction** — would let us swap the host bind mount for S3 / GCS / Azure Blob / Aliyun OSS / Volcengine TOS without reimplementing Pi's SessionManager.
- **`SecretRef` extension** — would let us pull provider API keys from AWS Secrets Manager / GCP Secret Manager / Azure Key Vault with rotation, replacing the env-var passthrough.
- **Real-time delta forwarding** — an HTTP/SSE wrapper around Pi's `AgentSessionEvent` bus would let `GET /v1/sessions/:id/events?stream=true` and `POST /v1/chat/completions stream=true` forward token-by-token deltas instead of polling the JSONL.
- **`sessions.compact` and `sessions.navigateTree`** exposed over the gateway WS control plane — currently there's no WS handler for compact or branch, which is why the runtime's control surface stops at cancel + steer + send + patch.

## Observability

Structured logs, per-request correlation, and Prometheus metrics. No tracing yet — open for a future item.

### Logs (`src/log.ts`)

- [pino](https://getpino.io) with JSON output in production (`NODE_ENV=production`) and pretty-printed TTY in dev. Log level via `OPENCLAW_LOG_LEVEL` (default `info`).
- Every line carries `service: "openclaw-managed-agents"`, `module: "<router|pool|server|index>"`, `level`, `time`, and `msg`. When relevant, `request_id`, `agent_id`, `session_id` are automatically mixed in from the active AsyncLocalStorage scope — callers never thread those by hand.
- `getLogger(module)` — child logger per file. `rootLogger` — unscoped, used for fatal-at-startup lines only.
- `withContext({requestId, agentId?, sessionId?}, fn)` — run `fn` (and every awaited descendant) under a scope where the given fields appear on every log line. The server middleware wraps every request in one; the router adds session/agent ids via `addContext({sessionId, agentId})` once the handler resolves them.
- `withCapturedContext(fn)` — capture the current scope into a closure so a fire-and-forget continuation (`void promise.catch()`, `setTimeout`) keeps the same `request_id` when it eventually runs. Used in `router.runEvent` to carry request id through the background `executeInBackground` task, so a client trace stays one request id end-to-end.

### Request id

Every HTTP response includes an `x-request-id` header. If the client supplies one, it's honored; otherwise the server generates `req_<8-byte-hex>`. The same id threads into every log line for that request via AsyncLocalStorage. Clients correlating across multiple orchestrator logs (e.g., in `docker compose logs openclaw-orchestrator | jq 'select(.request_id == "req_xxx")'`) get a single request's full story without extra instrumentation.

### Metrics (`src/metrics.ts`, `GET /metrics`)

Prometheus text format at `GET /metrics` (no auth gate — same as `/healthz`, operators firewall the port if metrics should not be public). Served from a process-wide [`prom-client`](https://github.com/siimon/prom-client) `Registry` with `collectDefaultMetrics` attached, so Node process metrics (CPU seconds, RSS, heap usage, event-loop lag) land for free.

| Metric | Type | Labels | Source |
|---|---|---|---|
| `http_requests_total` | counter | `method`, `route`, `status` | Server middleware, every request |
| `http_request_duration_seconds` | histogram | `method`, `route` | Same middleware |
| `pool_active_containers` | gauge | — | Mutations of `SessionContainerPool.active` |
| `pool_warm_containers` | gauge | — | Mutations of `SessionContainerPool.warm` |
| `pool_acquire_total` | counter | `source=active\|warm\|spawn` | `acquireForSession` — one of the three branches it took |
| `pool_spawn_duration_seconds` | histogram | — | `doSpawn` (runtime.spawn + waitForReady + WS handshake) |
| `session_run_duration_seconds` | histogram | — | `router.executeInBackground` around `invokeChatCompletions` |
| `session_run_failures_total` | counter | — | `handleBackgroundFailure` |
| `agents_created_total` | counter | — | `POST /v1/agents` |
| `session_events_total` | counter | `type=user.message\|user.tool_confirmation` | `POST /v1/sessions/:id/events` |

Label cardinality is deliberately bounded: `route` is the matched Hono pattern (`/v1/sessions/:sessionId`), never the raw URL, so user-supplied ids don't explode the series count.

### Scraping

```bash
curl -s http://<orchestrator>:8080/metrics | head
```

The output is standard Prometheus text format with version `0.0.4`. Any Prometheus server, Grafana Agent, VictoriaMetrics, or OpenTelemetry Collector with a Prometheus receiver can scrape it.

## Testing

The project has two layers of tests that serve different purposes.

**Unit tests (`src/**/*.test.ts`, vitest).** Fast, no Docker required. Cover the three modules that encode load-bearing semantics you cannot see through the HTTP surface:

- `src/runtime/parent-token.test.ts` — HMAC round-trip, rejection of tampered / expired / malformed / wrong-secret tokens, allowlist + depth edge cases.
- `src/orchestrator/event-queue.test.ts` — FIFO order, per-session isolation, clear semantics.
- `src/store/pi-jsonl.test.ts` — JSONL fixture files in a tmp dir; asserts user/assistant/tool/toolResult parsing, empty-content assistant message drop (Pi auto-retry noise), malformed-line recovery, `latestAgentMessage` reverse scan, `deleteBySession` removal of both JSONL and `sessions.json` entry.
- `src/log.test.ts` — AsyncLocalStorage context: `withContext` propagation, `addContext` mutation semantics, parallel-scope isolation, `withCapturedContext` deferred-execution binding, nested-scope shadowing.
- `src/metrics.test.ts` — Prometheus registry: expected metric names present, default Node.js process metrics attached, `service` label set, counter/gauge/histogram render correctly to the scrape endpoint.

Run via `pnpm test`. Adding a new test module is just dropping a `*.test.ts` file alongside the source; vitest discovers it automatically.

**End-to-end (`test/e2e.sh`, bash + curl + jq).** Exercises the full stack: spawns real containers via `docker compose up`, creates agents and sessions through the HTTP API, verifies multi-turn memory + pool reuse + SQLite persistence across orchestrator restart + OpenAI-compat + SSE streaming + cancel + queue ordering + delegated subagents + `always_ask` flow + agent versioning + environment CRUD. Requires a provider API key and ~5 minutes per run.

Covering `router.ts` and `pool.ts` in unit tests is harder because both take concrete infrastructure (Docker, WebSockets). The e2e suite validates them end-to-end; a follow-up could add in-memory mocks of `ContainerRuntime` and `GatewayWebSocketClient` for faster router-level coverage.

## Security notes

- **Container auth.** Every spawned agent container gets a random 32-byte-hex `OPENCLAW_GATEWAY_TOKEN`. The orchestrator keeps the token in memory on the `Container` object and attaches it as a Bearer header on every call to that container. `/healthz` and `/readyz` bypass auth (they have to, for Docker healthchecks and orchestrator readiness polling); everything else requires the token.
- **Network isolation.** Containers join `openclaw-net` (a bridge network) and are addressable only by their container name. They do not publish ports to the host. The orchestrator reaches them by name over the shared network.
- **Resource limits.** Each container is capped at 2 GiB memory and 512 PIDs. Adjust in `src/runtime/docker.ts`:`spawn()` for production deploys.
- **Credential passthrough.** Provider API keys are passed as env vars from the orchestrator into each spawned container. A future item replaces this with cloud-native secret managers (AWS Secrets Manager, GCP Secret Manager, Azure Key Vault, etc.) via an upstream OpenClaw `SecretRef` extension.
- **Gateway WebSocket control plane.** The orchestrator opens one WebSocket per live container and runs the operator handshake with `controlUi.dangerouslyDisableDeviceAuth: true` set in the generated `openclaw.json`. That flag is safe because the gateway is bound to `openclaw-net` (a private Docker bridge), only the orchestrator ever reaches it, and the per-container token is random 32-byte hex. Never enable that flag on a gateway bound to a public interface.

## Swapping providers

The runtime is provider-agnostic. To switch a running agent or the smoke default off Moonshot:

1. Export the matching API key on the host (e.g. `export OPENAI_API_KEY=sk-...`). `docker-compose.yml` forwards every common provider env var into the orchestrator by default.
2. Change `OPENCLAW_MODEL` in `Dockerfile.runtime` (or override per-agent in the `POST /v1/agents` body), e.g. `openai/gpt-5.4`, `anthropic/claude-sonnet-4-6`, `google/gemini-2.5-pro`, `bedrock/anthropic.claude-sonnet-4-6`, `openrouter/moonshotai/kimi-k2.5`.
3. If the provider is Category B (see "Provider plugin categories" above), extend `PROVIDER_BLOCK_JSON` in `docker/entrypoint.sh` with the equivalent `models.providers.<id>` block.
4. Rebuild the runtime image: `docker build -f Dockerfile.runtime -t openclaw-managed-agents/agent:latest .`

No orchestrator changes are required for Category A providers.
