# Design: cold-start latency reduction

**Status.** Planned — not shipped. Partial mitigation in place: warm-pool TTL raised from 10 min → 30 min (commit TBD in this branch); portal fires `POST /v1/agents/:id/warm` on agent-row click so the cold spawn starts during the user's "type the message" window. Instrumentation for per-step timings is live in `src/runtime/pool.ts` (`doSpawn`, `doWarmForAgent`) and `src/orchestrator/router.ts` (`executeInBackground`).

**Scope.** Reduce first-turn latency from "I clicked Send" to "first visible agent action" in a session that does not already have an active container.

**Corresponds to.** User-reported 20-40s first-message wait on `localhost` + macOS Docker Desktop, verified by runtime profiling on 2026-04-19.

## Problem

First-message latency today, measured on a fresh session:

```
POST /v1/sessions/:id/events received  →  chat.completions dispatched
  oauth_refresh_ms           0
  build_spawn_options_ms     1
  pool_acquire_ms         ~7000   ← entirely inside pool.acquireForSession
  ws_patch_ms                0
  total_pre_llm_ms       ~7000

pool_acquire breakdown when the path is a fresh cold spawn:
  container_create_ms      ~350   Docker create + start
  ready_wait_ms           ~6700   container gateway reports /readyz ← DOMINANT
  ws_connect_ms             ~35   WS handshake
```

Inside `ready_wait_ms` (7 s on fast Linux, 15-20 s on Docker Desktop macOS), the agent container is blocked on the `openclaw gateway run` process: plugin discovery, SQLite migrations, provider catalog load, port bind.

Our own entrypoint script (`docker/entrypoint.sh`) accounts for ~500 ms of that total — jq-based config synthesis + `apply-provider-config.mjs` Node dynamic-import. Not the bottleneck.

**The JSONL's "2.5 s to first tool" number is measured from the container's own boot clock** — `session.model_change` (first JSONL event) is `T=0`, and `user.message` is `T=0.03s`. The 7 s before the container wrote its first event is invisible to that measurement. A user seeing the bubble stay empty for 25-40 s is observing the cold spawn plus Moonshot's TTFT, not a bug in the event pipeline.

## Goals

1. **Cut median first-message latency to under 2 s** on Linux hosts, under 5 s on Docker Desktop macOS. Hide cold spawn entirely on the active developer workflow.
2. **Measured numbers, not estimates.** Every decision below is gated on before/after timings from the existing `pool_acquire_ms` + `ready_wait_ms` log lines.
3. **Preserve current invariants.** One openclaw process per session-key boundary; orchestrator stateless; events live in JSONL; the `ContainerRuntime` seam stays.
4. **No silent fallbacks.** If a fast path is broken, the slow path still runs and a metric fires — we never degrade silently.

## Non-goals

1. Reducing Moonshot / Anthropic / OpenAI API TTFT. Anything labeled "Moonshot thinking" in the trace is the model provider's wall clock, not ours.
2. Streaming agent tokens to the portal. Separate UX work; tracked elsewhere.
3. Rewriting openclaw itself. We treat it as an unmodified dependency, per the current project invariant.
4. Cold-starting on hardware smaller than the documented 2 GiB-per-container floor. Below that, `ready_wait_ms` is memory-pressure-bound; a latency fix won't help.

## Options

Five roads were considered. Listed in rising order of cost and reward.

### Option A — entrypoint micro-optimizations

- Skip `apply-provider-config.mjs` for Category A providers (Anthropic / OpenAI / Google / xAI / Mistral / Bedrock). Their plugins auto-register catalogs at plugin-load time; running the script is a no-op that still costs a Node process boot (~400 ms).
- Precompute the jq-generated openclaw.json at image build time for the common default agent shape; fall back to runtime synthesis only when env vars request it.
- Inline `jq` passes into a single Node script to avoid forking `jq` N times.

**Reward.** ~500 ms shaved off the entrypoint cost. Brings pre-LLM overhead from 7.0 s → 6.5 s in the fast-path case.

**Cost.** A day. Zero risk.

**Verdict.** Ship as a housekeeping item, not the headline fix. Not enough on its own.

### Option B — Node.js V8 startup snapshot

Build openclaw's require graph into a V8 snapshot at image build time via `node --build-snapshot`; launch the gateway with `--snapshot-blob`. Bypasses module load + parse on cold boot.

**Reward.** Community reports 50-150 ms savings for small apps, 500 ms-1 s for deep import graphs. openclaw loads ~53 bundled skills + provider catalogs at boot; the upper bound is plausible. Have to measure.

**Cost.** 2-3 days. Snapshot requires disciplined import ordering; native addons (better-sqlite3) must be excluded. Fragile across openclaw upstream bumps.

**Verdict.** Probably 1 s of the 6.5 s. Not enough on its own.

### Option C — per-agent container pool (pool sharing)

Today's `SessionContainerPool` spawns one container per session. **openclaw already routes per-session via the `x-openclaw-session-key` header** — one openclaw process can serve many sessions concurrently, each with its own JSONL under `$OPENCLAW_STATE_DIR/agents/main/sessions/<key>.jsonl`. We already use canonical `agent:main:<sid>` session keys for exactly this reason.

Shift the pool granularity: one container per **agent**, not per session. A session's first event reuses the agent's live container (if any) at claim time instead of waiting for a fresh spawn.

**Reward.** Eliminates `ready_wait_ms` from the critical path for every turn after the first agent-level spawn. Typical workstation: first turn of the day pays the 7 s; every subsequent turn — across all sessions of that agent, for as long as the container lives — is ~50 ms.

**Cost.** 3-5 days, well-defined. Changes: `SessionContainerPool` data structure (keyed by `agentId` instead of `sessionId`); `isBusy` predicate needs to return "any session actively running in this container," not "this specific session"; the JSONL path routing is already correct.

**Risks.**
- **Concurrency.** openclaw's chat.completions endpoint must tolerate overlapping requests bearing different session keys. Upstream claims this works; we verify with a concurrency test before shipping.
- **Resource blast radius.** A container crash takes down every session on that agent. Today's blast radius is one session. We add an eviction + respawn path and an orchestrator-side queue drain on respawn, matching the existing restart-adoption logic.
- **Per-turn model/thinking patch.** Currently idempotent per-session; stays idempotent under shared containers as long as each patch carries the canonical session key, which it already does (`agent:main:<sid>`).

**Verdict.** The single biggest win on the current architecture. CMA-scale TTFT without rewriting openclaw or swapping runtime backends. **This is the recommended primary fix.**

### Option D — Firecracker microVM backend

Implement the `ContainerRuntime` interface (`src/runtime/container.ts`) against Firecracker. Checkpoint a fully booted openclaw gateway to a snapshot; restore per session. Published numbers for bare microVM snapshot restore: 4-28 ms + guest-agent handshake.

**Reward.** Cold spawn goes from 7 s to ~150 ms, matching E2B / ForgeVM.

**Cost.** 2+ weeks. Firecracker requires KVM (Linux hosts only; macOS Docker Desktop is out). Adds a second supported runtime backend to maintain. Snapshot invalidation on openclaw version bump or config shape change requires rebake.

**Verdict.** Right answer for a production-hardened deployment. Wrong first step. Revisit after Option C has been measured in production for 4-6 weeks.

### Option E — brain/hands split (the CMA pattern)

Per [Anthropic's engineering post](https://www.anthropic.com/engineering/managed-agents) on Claude Managed Agents v2: move the LLM call out of the sandboxed container entirely. The orchestrator becomes the "brain" (stateless inference + harness); containers are "hands" (tool execution, file access) provisioned on-demand only when the model actually calls a tool that needs isolation. Sessions that never touch the sandbox never wait for one. Reported: p50 TTFT -60%, p95 TTFT -90%.

**Reward.** Biggest conceivable. Matches how the fastest commercial managed-agent products work.

**Cost.** Multi-week refactor. openclaw's single-user design currently means model inference, tool dispatch, and JSONL writes all happen inside the container. Split requires either (a) lifting inference into the orchestrator and treating openclaw as a tool executor only, or (b) maintaining two implementations.

**Verdict.** Out of scope for this design. Revisit once Options A + C are shipped and measured; only pursue if cold spawn is still the critical latency **and** we're ready to take on a structural change to how we consume openclaw.

## Recommended path

Ship in this order, gated on measured numbers between each step:

1. **Week 1 — Option A.** Entrypoint cleanup. Expected: 7.0 s → 6.5 s pre-LLM. Serves as a control for instrumentation accuracy.
2. **Week 1-2 — Option C.** Per-agent container pooling. Expected on warm path: 6.5 s → 50-100 ms. Primary deliverable.
3. **Week 3 — Option B.** V8 snapshot for the first agent-level cold spawn. Expected: 6.5 s → 5-6 s. Marginal but cumulative with A.
4. **Deferred.** Options D and E remain on the table pending measured production latency after (1)-(3). Do not start without explicit go-ahead.

## Migration plan for Option C (the primary work)

### Data-structure changes

- `SessionContainerPool.active`: key changes from `sessionId → ActiveEntry` to `agentId → AgentPoolEntry { container, wsClient, sessionKeys: Set<string>, lastUsedAt }`.
- New: `SessionContainerPool.sessionToAgent: Map<sessionId, agentId>` so `acquireForSession` / `evictSession` can look up the right agent entry.
- The existing `warm` map already keys on agentId; semantics unchanged.

### Lifecycle changes

- `acquireForSession`: on miss, promote a warm entry into `active[agentId]` (or spawn). On hit (container already active for this agent), add `sessionId` to the entry's `sessionKeys` set and bump `lastUsedAt`.
- `reap`: an `active[agentId]` entry is reapable only when `sessionKeys.size === 0` AND `now - lastUsedAt > idleTimeoutMs`. Individual session "reaps" become a `sessionKeys.delete(sid)` call, no container stop.
- `evictSession`: removes the session key from the agent entry but leaves the container running unless it was the last.
- On container crash or `/readyz` failure: all session keys under that agent get flipped to `failed` with message `container died`, matching today's single-session crash semantics.

### Orchestrator changes

- `executeInBackground`: no code change. Already passes session key via HTTP header; already uses canonical `agent:main:<sid>` form.
- `handleBackgroundFailure`: no change — per-session state transitions are unchanged.
- `warmForAgent`: unchanged; warm pool semantics stay per-agent, which is where they already are.

### Tests to add

- `test/pool-multitenancy.test.ts` — two concurrent sessions on one agent, verify no JSONL cross-contamination and no WS event cross-delivery.
- Extend `src/runtime/container-contract.ts` with a "multi-session same container" scenario so any future backend (Firecracker, ECS) is contracted to support it.

### Risks + mitigations

| Risk | Mitigation |
|---|---|
| openclaw's chat.completions endpoint serializes per-process even with distinct session keys, effectively queuing our concurrent sessions. | Run a concurrency test against vanilla openclaw before merging. If confirmed, fall back to a small pool (2-3 containers) per agent with least-busy routing. |
| A long-running session keeps its agent's container alive indefinitely, defeating warm-pool cap. | Active entries are still bounded by the existing pool-wide memory ceiling; add a `max_concurrent_sessions_per_container` config (default 8) as a safety valve. |
| Orchestrator restart adoption (`src/runtime/docker.ts#listManaged`) assumes one session per container via the `orchestrator-session-id` label. | Change the label to `orchestrator-session-ids` (comma-separated) OR re-read the container's WS to enumerate active session keys at adoption time. The latter is cleaner. |

## Open questions

1. Can vanilla openclaw genuinely serve concurrent chat.completions calls with different session keys without queuing? **Must verify empirically before starting Option C.**
2. What's the practical `max_concurrent_sessions_per_container` before p99 TTFT degrades from queueing? Needs a load test; likely agent-specific.
3. Does `warmForAgent` need to stay 1:1 with active-pool slots, or can a single warm container be "promoted" when claimed by the first session and continue serving subsequent sessions directly?

Answers to (1) and (3) gate the Option C implementation start.
