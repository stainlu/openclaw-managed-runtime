# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

OpenClaw Managed Agents is an API-first managed agent runtime — the open alternative to Claude Managed Agents. A stateless Hono/TypeScript orchestrator spawns one OpenClaw container per session on top of the host Docker daemon (via dockerode), then reads OpenClaw's per-session JSONL event log at query time. The `openclaw` npm package is pinned in `Dockerfile.runtime` and used unmodified — no fork, no patches.

## Common commands

Package manager is pnpm. Node `>=22.14.0`.

```bash
pnpm install                    # install deps (rebuilds better-sqlite3 native module)
pnpm build                      # tsc → dist/
pnpm dev                        # tsx watch src/index.ts (local dev, no Docker build)
pnpm start                      # node dist/index.js (after build)
pnpm lint                       # tsc --noEmit (type-check only, no emit)
pnpm test                       # vitest run — all *.test.ts under src/
pnpm test -- src/orchestrator/router.test.ts       # single file
pnpm test -- -t "cancel"        # single test by name
pnpm docker:build               # builds both orchestrator + runtime images locally
docker compose up --build -d    # full local stack on :8080, rebuilds both images
./test/e2e.sh                   # live end-to-end run (needs compose up + provider key)
```

The egress-proxy sidecar (`docker/egress-proxy/`) is a separate package using the stdlib `node:test` runner — vitest excludes `docker/**` in `vitest.config.ts`. Run those tests from inside their own Docker image build.

### E2E workflow

`test/e2e.sh` exercises the full session-centric API against a live provider. Requires `docker compose up -d` and a provider key exported in the host shell (forwarded by compose into the orchestrator, then into each spawned agent). Override model via `OPENCLAW_TEST_MODEL=anthropic/claude-sonnet-4-6 ./test/e2e.sh`. Default is `moonshot/kimi-k2.5`.

### Deploy scripts

```bash
./scripts/deploy-hetzner.sh         # needs HCLOUD_TOKEN + provider key
./scripts/deploy-aws-lightsail.sh   # needs AWS_ACCESS_KEY_ID/SECRET + provider key
./scripts/deploy-gcp-compute.sh     # needs `gcloud auth login` + provider key
./scripts/rotate-api-token.sh hetzner|lightsail|gcp|local <host-or-instance>
```

All three use the same multi-arch GHCR images published by `.github/workflows/publish-images.yaml` on every push to `main`.

## Architecture

Read `docs/architecture.md` for the full treatment; the summary below is the minimum needed to navigate the repo.

### Core invariants

1. **One OpenClaw container per session.** OpenClaw is single-user by design. Multi-user semantics are created externally by the orchestrator's `SessionContainerPool`, not by modifying OpenClaw.
2. **Container vs session lifetime.** Sessions are durable (SQLite row + JSONL on the host mount). Containers are ephemeral — spawned on first event, reaped after idle. On respawn, Pi's `SessionManager.open()` rebuilds `AgentSession` from the JSONL so history survives. "Cattle for compute; pets for session state."
3. **Orchestrator is stateless.** All durable state is in SQLite (agents/environments/sessions) or Pi JSONL files (events). Restart rehydrates: any session still `running` is flipped to `failed` with message `"orchestrator restarted mid-run"`. Orphan containers (labeled `managed-by=openclaw-managed-agents`) are stopped at startup. HMAC secret for parent-tokens regenerates, invalidating outstanding subagent tokens — consistent with the "restart drops ephemeral state" pattern.
4. **Events live in JSONL, not SQLite.** Never write the orchestrator's notion of events to durable storage; read them at query time via `PiJsonlEventReader` pointed at the mounted state dir.

### Module map (`src/`)

| Path | Role |
|---|---|
| `src/index.ts` | Process entrypoint. Reads env, wires runtime → pool → stores → reader → router → server. `collectPassthroughEnv()` defines the provider-API-key allowlist forwarded into agent containers. |
| `src/orchestrator/server.ts` | Hono app. All HTTP routes, SSE via `streamSSE`, OpenAI-compat `POST /v1/chat/completions`. `handleRouterError` maps `RouterError` codes → HTTP status. |
| `src/orchestrator/router.ts` | `AgentRouter`. The brain — owns `runEvent`, `cancel`, `confirmTool`, `executeInBackground`, `warmSession`, `warmForAgent`. |
| `src/store/{types,sqlite,memory}.ts` | `QueueStore` — per-session FIFO for events posted to a `running` session. SQLite-backed by default, so queued work survives restart. |
| `src/runtime/pool.ts` | `SessionContainerPool` — two pools in one: active (per-session) + warm (per-agent, pre-booted). Unref'd sweeper reaps idle. `cleanupOnReap` is called **only** from the idle path. |
| `src/runtime/docker.ts` | `DockerContainerRuntime` (dockerode). The only backend today; the interface is the seam for future cloud backends (ECS, Cloud Run, etc.). |
| `src/runtime/container.ts` | `ContainerRuntime` interface. Implementations live alongside `docker.ts`. |
| `src/runtime/gateway-ws.ts` | Operator-role WebSocket client to each container's OpenClaw gateway. Backs cancel/steer/patch/approvalResolve/approvalList. Uses `client.id = "openclaw-tui"` (load-bearing — see the comment in `gateway-ws.ts`). |
| `src/runtime/parent-token.ts` | `ParentTokenMinter` — HMAC-SHA256 tokens for subagent delegation. One minter per orchestrator process; `src/index.ts` persists and reloads its secret via `SecretStore`, so delegation tokens survive restart. |
| `src/store/` | `AgentStore` / `EnvironmentStore` / `SessionStore` interfaces + SQLite (default) + InMemory (tests). `buildStore()` is the factory. `PiJsonlEventReader` is here too. |

### Request lifecycle — `POST /v1/sessions/:id/events`

1. Server validates body (user.message or user.tool_confirmation).
2. `AgentRouter.runEvent` — if session is `idle`: `beginRun` → fire-and-forget `executeInBackground`. If `running`: enqueue on `QueueStore`.
3. `executeInBackground` → `pool.acquireForSession({sessionId, agentId, spawnOptions})` — three sources checked in order: active, warm (template-compatible only), fresh spawn.
4. Optional WS `patch` for model override.
5. HTTP call to container's `/v1/chat/completions`.
6. After completion: read `latestAgentMessage` from JSONL for cost rollup. Drain queue (recursively run next enqueued event) OR `endRunSuccess`.
7. On background failure, `handleBackgroundFailure` checks `session.status !== "running"` — if not running, the failure was a side-effect of an external cancel and we leave state alone.

### Subagent delegation

Entirely additive over the existing API — no new types, no new routes. The in-container CLI `openclaw-call-agent` (`docker/call-agent.mjs`) posts back to `POST /v1/sessions` with an HMAC-signed `X-OpenClaw-Parent-Token` header. A subagent session is a first-class `Session`: observable via the same listing/events/cancel endpoints. Agent templates opt in via `callableAgents: string[]` + `maxSubagentDepth: number` (defaults `[]` / `0`).

**Warm-pool exception.** `AgentRouter.warmForAgent` is skipped for delegating agents (`callableAgents.length > 0 || maxSubagentDepth > 0`). The sessionId is baked into Docker env at spawn time, and Docker env is immutable post-create — a warm container built with a placeholder sessionId would carry it into every subagent spawn the claimed session later hosts, producing wrong token lineage silently. See the long comment at `AgentRouter.warmForAgent` if you're about to "optimize" this.

### Permission policy

Three policies on agent templates:
- `always_allow` (default) — all tools run.
- `deny` — tools blocked via OpenClaw's `tools.deny` config.
- `always_ask` — tools pause via the `confirm-tools` plugin (`docker/confirm-tools-plugin/`). The plugin installs from image path `/opt/openclaw-plugins/confirm-tools/` → `/workspace/extensions/confirm-tools/` via the entrypoint, registers a `before_tool_call` hook returning `requireApproval`. Gateway broadcasts `plugin.approval.requested` / `plugin.approval.resolved`; the orchestrator rehydrates pending approvals via `approvalList()`, surfaces them as `agent.tool_confirmation_request`, and the client resolves them via `user.tool_confirmation` → `router.confirmTool` → `wsClient.approvalResolve`.

### Cost accounting

Per-session rolling `tokens_in`, `tokens_out`, `cost_usd` sourced from the provider's billing data (cache-aware, not a static price sheet). Anthropic / OpenAI / Google / xAI / Mistral / OpenRouter / Bedrock report non-zero cost automatically. Moonshot and DeepSeek direct-provider v4 models currently get real cost via the runtime's `docker/provider-prices.json` patches layered onto the bundled catalog; when upstream ships the same prices and model ids, deleting the local provider block cleanly defers back to upstream.

### Observability

Structured pino logs — JSON in production, pretty TTY in dev. Every log line auto-carries `request_id`, `agent_id`, `session_id` via AsyncLocalStorage. Prometheus metrics at `GET /metrics`: HTTP counters + duration histograms, pool active/warm gauges, spawn + run duration histograms, per-source pool-acquire counters, `rate_limit_rejections_total{kind="token"|"ip"}`. `/healthz` and `/metrics` bypass both auth and rate-limit middleware.

## Host/container path duality

This trips people up. The orchestrator runs inside a container with `/var/run/docker.sock` mounted, so when it spawns agent containers via dockerode, the Docker daemon resolves bind-mount paths against the **host** filesystem, not the orchestrator's container filesystem. Hence two env vars for the same directory:

- `OPENCLAW_STATE_ROOT` — in-process path (orchestrator's view) used by `PiJsonlEventReader`.
- `OPENCLAW_HOST_STATE_ROOT` — host-side path passed to dockerode for agent-container bind mounts. Must be absolute; `src/index.ts` throws at startup if not. In compose, this is `${PWD}/data/sessions` (shell-evaluated at `docker compose up` — **run compose from the repo root** or this resolves to the wrong directory).

For `pnpm dev` (no compose), set both env vars to the same absolute host directory.

## Provider credentials

`src/index.ts:collectPassthroughEnv()` is the single source of truth for which host env vars flow into agent containers. Defaults cover AWS (Bedrock credential chain) + 15 direct provider keys. Extend via `OPENCLAW_PASSTHROUGH_ENV=KEY1,KEY2,...` — don't hardcode new providers in the default list without a reason.

## Auth + rate limiting

- `OPENCLAW_API_TOKEN` — single shared bearer token for the public HTTP API. Empty = disabled (localhost dev default). When set, every route except `/healthz` and `/metrics` requires `Authorization: Bearer <token>` (constant-time compare). Multi-tenancy is deliberately out of scope — stack a reverse proxy.
- `OPENCLAW_RATE_LIMIT_RPM` — per-caller token bucket (default 120 rpm / 120 burst). Keyed by Bearer token when present, else client IP (`x-forwarded-for` first entry). **Runs before auth** so unauthenticated floods can't exhaust the orchestrator. `0` disables.

## Networking policies

`environment.networking` accepts `"unrestricted"` (default, full network access) and `"limited"` (under active rollout — Linux-only egress-proxy sidecar). Accepting `"limited"` without actually enforcing would be false security, so the schema rejects it until per-container iptables enforcement ships on the platform. See `docs/designs/networking-limited.md` for the rollout plan.

## SDKs

- Python (`sdk/python/`) — publishable as `openclaw-managed-agents`, `httpx` + `httpx-sse`.
- TypeScript (`sdk/typescript/`) — publishable as `@stainlu/openclaw-managed-agents`.
- OpenAI drop-in — any OpenAI SDK pointed at `http://<host>:8080/v1` with `x-openclaw-agent-id` header. Sticky sessions via the `user` field or `x-openclaw-session-key` header. `stream: true` proxies the container's real OpenAI-compatible SSE chunks.

## Adding a new `ContainerRuntime` backend

The `ContainerRuntime` interface in `src/runtime/container.ts` is the seam for non-Docker backends (ECS, Cloud Run, Container Apps, Azure ECI, etc.). To add one:

1. Implement `spawn(opts) → Container`, `stop(id)`, `waitForReady(c, timeoutMs)` in a new module like `src/runtime/ecs.ts`.
2. Import `runContainerRuntimeContract` from `src/runtime/container-contract.ts` and run it from a test file with your backend's factory. If the suite passes, the pool, router, and startup adoption will all Just Work.
3. Honor `spawn-time env` and `labels` verbatim — the adopt-on-restart path in `src/index.ts` reads `orchestrator-session-id`/`orchestrator-agent-id` labels plus the `OPENCLAW_GATEWAY_PORT` / `OPENCLAW_GATEWAY_TOKEN` env vars via your backend's equivalent of `docker inspect`. Your backend must expose a `listManaged()` method analogous to `DockerContainerRuntime.listManaged()` if you want reattach to survive across restarts.
4. `index.ts` picks the runtime by constructing it directly today; introduce a small factory if you plan to ship multiple backends in the same binary.

## Things to avoid

- Don't add an "events" table to SQLite. Events are in Pi JSONL by design. Duplicating them guarantees drift.
- Don't plumb the store into `SessionContainerPool`. The pool takes `isBusy` and `cleanupOnReap` callbacks; `src/index.ts` closes over the store to provide them. Keeps the runtime layer decoupled from the orchestrator layer.
- Don't remove the delegating-agent exclusion in `warmForAgent` — see the "Warm-pool exception" section above.
- Don't put hot paths behind a fallback when the primary fails. If a provider/runtime/store is broken, fail loudly — never silent-fallback.
- Don't use `git clean -fdx` or any destructive git command. Confirm before any reset/force-push.
