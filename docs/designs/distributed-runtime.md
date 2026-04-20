# Distributed runtime (CMA-style)

**Status:** design, not yet implemented. Supersedes the "single-VM, shard via reverse proxy" assumption in `docs/architecture.md` and the "rejected Cloud Run + Fargate" stance in `docs/cloud-backends.md` for anyone who needs horizontal scale.

**Motivation.** Anthropic's Claude Managed Agents is a pure-SaaS, Claude-locked product. OpenClaw exists to be the self-hosted, multi-provider alternative. Our architecture today matches CMA's four-primitive API shape (Agent / Environment / Session / Event) but runs the **harness + pool + durable state all on one VM**. That ceiling is ~7 concurrent agent containers on a €4/mo CAX11 and a single SQLite writer — fine for a hobbyist, hostile to any operator scaling past "me and a few friends."

This document commits us to the structurally-identical decomposition CMA shipped: **stateless harness, sandbox fleet provisioned on demand, durable state outside both** ([Scaling Managed Agents: Decoupling the Brain from the Hands](https://www.anthropic.com/engineering/managed-agents) — exactly the shape we need). "CMA at Anthropic's scale" is not the goal; "CMA's architecture, running on any cloud, with any model" is.

## The four boxes

| Role                | Today                                                         | Distributed                                                               |
| ------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------- |
| **Orchestrator**    | Single Node process on the VM, owns the pool + SQLite + HMAC. | N stateless Node processes behind a load balancer. No local state.        |
| **Container pool**  | In-process, per-orchestrator (`src/runtime/pool.ts`).          | A **pool service** tracking {session_id → worker_ip, container_id, capacity} in Postgres; worker VMs register + heartbeat. |
| **Durable state**   | SQLite WAL + local JSONL under `/var/openclaw/`.               | Postgres (agents, envs, sessions, vaults, audit, pool registry) + object storage (session JSONL, large tool-result blobs). |
| **Sandbox runtime** | Docker via `/var/run/docker.sock` on the same VM.              | Any `ContainerRuntime` backend (Docker, Fly Machines, Cloud Run, ECS, K8s) on **worker VMs** distinct from the orchestrator. |

Routing: L7 load balancer in front of N orchestrators. Per-session affinity isn't needed at the orchestrator layer — the session's container lives on a specific worker, and any orchestrator can forward to that worker by reading the pool registry. True stickiness is container-level, not HTTP-level. This matches CMA's statement that sandboxes are "cattle, not pets" — a dead container surfaces as a tool-error, the model retries.

## Phases

Each phase is independently shippable and doesn't regress single-VM deploys. A single-VM operator at the end of Phase 4 can still `docker compose up` with everything-local defaults.

### Phase 1 — Externalize durable state (Postgres + object storage)

**What:**

- New `Postgres` implementations of `AgentStore`, `EnvironmentStore`, `SessionStore`, `VaultStore`, `AuditStore`, `SessionContainerStore`. Existing `buildStore()` in `src/store/*` dispatches on `OPENCLAW_STORE=sqlite|postgres` (sqlite stays the default).
- New `S3EventReader` / `S3EventWriter` alongside `PiJsonlEventReader`. Pi writes to its local container mount as today; a background flush uploads sealed session JSONLs to object storage once the session reaches idle. Live events keep streaming from the container mount; archived events come from object storage. Orchestrators other than the spawning one can read archived events.
- `parent-token.ts` HMAC seed moves from SQLite row to a `POSTGRES`-backed row AND can be injected via `OPENCLAW_HMAC_SECRET` env var (explicit, non-generated) so N orchestrators sign compatibly without a race.

**Done when:**

- Contract tests in `src/store/*.test.ts` pass against both backends.
- A single orchestrator can restart with `OPENCLAW_STORE=postgres` and rehydrate every session.
- Two orchestrator replicas pointed at the same Postgres + object store can both answer `GET /v1/sessions` identically.

**Out of scope:** pool distribution, worker split. Phase 1 stays single-worker but makes orchestrators stateless-compatible.

### Phase 2 — Pool service + worker split

**What:**

- New process: `pool-service` (`src/pool-service/*`). Stateless HTTP server on top of the Postgres pool registry. Responsibilities:
  - `POST /pool/acquire {sessionId, agentId, env, networking}` → returns `{workerHost, containerPort, gatewayToken}`. Synchronous, blocks during cold-spawn.
  - `POST /pool/release {sessionId}` → worker reaps container.
  - `GET /pool/workers` → capacity table. Used by both sides for health + smoke tests.
- Worker process: runs the `ContainerRuntime` of choice and exposes a small HTTP control API that the pool service calls. Workers own `/var/run/docker.sock` (or equivalent cloud API client). Orchestrators **do not** own a Docker socket anymore.
- `SessionContainerPool` in the orchestrator becomes a thin HTTP client of `pool-service` instead of an in-process Docker manager.

**Done when:**

- Deploy a `{orchestrator: 1, pool-service: 1, worker: 2}` cluster on the same VM with docker-compose. `POST /v1/sessions/:id/events` on orchestrator spawns a container on either worker, correctly round-robined by pool-service, and subsequent events on the same session route to the same worker.
- Killing a worker container mid-run surfaces as `agent.tool_result {"is_error": true}` to the model, not a 500 to the client. Matches CMA's "cattle not pets" guarantee.

### Phase 3 — Secondary `ContainerRuntime` backend

**What:**

- Ship `src/runtime/fly.ts` or `src/runtime/cloud-run.ts`. Implements `spawn / stop / waitForReady` against a non-Docker control plane. Run `runContainerRuntimeContract` (already defined in `src/runtime/container-contract.ts`) in CI against both backends so the contract stays honest.
- Deploy script for the same backend: `scripts/deploy-fly.sh` or `scripts/deploy-cloud-run.sh`. Single `./script.sh` sets up orchestrator + pool-service + worker pool, points everything at managed Postgres (Neon / Supabase / Fly Postgres / Cloud SQL) + object storage (R2 / S3 / GCS).

**Done when:**

- A customer with zero Docker experience can `fly launch` (or equivalent) and end up with a multi-instance OpenClaw cluster serving the same API as the Hetzner single-VM deploy.

### Phase 4 — Credential vault proxy + self-update + `/admin`

**What (the remaining pieces that make it "managed," not just "distributed"):**

- **Vault proxy pipeline.** CMA's big security win is that sandbox containers never see raw OAuth / bearer tokens. Instead, the vault sits between the sandbox and the target API. Implement as an egress-proxy sidecar similar to `docker/egress-proxy/` but with an auth-injection layer that binds incoming sandbox requests to credentials looked up by `{vaultId, matchUrl}`.
- **Self-update.** Orchestrator + pool-service + worker all periodically check their image digest against `ghcr.io/.../latest`. On a new digest AND no running session on this instance, exec a rolling restart. Operator stops redeploying manually for portal / router bug fixes.
- **`/admin/*` endpoints.** Diagnostics, log tail, pool inspection, manual container drain, manual session migration — over HTTP, authenticated with a separate admin bearer token. Replaces SSH as the break-glass tool for 95% of incidents.

**Done when:**

- The operator runbook stops mentioning SSH entirely. If something breaks, `./deploy --destroy && ./deploy` is the correct answer, and `/admin/*` is the diagnostic surface for the 5% of cases where you want state before rebuilding.

## Non-goals

- **Kubernetes operator.** Too much operational overhead for the hobbyist / indie-hacker segment we serve. Kubernetes will be a valid `ContainerRuntime` backend, not an assumption.
- **Multi-tenant isolation at the API layer.** CMA delegates to the developer ("API-key orgs"); we continue to delegate to a reverse proxy. Revisit in v1.5 if a real customer asks.
- **Replacing the four-primitive API.** The CMA-compatible shape is our headline. Changing it would break every SDK caller.

## Rollout

Each phase is a separate feature branch merging to `main` behind a boolean env var (`OPENCLAW_STORE=postgres`, `OPENCLAW_POOL_SERVICE_URL=…`, etc.). Single-VM Hetzner deploy stays the default, always, as the end-to-end smoke test. CI runs every phase's contract tests on every PR.

Commits to this doc belong in `docs/audit/` logs once milestones land; this file captures the target, not the history.
