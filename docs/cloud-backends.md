# Cloud backends — architectural decision record (ADR)

**Date:** 2026-04-15
**Status:** ⚠️ **SUPERSEDED** — see "Decision" section at the bottom of this document. The implementation plan proposed here (new `SessionFileStore` / `WorkspaceProvisioner` interfaces, Cloud Run adapter, Fargate adapter) was **rejected** in favor of a far simpler multi-provider VPS strategy that uses the existing `DockerContainerRuntime` unchanged.

This document is preserved as an **architectural decision record**. The research findings are intact as evidence behind the decision we ultimately made. **Do not use sections 5–11 as an implementation plan.** Use them to understand why we considered and rejected Cloud Run / Fargate as core backends.

**If you are trying to add a new cloud deploy target**, skip to the **Decision** section and see `scripts/deploy-hetzner.sh` as the pattern.

---

This document originally consolidated two deep research passes (Cloud Run, Fargate) into a proposed refactor plan with new interfaces and two new cloud adapters. Sections 2–4 contain the raw research. Sections 5–11 describe the rejected plan. The real decision is in §13.

---

## 1. Context

Item 10a shipped the Hetzner Cloud deploy path (`DockerContainerRuntime` + a one-VPS deploy script). Item 10b through 10e adds cloud backends in priority order: Cloud Run, Fargate, Container Apps, Fly.io / others, and Cloudflare Containers (demoted to 10f after architectural research showed it requires a proxy Worker + Durable Object pattern incompatible with our current orchestrator shape).

The Docker backend and the cloud backends differ in one architecturally load-bearing way: **shared-filesystem coupling between the orchestrator and the agent container**. The Docker backend relies on a host bind mount that both sides can see. Cloud Run and Fargate have no such thing. Session state must live in object storage (GCS or S3), the orchestrator must read it via an API rather than through the filesystem, and the runtime backend must provision storage differently per cloud.

Getting the abstraction right now — before shipping 10b and 10c — prevents two bad outcomes: adapter code that reaches into backend-specific filesystem assumptions, and incremental churn on the `PiJsonlEventReader` as each new backend lands.

---

## 2. Google Cloud Run findings

### 2.1 Primitive selection

Cloud Run exposes three resource types in April 2026: **Services**, **Jobs**, **Worker Pools** (worker pools GA'd 2026-04-10). Only Services match our contract; Jobs have no HTTP ingress, and worker pools explicitly *"do not have a load balanced endpoint/URL"* per the [Deploy worker pools docs](https://docs.cloud.google.com/run/docs/deploy-worker-pools).

There is **no first-class "one container instance per logical entity" primitive** in Cloud Run. Services route across an autoscaling pool behind a single URL. The closest approximation is a service with `max_instance_request_concurrency=1` + cookie-based session affinity, but the [session affinity docs](https://docs.cloud.google.com/run/docs/configuring/session-affinity) explicitly call it *"best-effort. If the instance is terminated for any reason … session affinity is broken."*

### 2.2 Concurrency, affinity, shutdown

- Max concurrency per instance: 1000, configurable down to 1 ([about concurrency](https://docs.cloud.google.com/run/docs/about-concurrency)).
- `concurrency=1` works but hurts scaling: the docs warn *"a concurrency of 1 is likely to negatively affect scaling performance."*
- Session affinity is a 30-day cookie, best-effort only. **Loss of affinity is not a correctness bug for us** — OpenClaw's `SessionManager` re-hydrates from `/workspace` on container boot. Affinity loss costs one JSONL reload, nothing more.
- Graceful shutdown is SIGTERM + **10 seconds** to SIGKILL ([container contract](https://docs.cloud.google.com/run/docs/container-contract)). **This is tight.** Every JSONL write must be flushed synchronously or within the 10-second window. Any buffered writer is a correctness risk.
- Container filesystem is in-memory: *"Data written to the file system doesn't persist when the instance stops."* Durable data must go to a mounted volume.

### 2.3 Volume mounts — the storage question

The `google.cloud.run.v2.Volume` proto defines exactly five volume sources: `secret`, `cloud_sql_instance`, `empty_dir` (tmpfs), `nfs` (Filestore — still pre-GA in April 2026), and `gcs` (Cloud Storage FUSE). Only `gcs` satisfies our "external reader after container death" requirement.

**Cloud Storage FUSE (gcsfuse) deep dive:**

- **Not fully POSIX-compliant** ([FUSE overview](https://docs.cloud.google.com/storage/docs/cloud-storage-fuse/overview)).
- No file locking: *"does not provide concurrency control for multiple writes (file locking) to the same file. When multiple writes try to replace a file, the last write wins."* For us this is fine — each session owns its own file, one writer per path.
- Streaming writes default to `true` in 2026 via the `write.enable-streaming-writes` config key, which means most writes flush directly to GCS instead of staging fully in memory ([config file](https://docs.cloud.google.com/storage/docs/cloud-storage-fuse/config-file)).
- **The 2 MiB append-without-full-reupload threshold** — I could not find a 2026 doc passage that retires this. Below 2 MiB, appending to a file may trigger a full-object rewrite per flush. Above 2 MiB, appends use an efficient fast-path. OpenClaw's session JSONLs start under 2 MiB and grow. **Expect higher-than-local append latency for the first several turns of a session.**
- External reads work trivially: `@google-cloud/storage` over HTTPS from any host on earth with a service account credential. This is the property that makes gcsfuse the only viable Cloud Run storage choice.

### 2.4 Networking, auth, ingress

Stable URL per service via `Service.uri` — does not change across revisions. Three ingress modes: `all`, `internal`, `internal-and-cloud-load-balancing`. For a Hetzner-hosted orchestrator, `all` + IAM-enforced `roles/run.invoker` is the pragmatic choice; `internal` requires a VPC bridge.

Auth for Hetzner → Cloud Run: the orchestrator mints a Google ID token (via Workload Identity Federation or a service account key file as a stopgap) and sends it in the `X-Serverless-Authorization: Bearer ...` header. This header is explicitly designed so apps can keep their own `Authorization` header — we'll use `Authorization` for our existing `OPENCLAW_GATEWAY_TOKEN` and `X-Serverless-Authorization` for the IAM gate ([service-to-service auth](https://docs.cloud.google.com/run/docs/authenticating/service-to-service)).

### 2.5 Pricing (April 2026, request-based billing, us-central1)

| Component | Rate |
|---|---|
| vCPU-second | $0.00002400 |
| Memory GiB-second | $0.00000250 |
| Requests | $0.40/M |
| Free tier | 180,000 vCPU-s + 360,000 GiB-s + 2M requests per month |

For our stated workload (500 MiB, 1 vCPU, 5 min active per session-hour, 10 sessions/day × 30 days = 300 sessions/mo): 90k vCPU-s + 45k GiB-s — **$0/mo, fits entirely in the free tier.** Break-even against the free tier is ~60 sessions/day.

**Pricing numbers sourced from two independent third-party mirrors (Economize + Cloudchipr) that match** — the canonical `cloud.google.com/run/pricing` page is JS-rendered and direct-scraping failed. Flag to validate against the live pricing calculator before any external commitment.

### 2.6 `@google-cloud/run` SDK

- Latest: `@google-cloud/run@3.2.0` ([npm](https://www.npmjs.com/package/@google-cloud/run)), Node 18+.
- Primary entry: `const { ServicesClient } = require('@google-cloud/run').v2`.
- All mutating methods return `LROperation<IService, IService>`. The create flow:
  ```ts
  const [operation] = await runClient.createService({ parent, service, serviceId });
  const [response] = await operation.promise();  // resolves when reconcile completes
  ```
- Non-obvious gotchas:
  - `serviceId` must match `[a-z]([-a-z0-9]{0,48}[a-z0-9])?` and be **< 50 chars**. Our Docker-backend container names are longer; the Cloud Run adapter must hash/truncate.
  - `Service.template` (type `RevisionTemplate`) is required on every create.
  - `session_affinity` is a `bool` on `RevisionTemplate`, not on the service.
  - Deletes are LROs too — plan for 10–30 s tails in teardown.
  - `ingress = INGRESS_TRAFFIC_ALL` must be set explicitly.

### 2.7 Recommended Cloud Run architecture: per-agent service with GCS session state

One Cloud Run service per orchestrator **agent template** (not per session), with `max_instance_request_concurrency=1`, `session_affinity=true`, a GCS volume mounted at `/workspace` keyed by session subpath, and `min_instance_count=1` to amortize cold starts for active agent templates.

**Why not per-session services:**
- `createService` is a Long-Running Operation; Google publishes no SLO for its latency. My best guess is 15–60 s for a fresh service, **unverified — must measure empirically before committing**.
- Service quota caps (1000 per region by default) mean per-session services risk quota exhaustion at scale.
- A template change (image bump, env rotation) invalidates every per-session service in parallel — operationally painful.

**Why per-agent-template services are correct:**
- Services are long-lived templates, not ephemeral spawn units. Matches Cloud Run's design.
- Session state is already file-based via OpenClaw's `SessionManager`. Whether two sessions share process memory on the same instance or run on different instances doesn't affect correctness — the JSONL on `/workspace` is the source of truth, and `SessionManager` rehydrates on every instance boot.
- With `concurrency=1` and session affinity, Cloud Run's routing plus the SessionManager rehydrate behavior gives us de facto per-session isolation. When affinity breaks (instance eviction), the next turn for that session loads from GCS. This is identical to the Docker-backend behavior when the idle pool reaps a container.
- Cost: one service per agent template vs one per session dramatically reduces the LRO activity and the quota footprint.

**Key gotchas to design for:**
- **10-second SIGTERM window.** Audit `PiJsonlEventReader` and OpenClaw's `SessionManager` writes for any buffering. Every append must be flush-on-write.
- **gcsfuse small-file append penalty.** The first several turns of a session (< 2 MiB file) pay a per-flush full-object rewrite cost. Live with it for MVP; revisit if p99 turn latency exceeds budget.
- **Session affinity cookie.** The orchestrator must persist the `GCP-SA-Affinity` cookie per session and attach it to subsequent requests. One cookie jar per session. Not a correctness issue if dropped, just a latency optimization.

---

## 3. AWS Fargate findings

### 3.1 Primitive selection

Fargate offers ECS tasks (standalone `RunTask` or via ECS services), EKS-on-Fargate, App Runner, and (as of late 2025) **ECS Managed Instances** — a hybrid pool of AWS-managed EC2 with per-instance billing. For our "spawn one stateful container on demand, scale to zero, billed per second" shape, **standalone `RunTask` against a Fargate cluster is the right primitive**. It has no baseline cost when idle, billed per second with a 1-minute minimum per the [Fargate pricing page](https://aws.amazon.com/fargate/pricing/).

App Runner is ruled out — it's a load-balanced service model that cannot do per-session containers. ECS Managed Instances are worth revisiting at ~50+ concurrent steady-state sessions but are wrong for a scale-to-zero MVP.

### 3.2 Task lifecycle

From the [task lifecycle docs](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-lifecycle-explanation.html), verbatim states: PROVISIONING → PENDING → ACTIVATING → RUNNING → DEACTIVATING → STOPPING → DEPROVISIONING → STOPPED.

Realistic phase budgets on Fargate April 2026:
- **PROVISIONING 5–15 s** (ENI creation, dominates the cold path)
- PENDING near zero on Fargate
- **ACTIVATING 10–20 s** (image pull + container start)
- RUNNING = the app
- DEPROVISIONING 5–10 s (ENI detach + cleanup; the task occupies vCPU quota throughout)

**Cold start total: 30–45 s for a 500 MiB Node.js image without SOCI, 10–15 s with Seekable OCI lazy image loading enabled.** Community numbers, not published AWS SLOs — must measure empirically with our actual image.

**Graceful shutdown:** `StopTask` sends SIGTERM, waits `containerDefinition.stopTimeout` (default 30 s, **max 120 s on Fargate**), then SIGKILL. Much more headroom than Cloud Run's 10 s. We can design a proper "flush session JSONL on shutdown" path without cutting corners.

### 3.3 Persistent storage options

| Option | Orchestrator can read? | Durable? | Verdict |
|---|---|---|---|
| Ephemeral `/workspace` only | No | No | Total data loss on stop |
| **EFS** (NFSv4) | Only in same VPC | Yes (multi-AZ) | Requires VPN bridge from Hetzner — ops burden |
| **EBS on Fargate** (GA Jan 2024) | No (snapshot required) | Zonal, auto-delete on standalone task stop | Cannot resume across AZs |
| **S3 app-level sync** | **Yes, from anywhere** | S3 11 9s | Production-grade choice |

**S3 is the only viable option** for a cloud backend whose orchestrator does not run in the same AWS VPC. The pattern is: OpenClaw writes JSONL to ephemeral `/workspace` locally, a sync step uploads to S3 on every flushable event and again in a SIGTERM handler, the orchestrator reads the object via `@aws-sdk/client-s3` from its own host (Hetzner, laptop, whatever), and the next task spawn for the same session downloads the object into the fresh task's ephemeral `/workspace` as an init step before OpenClaw starts.

**Failure mode to design for:** hard-kill without SIGTERM (OOM, host failure, Spot interruption). Spot gives a 2-minute warning via EventBridge + SIGTERM, which is generous. OOM and host failure don't. Mitigation: flush on every turn-boundary event, not just shutdown. Accept that the last partial turn can be lost in a hard-kill — this matches the Docker backend's behavior on a hard host power loss.

### 3.4 Networking

Fargate tasks in `awsvpc` mode each get their own ENI with a private IP. From the [Fargate task networking docs](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-task-networking.html), the task receives *"a single ENI (referred to as the task ENI) and all network traffic flows through that ENI within your VPC."*

Four reachability patterns:
1. **Public subnet + `assignPublicIp: ENABLED`** — task ENI gets a public IPv4, orchestrator hits it directly over the internet with Bearer auth + security-group restriction. Simplest, cheapest. **Recommended for v0.**
2. Private subnet + NAT Gateway + VPN — $33/mo NAT baseline + VPN ops burden.
3. ALB with dynamic target registration — ALB baseline $16/mo + LCU + 100 rules/ALB cap.
4. Cloud Map service discovery — requires an ECS service, not standalone tasks. N/A.

**Pattern 1 is correct for our v0.** The existing `OPENCLAW_GATEWAY_TOKEN` Bearer auth plus a security group scoped to the Hetzner orchestrator's egress CIDR gives two gates.

**Public IP resolution:** `RunTask` returns a task ARN but not an IP. After `waitUntilTasksRunning`, you call `DescribeTasks` to get the ENI ID from `task.attachments[type=ElasticNetworkInterface].details[name=networkInterfaceId]`, then `DescribeNetworkInterfaces` from `@aws-sdk/client-ec2` to get the `Association.PublicIp`. The ENI is not attached immediately after `RunTask` — poll `DescribeTasks` until `attachments[0].status === "ATTACHED"`.

### 3.5 Pricing (April 2026, us-east-1)

| Component | Rate |
|---|---|
| Fargate vCPU-hour | $0.04048 |
| Fargate memory GB-hour | $0.004445 |
| Ephemeral storage above 20 GB | $0.000111/GB-hour |
| Fargate Spot discount | Up to 70% off |
| S3 standard | $0.023/GB-mo + $0.005/1k PUT + $0.0004/1k GET |
| NAT Gateway | $0.045/hr + $0.045/GB processed |

**Per-session cost math** (0.5 vCPU, 1 GB, 20 min task lifetime = 10 min active + 10 min idle-cached):
- vCPU: 0.5 × $0.04048 × (20/60) = **$0.00675**
- Memory: 1 × $0.004445 × (20/60) = **$0.00148**
- Total per session: **~$0.0082**

**Monthly cost at 10 sessions/day:**
- Fargate compute: **~$2.46/mo** on-demand, **~$0.74/mo** on Fargate Spot
- S3 storage + requests: **<$0.02/mo**
- NAT Gateway: $0 (use public subnet)
- Egress: within 100 GB/mo free tier
- ECR image storage: ~$0.05/mo
- **Total: ~$2.53/mo on-demand, ~$0.81/mo on Spot**

**Cost scales linearly with session count.** 1000 sessions/day → ~$82/mo on-demand, ~$25/mo on Spot.

### 3.6 `@aws-sdk/client-ecs` SDK

Latest: `@aws-sdk/client-ecs@3.1030.0` (plus matching ec2, s3, cloudwatch-logs, iam at the same version for lockstep). Key commands:
- `RegisterTaskDefinitionCommand` — once per image/shape change
- `RunTaskCommand` — one call per session spawn, supports `clientToken` for idempotency
- `DescribeTasksCommand` — polling gate until RUNNING + ENI attached
- `StopTaskCommand` — graceful stop with SIGTERM + stopTimeout
- `ListTasksCommand` — for orphan reap, filter by `startedBy` label
- `waitUntilTasksRunning` helper waiter from `@aws-sdk/client-ecs/dist-types/waiters`

**Critical fact from the RunTask docblock:** *"The Amazon ECS API follows an eventual consistency model … Run the DescribeTasks command using an exponential backoff algorithm."* The SDK waiter encapsulates this.

### 3.7 Quotas (non-trivial)

**Default Fargate On-Demand vCPU quota per region: 6 vCPU.** At 0.5 vCPU per task that's **12 concurrent sessions**. This is the single most important operational fact for day-one setup. The [ECS quotas page](https://docs.aws.amazon.com/general/latest/gr/ecs-service.html) confirms it's adjustable via Service Quotas. Open the request on day one, target 256+ vCPU for realistic headroom.

Also adjustable: RunTask rate quota (default 20 calls/s sustained, 100 burst), and RunTask tasks-per-call (hard cap 10, not adjustable).

### 3.8 Recommended Fargate architecture: per-session task on public subnet + S3 sync

One Fargate task per session, spawned on first turn via `RunTask` with a `clientToken` = hash of session spawn id, lifecycle managed by the existing `SessionContainerPool` (10-minute idle timeout reaps via `StopTask`). Session state synced to S3 on every flushable event and on SIGTERM. Orchestrator reads the JSONL back from S3 via `@aws-sdk/client-s3` from anywhere.

**Why per-session here but per-agent-template for Cloud Run:**
- Fargate's `RunTask` is a lightweight API call; no LRO, no quota pressure from a dozen tasks. Cost scales linearly with session minutes, not with deployed template count.
- Cloud Run Services are heavy, long-lived, quota-capped. Per-session there would be wrong.
- The per-session Fargate model gives us **true per-container isolation** — no process sharing, no affinity dance.

**Key gotchas to design for:**
- ENI attachment delay — spawn code must poll `DescribeTasks` past "RUNNING" to "ENI attached" before calling `waitForReady`.
- `iam:PassRole` is the #1 silent failure for new ECS setups. Orchestrator principal must have `iam:PassRole` on both the task-execution-role and the task-role ARNs.
- Task DEPROVISIONING occupies vCPU quota until it completes. A rapid spawn/stop loop can temporarily exhaust subnet IPs. Non-issue at our scale (~10 sessions/day).

---

## 4. Convergence across both clouds

Both research passes converge on the same high-level pattern:

1. **The container writes session state to object storage during its lifetime**, either via a filesystem mount (GCS FUSE) or via application-level sync (S3 putObject). Local ephemeral storage is a working cache, never the source of truth.
2. **The orchestrator reads session state from object storage via the cloud's native SDK**, not via a shared filesystem. This decouples the orchestrator's host from the runtime's host — the orchestrator can live on Hetzner, a laptop, or anywhere with network access and IAM credentials.
3. **Container-per-session vs container-per-agent-template is a per-backend decision**. Cloud Run forces template-level (because Services are heavy) and relies on session affinity + SessionManager rehydration for de facto isolation. Fargate supports per-session cleanly because `RunTask` is a lightweight API with per-second billing and no quota pressure at our scale.
4. **Session JSONL format is unchanged.** OpenClaw's `SessionManager` is the sole writer. Whatever storage backend we use, the on-the-wire format is still Pi's JSONL. The `PiJsonlEventReader` parser logic is reused in full — only the file-access layer changes.

These shared properties are what we need to encode in the refactor.

---

## 5. Current architecture audit — Docker-specific assumptions

Reading `src/runtime/container.ts`, `src/runtime/docker.ts`, `src/runtime/pool.ts`, `src/store/pi-jsonl.ts`, and `src/orchestrator/router.ts`:

### 5.1 `ContainerRuntime` interface (`src/runtime/container.ts`)

```ts
export type Mount = { hostPath: string; containerPath: string; readOnly?: boolean };
export type SpawnOptions = { image, env, mounts: Mount[], containerPort, name?, network?, labels? };
export type Container = { id, name, baseUrl, token };
export interface ContainerRuntime {
  spawn(opts: SpawnOptions): Promise<Container>;
  stop(id: string): Promise<void>;
  waitForReady(container: Container, timeoutMs: number): Promise<void>;
}
```

**Docker-specific assumptions:**
- `Mount.hostPath` — presupposes a local host filesystem the runtime can bind-mount from. Cloud Run uses GCS volume definitions (no host path concept). Fargate uses task-definition `volumes` blocks or application-level sync.
- `SpawnOptions.network?: string` — Docker bridge network name. No analogue in Cloud Run or Fargate.
- `SpawnOptions.name?` used as an "addressable hostname in Docker networks" — only meaningful for Docker bridge networking.

**Cloud-friendly as-is:**
- `Container.baseUrl` is already an abstract HTTP URL. Works for Docker (`http://openclaw-agt-xyz.openclaw-net:18789`), Cloud Run (`https://service-uri.run.app`), and Fargate (`http://<public-ip>:18789`) uniformly.
- `Container.token` is already abstract. Every backend can pass its own per-container secret.
- The three methods (`spawn`, `stop`, `waitForReady`) match cleanly onto every backend.

### 5.2 `SessionContainerPool` (`src/runtime/pool.ts`)

No Docker-specific imports. Uses `ContainerRuntime` strictly through the interface. Already cloud-agnostic. Good.

### 5.3 `PiJsonlEventReader` (`src/store/pi-jsonl.ts`)

**Heavily filesystem-coupled:**

```ts
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export class PiJsonlEventReader {
  constructor(public readonly stateRoot: string) {}
  // ... every method uses join() + readFileSync()
}
```

Every file access is a synchronous `node:fs` call against a local path. `stateRoot` is hardcoded as a filesystem path string. The `follow()` async generator polls the local file every 250 ms.

**What must change:**
- Extract the file-access layer behind a small interface the reader can call.
- Keep the parsing logic (`mapLineToEvent`, `canonicalKey`, `resolvePiSessionId`) intact — it's cloud-agnostic.
- Decide whether `follow()`'s polling model is still the right shape for a remote backend. Polling a GCS or S3 object every 250 ms is wasteful; we may want a larger interval or a different tailing strategy.

### 5.4 `AgentRouter.executeInBackground` (`src/orchestrator/router.ts`)

The router constructs a `hostMount` directly:

```ts
const hostMount: Mount = {
  hostPath: `${this.cfg.hostStateRoot}/${agent.agentId}`,
  containerPath: "/workspace",
};
```

And pre-creates the in-process workspace directory with owner UID 999:

```ts
const inProcessWorkspace = join(this.events.stateRoot, agent.agentId);
mkdirSync(inProcessWorkspace, { recursive: true, mode: 0o755 });
chownSync(inProcessWorkspace, AGENT_CONTAINER_UID, AGENT_CONTAINER_UID);
```

**Docker-specific assumptions:**
- `hostStateRoot` is a filesystem path directly usable as a Docker bind mount source.
- `events.stateRoot` is an in-process filesystem path that maps to the same physical directory the host sees, enabling the chown to propagate.
- The router knows the exact shape of the mount spec (`hostPath` + `containerPath`), not just the intent.

**What must change:**
- The router should declare intent ("provision a session workspace for this agent") not implementation ("bind `/opt/openclaw/data/sessions/<agent>` to `/workspace`").
- The UID pre-chown fix from commit `075b7c0` is Docker-specific and belongs in the Docker backend, not the router.

### 5.5 `src/index.ts` wiring

Reads two env vars: `OPENCLAW_HOST_STATE_ROOT` (host path for Docker bind mounts) and `OPENCLAW_STATE_ROOT` (in-process path for `PiJsonlEventReader`). Constructs `DockerContainerRuntime` and `PiJsonlEventReader` directly, hardcoding the Docker backend.

**What must change:**
- Backend selection driven by an env var (`OPENCLAW_RUNTIME_BACKEND=docker|cloud-run|fargate`, default `docker`).
- Per-backend configuration read from scoped env vars (e.g., `OPENCLAW_GCP_PROJECT_ID`, `OPENCLAW_GCP_BUCKET`, `OPENCLAW_AWS_REGION`, `OPENCLAW_S3_BUCKET`).
- A thin factory that assembles the right `ContainerRuntime` + `SessionFileStore` + `WorkspaceProvisioner` based on the backend name.

---

## 6. Proposed refactor

### 6.1 Guiding principles

1. **Minimal surface area.** Two new interfaces, not five. Don't anticipate needs that aren't in front of us.
2. **Docker backend unchanged in behavior.** The refactor is pure abstraction — existing e2e tests must continue to pass unchanged, including the Hetzner live benchmark.
3. **Each backend owns its own quirks.** The Docker UID chown lives in `DockerContainerRuntime`. The gcsfuse flush semantics live in `CloudRunContainerRuntime`. The S3 sync lives in `FargateContainerRuntime`. The router doesn't know the difference.
4. **Session JSONL format is a contract.** OpenClaw's on-disk format is parsed by exactly one module (`PiJsonlEventReader`). Every backend produces the same format on reads. The abstraction is *how* bytes are fetched, not *what* they mean.

### 6.2 New interface: `SessionFileStore`

Purpose: abstract the file-access layer of `PiJsonlEventReader`. Every backend implements this with its own storage primitive.

```ts
// src/store/session-file-store.ts
export interface SessionFileStore {
  /** Read the full contents of a file, or undefined if the file does not exist. */
  readText(relativePath: string): Promise<string | undefined>;

  /** Overwrite a file's contents (creating it if needed). Used for sessions.json rewrites. */
  writeText(relativePath: string, content: string): Promise<void>;

  /** Delete a file. No-op if missing. */
  deleteFile(relativePath: string): Promise<void>;

  /**
   * Return the mtime (milliseconds since epoch) of a file, or undefined if missing.
   * Used by follow() to detect changes without re-downloading the file body.
   */
  statMtime(relativePath: string): Promise<number | undefined>;
}
```

- **Paths are always relative** (`<agentId>/agents/main/sessions/<piSessionId>.jsonl`). The store owns how to map those to absolute paths / bucket keys / object paths.
- **Async everywhere.** Remote backends cannot meet a synchronous contract. The `PiJsonlEventReader` becomes async top-to-bottom. Callers already `await` it, so propagating async is straightforward.
- **No write API for appending.** OpenClaw's `SessionManager` inside the container is the sole writer. The orchestrator only reads, and only writes for two specific cases: rewriting `sessions.json` on delete, and deleting a JSONL file on ephemeral-session cleanup.

**Three implementations:**

1. **`LocalFsSessionFileStore`** — wraps `node:fs/promises`. Used by the Docker backend. Thin; basically a path-joining helper + fs.readFile wrapper.

2. **`GcsSessionFileStore`** — wraps `@google-cloud/storage`. Used by the Cloud Run backend. Maps a relative path to a GCS object key under a configured bucket + prefix. Reads use `file.download()`; writes use `file.save()`; deletes use `file.delete()`; stat uses `file.getMetadata()`.

3. **`S3SessionFileStore`** — wraps `@aws-sdk/client-s3`. Used by the Fargate backend. Same shape as the GCS implementation but against S3. Reads use `GetObjectCommand` + stream-to-string; writes use `PutObjectCommand`; deletes use `DeleteObjectCommand`; stat uses `HeadObjectCommand`.

### 6.3 `PiJsonlEventReader` refactor

The constructor changes from a path string to a `SessionFileStore`. Every internal `readFileSync`, `unlinkSync`, `writeFileSync`, and path-joining call goes through the store. The parsing logic (`mapLineToEvent`, `extractText`, `combineModel`, `canonicalKey`) is unchanged.

```ts
// Before:
export class PiJsonlEventReader {
  constructor(public readonly stateRoot: string) {}
  listBySession(agentId, sessionId): Event[] { /* sync fs reads */ }
  // ...
}

// After:
export class PiJsonlEventReader {
  constructor(private readonly files: SessionFileStore) {}
  async listBySession(agentId: string, sessionId: string): Promise<Event[]> {
    const piSessionId = await this.resolvePiSessionId(agentId, sessionId);
    if (!piSessionId) return [];
    const raw = await this.files.readText(this.jsonlRelativePath(agentId, piSessionId));
    if (raw === undefined) return [];
    // ... existing parse loop ...
  }
  // ...
}
```

The `stateRoot` getter goes away. Every caller that used `this.events.stateRoot` (namely the router's pre-chown step) must move its logic into the runtime backend instead.

**`follow()` adaptation:** for the local backend, 250 ms polling stays. For remote backends, polling the object every 250 ms is expensive. Two options:
- **Keep polling uniform but at a larger interval** for remote backends (e.g., 1–2 s). Simpler. Higher latency for live event streaming.
- **Abstract `follow` behind a backend-specific tailing hook.** The local store uses inotify or poll; the GCS store uses object versioning + etag comparisons; the S3 store uses ListObjectsV2 mtimes. More code.

**Recommendation:** for the refactor, keep `follow` polling-based but make the poll interval configurable per store, and let the remote stores override. If live event streaming becomes a hot-path concern for cloud backends later, revisit.

### 6.4 New interface: `WorkspaceProvisioner`

Purpose: let each backend provision its session storage and return a backend-specific mount spec that the runtime knows how to consume.

```ts
// src/runtime/workspace-provisioner.ts

/** Backend-specific mount spec. Tagged union — runtime backends match on `type`. */
export type WorkspaceMountSpec =
  | { type: "bind"; hostPath: string; containerPath: string }
  | { type: "gcs"; bucket: string; subPath: string; containerPath: string; mountOptions?: string[] }
  | { type: "ephemeral-with-s3-sync"; bucket: string; keyPrefix: string; containerPath: string };

export interface WorkspaceProvisioner {
  /**
   * Ensure the session workspace exists for this agent+session and return a
   * spec the runtime can pass to the container. Idempotent — calling twice
   * with the same args returns the same spec.
   */
  provision(agentId: string, sessionId: string): Promise<WorkspaceMountSpec>;

  /**
   * Tear down the session workspace. Called on session delete and ephemeral
   * session reap. Must not throw if the workspace is already gone.
   */
  cleanup(agentId: string, sessionId: string): Promise<void>;
}
```

**Three implementations:**

1. **`LocalFsWorkspaceProvisioner`** — used by the Docker backend. Takes `hostStateRoot` + `inProcessStateRoot`. `provision()` does the `mkdirSync` + `chownSync` (the permission fix from commit `075b7c0` belongs here, not in the router) and returns `{ type: "bind", hostPath, containerPath: "/workspace" }`. `cleanup()` removes the directory.

2. **`GcsWorkspaceProvisioner`** — used by the Cloud Run backend. Takes a GCS bucket name. `provision()` ensures the bucket exists and returns `{ type: "gcs", bucket, subPath: `<agentId>/<sessionId>`, containerPath: "/workspace", mountOptions: [...] }`. `cleanup()` deletes all objects under the subpath.

3. **`S3WorkspaceProvisioner`** — used by the Fargate backend. Takes an S3 bucket name. `provision()` returns `{ type: "ephemeral-with-s3-sync", bucket, keyPrefix: `<agentId>/<sessionId>/`, containerPath: "/workspace" }`. `cleanup()` deletes all objects under the prefix.

### 6.5 `ContainerRuntime` interface changes

`Mount` goes away. `SpawnOptions.mounts: Mount[]` is replaced with `SpawnOptions.workspace: WorkspaceMountSpec`. The `network?` and `name?` fields become Docker-only concerns that live in `DockerContainerRuntime` internally — they come out of the shared interface.

```ts
// New shape:
export type SpawnOptions = {
  image: string;
  env: Record<string, string>;
  workspace: WorkspaceMountSpec;
  containerPort: number;
  labels?: Record<string, string>;
};
```

`DockerContainerRuntime.spawn` switches on `workspace.type === "bind"` (and throws on any other type — it only supports bind mounts). Same for the other backends. Each backend validates its own accepted types.

### 6.6 `AgentRouter.executeInBackground` changes

Remove the manual `hostMount` construction and the UID pre-chown. Replace with:

```ts
const workspace = await this.cfg.workspaceProvisioner.provision(agent.agentId, sessionId);
// ... then in SpawnOptions:
const spawnOptions: SpawnOptions = {
  image: this.cfg.runtimeImage,
  env,
  workspace,
  containerPort: this.cfg.gatewayPort,
  labels: { "session-id": sessionId, "agent-id": agent.agentId, "managed-by": "openclaw-managed-runtime" },
};
```

No more router-level knowledge of the filesystem. The `events.stateRoot` reference goes away entirely.

### 6.7 `src/index.ts` factory

A thin factory that reads `OPENCLAW_RUNTIME_BACKEND` and assembles the right triple: `ContainerRuntime` + `SessionFileStore` + `WorkspaceProvisioner`. Each triple is a cohesive unit — mixing and matching is not supported.

```ts
function buildRuntime(): { runtime, files, provisioner } {
  const backend = env("OPENCLAW_RUNTIME_BACKEND", "docker");
  switch (backend) {
    case "docker": return buildDockerRuntime();
    case "cloud-run": return buildCloudRunRuntime();
    case "fargate": return buildFargateRuntime();
    default: throw new Error(`Unknown backend: ${backend}`);
  }
}
```

Each build function reads its own scoped env vars (`OPENCLAW_HOST_STATE_ROOT` + `OPENCLAW_STATE_ROOT` for docker, `OPENCLAW_GCP_*` for cloud-run, `OPENCLAW_AWS_*` for fargate).

### 6.8 File-level change summary

| File | Change |
|---|---|
| `src/store/session-file-store.ts` | **NEW** — interface + `LocalFsSessionFileStore` |
| `src/store/gcs-session-file-store.ts` | **NEW** — GCS implementation (added in Item 10b) |
| `src/store/s3-session-file-store.ts` | **NEW** — S3 implementation (added in Item 10c) |
| `src/store/pi-jsonl.ts` | Constructor takes `SessionFileStore` instead of `stateRoot`; all methods become async; parsing unchanged |
| `src/runtime/workspace-provisioner.ts` | **NEW** — interface + `WorkspaceMountSpec` tagged union |
| `src/runtime/local-fs-workspace-provisioner.ts` | **NEW** — Docker-side implementation (moves UID chown here) |
| `src/runtime/gcs-workspace-provisioner.ts` | **NEW** — Cloud Run side (added in Item 10b) |
| `src/runtime/s3-workspace-provisioner.ts` | **NEW** — Fargate side (added in Item 10c) |
| `src/runtime/container.ts` | `Mount` removed; `SpawnOptions.mounts` replaced with `workspace: WorkspaceMountSpec`; `network?` + `name?` become Docker-internal |
| `src/runtime/docker.ts` | Switches on `workspace.type === "bind"`; keeps all Docker-specific behavior internal |
| `src/runtime/cloud-run.ts` | **NEW** — Item 10b |
| `src/runtime/fargate.ts` | **NEW** — Item 10c |
| `src/runtime/pool.ts` | No changes — already cloud-agnostic |
| `src/orchestrator/router.ts` | Remove `hostStateRoot` from config; remove UID pre-chown; replace mount construction with `provisioner.provision()` |
| `src/index.ts` | Backend factory; scoped env var reads per backend |
| `docker-compose.yml` | No change for Docker path; cloud backends don't use compose |
| `test/e2e.sh` | No change — tests the Docker path through the refactored interfaces |

**Total lines of change, estimated:**
- Refactor itself: ~400 LOC changed + ~250 LOC new (two interface files, local implementations)
- Cloud Run adapter + backend triple: ~500 LOC new
- Fargate adapter + backend triple: ~500 LOC new
- Total: ~1650 LOC over the three items, plus e2e and docs

### 6.9 What stays the same

- OpenClaw's on-disk JSONL format and `SessionManager` write path. Untouched.
- The HTTP API surface (`/v1/agents`, `/v1/sessions`, etc.). Untouched.
- The SQLite store (`src/store/sqlite.ts`) and everything in `src/store/memory.ts`. Untouched — these are store-for-metadata, not store-for-events, and they're already backend-agnostic.
- `SessionContainerPool`. Already interface-only.
- `GatewayWebSocketClient` and the WS control plane. The baseUrl changes per backend, but the protocol is identical.
- `ParentTokenMinter` and the delegated subagent flow. HMAC signing is cloud-agnostic.
- The existing e2e tests (`test/e2e.sh`). Every test must pass against the refactored Docker backend before we write a single line of Cloud Run code.

---

## 7. Implementation sequence

Four phases, strictly ordered. No phase starts before the prior one is green.

### Phase 1 — refactor (no new backends)

1. Introduce `SessionFileStore` interface + `LocalFsSessionFileStore`.
2. Refactor `PiJsonlEventReader` to async, taking a `SessionFileStore`.
3. Introduce `WorkspaceProvisioner` interface + `LocalFsWorkspaceProvisioner`.
4. Move the UID chown fix from `router.ts` into `LocalFsWorkspaceProvisioner`.
5. Replace `Mount` with `WorkspaceMountSpec` in `ContainerRuntime`.
6. Rewrite `DockerContainerRuntime.spawn` against `WorkspaceMountSpec`.
7. Update `router.ts` to use the provisioner instead of constructing mounts directly.
8. Wire everything through `src/index.ts` with a backend factory.
9. `pnpm build` clean, `pnpm lint` clean.
10. **`./test/e2e.sh` fully green against the refactored code, running the Docker backend end-to-end.** No regression in Hetzner benchmark numbers.
11. Commit: `refactor(runtime): abstract filesystem access behind SessionFileStore + WorkspaceProvisioner`.

This phase adds zero new capability. Its only goal is to prove the new abstractions work as drop-in replacements for the current Docker behavior. Any behavior change here is a regression and must be fixed before moving on.

### Phase 2 — Cloud Run adapter (Item 10b)

1. Add `@google-cloud/run@^3.2.0`, `@google-cloud/storage`, `google-auth-library` as deps.
2. `src/store/gcs-session-file-store.ts` — GCS implementation of `SessionFileStore`.
3. `src/runtime/gcs-workspace-provisioner.ts` — GCS implementation of `WorkspaceProvisioner`, returns `{ type: "gcs", ... }`.
4. `src/runtime/cloud-run.ts` — `CloudRunContainerRuntime` using `ServicesClient`. Implements `spawn()` as a per-agent-template `ensureServiceForAgent` that creates the service on first call (memoized) with the gcs volume mount, and a per-session URL-signing step that attaches an affinity cookie. Implements `stop()` as a no-op (services are long-lived) with optional LRO `deleteService` on template delete. `waitForReady()` polls the service's `/readyz` with ID token auth.
5. Add the `X-Serverless-Authorization` header path to the runtime HTTP client, alongside the existing `Authorization` header for `OPENCLAW_GATEWAY_TOKEN`.
6. `src/index.ts` factory: add the `cloud-run` case, read scoped env vars.
7. `docker/entrypoint.sh`: no change (the container doesn't know or care whether its `/workspace` is a bind mount or a gcsfuse mount — that's provisioned at the runtime layer).
8. Live measurement: deploy against a real GCP project, run the e2e test pointed at the Cloud Run deploy, measure cold-start, warm-turn, pool-reuse, p99 gcsfuse append latency for the first 10 turns of a session, first turn after a forced instance eviction.
9. **Verify: the 10-second SIGTERM window is never the bottleneck.** Force a revision rollout during an active session and verify the JSONL flush landed on GCS before the container was killed.
10. `docs/deploying-on-cloud-run.md` — mirror `deploying-on-hetzner.md`: prereqs, one-command deploy script, cost breakdown, teardown, manual path, security notes.
11. `scripts/deploy-cloud-run.sh` — `gcloud`-free pure-SDK deploy if we can manage it; `gcloud`-wrapped if that's simpler for v0.
12. README `Cheapest production deployment` table: add the Cloud Run row with **measured** numbers, not estimates.
13. Commits: `feat(runtime): CloudRunContainerRuntime` + `docs(item-10b): Cloud Run deploy guide` + `docs(item-10b): measured cost numbers`.

### Phase 3 — Fargate adapter (Item 10c)

1. Add `@aws-sdk/client-ecs@^3.1030.0`, `@aws-sdk/client-ec2`, `@aws-sdk/client-s3`, `@aws-sdk/client-cloudwatch-logs`, `@aws-sdk/client-iam` as deps (all at the same version).
2. `src/store/s3-session-file-store.ts` — S3 implementation of `SessionFileStore`.
3. `src/runtime/s3-workspace-provisioner.ts` — S3 implementation of `WorkspaceProvisioner`, returns `{ type: "ephemeral-with-s3-sync", ... }`.
4. `src/runtime/fargate.ts` — `FargateContainerRuntime`. `spawn()` runs the idempotent `RunTask` with a `clientToken`, `waitUntilTasksRunning`, ENI attachment polling, `DescribeNetworkInterfaces` public IP lookup, returns `{ baseUrl: "http://<publicIp>:18789", token }`. `stop()` calls `StopTaskCommand`. `waitForReady()` polls `/readyz` on the returned public IP with Bearer auth.
5. The container entrypoint needs a new step: on boot, check if an S3 session JSONL exists for this session, download it into `/workspace/<agent>/agents/main/sessions/` before OpenClaw starts. This is the "resume" path for Fargate — since the container starts with an empty `/workspace`, we must populate it from S3. **This is a change to `docker/entrypoint.sh`** — small and cleanly gated on whether the `ephemeral-with-s3-sync` env vars are present.
6. The container also needs a shutdown hook: on SIGTERM, sync `/workspace` to S3 before exiting. Either a sidecar tail-sync process that runs throughout the container's lifetime, or a single pre-exit flush in the gateway process itself. **Sidecar is simpler and more reliable;** flush-on-exit is tighter but risks partial state on hard-kill.
7. `src/index.ts` factory: add the `fargate` case.
8. Bootstrap script: create ECS cluster, task def, execution role, task role, S3 bucket, public VPC, security group scoped to the orchestrator's egress IPs, push image to ECR.
9. Service Quotas request: raise Fargate On-Demand vCPU from 6 to 256.
10. Live measurement: spawn a real Fargate task, run the e2e test, measure cold-start (with and without SOCI), warm-turn timings, S3 round-trip on resume, chaos test with `StopTask` mid-session.
11. `docs/deploying-on-fargate.md`, `scripts/deploy-fargate.sh`, README cost table update.
12. Commits: `feat(runtime): FargateContainerRuntime` + `feat(item-10c): entrypoint S3 sync` + `docs(item-10c): Fargate deploy guide` + `docs(item-10c): measured cost numbers`.

### Phase 4 — consolidation

1. Update `docs/architecture.md` to reflect the multi-backend shape. The single "DockerContainerRuntime" box becomes "ContainerRuntime (interface) with Docker / Cloud Run / Fargate adapters."
2. Update the backend cost comparison table in README with all three measured backends side-by-side.
3. One blog post / announcement draft linking the three deploy guides.
4. Retrospective: anything that turned out to be wrong about this document, edit back into the "Lessons learned" section below.

---

## 8. Unverified claims — must measure empirically

Both research briefs were explicit about which numbers are secondary-sourced or estimated. Before committing to any external headline, confirm by direct measurement on our actual image.

### Cloud Run
- **`createService` LRO latency** — Google publishes no SLO. Best guess 15–60 s for a fresh service with a cached image. Measure against our 500 MiB image in us-central1 and eu-west3.
- **Cold start for a 500 MiB Node.js container** — startup CPU boost gives a 30–40% reduction in the generic case, no absolute number for our shape. Measure.
- **gcsfuse small-file append p99** — the streaming-writes config default and the 2 MiB threshold interact in ways I could not fully document. Benchmark the first 10 turns of a real session.
- **Cloud Run pricing table numbers** — from two third-party mirrors that match. Confirm against the live pricing calculator before quoting publicly.
- **Egress pricing from Cloud Run to anthropic.com / moonshot.ai** — long-standing NA-region industry figure is $0.12/GB, not primary-sourced from cloud.google.com today. Confirm.

### Fargate
- **Cold-start numbers** — 30–45 s without SOCI, 10–15 s with. Community measurements, not AWS SLOs. Measure with our image.
- **eu-central-1 Fargate pricing** — no canonical April 2026 source found. Pull live from the AWS Fargate pricing page region dropdown before any EU-focused marketing.
- **Fargate quota auto-increase cadence** — not documented. Treat the manual Service Quotas request as the only reliable path.
- **S3 `PutObject` latency from inside a Fargate task for 100 KB JSONL** — probably sub-100 ms but benchmark it, especially for the shutdown-hook flush that runs inside the SIGTERM grace window.

### Both clouds
- **First turn after forced eviction.** Cloud Run session affinity break + Fargate task stop/respawn both trigger a fresh container that must rehydrate from object storage. Measure end-to-end latency for that turn and compare against the Docker cold-spawn baseline.
- **Cost at 10 sessions/day vs 100 sessions/day vs 1000 sessions/day.** Our recommended backend changes as volume grows — at 10 sessions/day both Cloud Run and Fargate cost approximately nothing, at 1000/day the compute bills diverge sharply and picking the wrong backend is expensive.

---

## 9. Non-goals (deliberate, not oversights)

- **Multi-region deployment.** Single-region is correct for v0 of both backends. Multi-region is a follow-up once production traffic demands it.
- **Private-ingress Cloud Run (`internal` ingress).** Requires a VPC bridge from Hetzner. `all` + IAM + `X-Serverless-Authorization` is correct for v0.
- **Fargate EFS.** Requires a VPN bridge from Hetzner to AWS. S3 sync is the correct v0 path.
- **Per-session Cloud Run services.** Wrong primitive — services are long-lived templates.
- **ECS Managed Instances.** Revisit at ~50+ concurrent sessions steady-state.
- **Fargate Spot.** Huge cost reduction (70% discount) but adds interruption handling complexity. Layer on top of the on-demand path after it's proven.
- **`follow()` backend-specific tailing.** Polling with a larger interval is good enough for v0. Revisit if live event streaming becomes a cloud-backend hot path.
- **Runtime-image ARM support for cloud backends.** Hetzner CAX11 proved ARM works on Docker; Cloud Run and Fargate still run x86 by default. Multi-arch images is a later concern.
- **Consolidating deploy scripts.** Each backend gets its own `scripts/deploy-<backend>.sh` for v0. A unified `scripts/deploy.sh` wrapper can come later.

---

## 10. Open questions for the PM

1. **Backend default in `src/index.ts`.** Docker stays the default, correct? The refactor must not accidentally flip the default to a cloud backend.
2. **Which GCP project + which AWS account** will host the live tests? We need these before Phase 2 and Phase 3 start. If there's no ready account, that's a week of calendar time for AWS/GCP signup + billing verification.
3. **Who pays for the live-test burn?** Cloud Run fits in the free tier at our test volume. Fargate will cost ~$0.01 per benchmark run. Both are immaterial but should be acknowledged.
4. **Should Cloud Run or Fargate ship first?** The refactor is shared between them, so whichever ships first pays the refactor cost. Recommendation: **Cloud Run first** because it has the free-tier safety net and the architectural story (per-agent-template service) is cleaner to explain. Fargate second as the "big AWS partnership" hook with measured spot savings.
5. **Does OpenClaw's `SessionManager` currently flush on every append, or does it buffer?** This matters for the Cloud Run 10-second SIGTERM window. If it buffers, we need an upstream contribution to flush eagerly or wrap `SessionManager` with an auto-flush proxy. **Needs an Explore pass into `/Users/stainlu/claude-project/openclaw` before Phase 2 starts.**

---

## 11. Lessons from Item 10a — things this plan already incorporates

- **Don't assume host-container UID alignment.** Docker on Linux passes UIDs literally; Docker Desktop on macOS uses virtiofs remapping. The permission fix in commit `075b7c0` is the canonical example. The Docker-side `LocalFsWorkspaceProvisioner` owns this quirk going forward; other backends have entirely different isolation primitives and don't need it.
- **Don't rely on ISP-friendly default ports.** The Hetzner deploy hit an ISP-level block on SSH to port 22 on all Hetzner IPs. The `ssh.socket` drop-in workaround is cleaner than a cloud-provider-specific port remap. Cloud Run and Fargate don't expose SSH at all — this specific problem doesn't recur there.
- **Watch heredoc backtick expansion in bash.** Commit `45d56f8` fixed `systemctl: command not found` from a cloud-init heredoc where backticks were evaluated by the invoking shell instead of embedded literally. Cloud backends have their own deploy-script shells; be careful with any heredoc.
- **Live benchmarks replace estimates.** The Item 10a README went through three edits as numbers arrived. Plan to ship Cloud Run and Fargate README updates the same way: three commits — `feat(runtime)` first, `docs(deploy-guide)` second, `docs(measured numbers)` third, each only after the live measurement that feeds it.

---

## 12. Sources

### Cloud Run
- [Cloud Run resource model](https://docs.cloud.google.com/run/docs/resource-model)
- [Cloud Run deploy worker pools](https://docs.cloud.google.com/run/docs/deploy-worker-pools)
- [Cloud Run session affinity](https://docs.cloud.google.com/run/docs/configuring/session-affinity)
- [Cloud Run about concurrency](https://docs.cloud.google.com/run/docs/about-concurrency)
- [Cloud Run container contract](https://docs.cloud.google.com/run/docs/container-contract)
- [Cloud Run service-to-service auth](https://docs.cloud.google.com/run/docs/authenticating/service-to-service)
- [Cloud Run IAM roles](https://docs.cloud.google.com/run/docs/reference/iam/roles)
- [Cloud Storage FUSE overview](https://docs.cloud.google.com/storage/docs/cloud-storage-fuse/overview)
- [Cloud Storage FUSE config](https://docs.cloud.google.com/storage/docs/cloud-storage-fuse/config-file)
- [v2.ServicesClient reference](https://docs.cloud.google.com/nodejs/docs/reference/run/latest/run/v2.servicesclient)
- [@google-cloud/run on npm](https://www.npmjs.com/package/@google-cloud/run)

### Fargate
- [Fargate pricing](https://aws.amazon.com/fargate/pricing/)
- [ECS RunTask API reference](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_RunTask.html)
- [ECS task lifecycle](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-lifecycle-explanation.html)
- [ECS service quotas](https://docs.aws.amazon.com/general/latest/gr/ecs-service.html)
- [ECS throttling](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/throttling.html)
- [ECS EBS volumes](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/ebs-volumes.html)
- [ECS EFS volumes](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/efs-volumes.html)
- [Fargate task networking](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-task-networking.html)
- [Fargate Spot GA announcement](https://aws.amazon.com/blogs/aws/aws-fargate-spot-now-generally-available/)
- [NAT Gateway pricing](https://aws.amazon.com/vpc/pricing/)
- [@aws-sdk/client-ecs on GitHub](https://github.com/aws/aws-sdk-js-v3/tree/main/clients/client-ecs)

### Project code referenced in the audit
- `src/runtime/container.ts` — `ContainerRuntime` interface
- `src/runtime/docker.ts` — reference backend
- `src/runtime/pool.ts` — `SessionContainerPool` (already cloud-agnostic)
- `src/store/pi-jsonl.ts` — `PiJsonlEventReader` (filesystem-coupled, refactor target)
- `src/orchestrator/router.ts` — `AgentRouter` (mount construction + UID chown, refactor target)
- `src/index.ts` — orchestrator wiring, refactor target for the backend factory

---

## 13. Decision (2026-04-15, evening)

**The refactor proposed in sections 5–7 was rejected. We will NOT build `SessionFileStore`, `WorkspaceProvisioner`, a Cloud Run adapter, or a Fargate adapter as core backends.** Instead, OpenClaw Managed Runtime targets **multi-provider cheap VPSes** as its cloud story, reusing the existing `DockerContainerRuntime` unchanged.

### Why the refactor was the wrong answer

The PM pushed back with one question: *"is there a similar product like Hetzner within AWS/GCP/Azure?"* The honest answer is **yes, on every cloud**. Every major cloud has a "cheap VPS with Docker" product. The research in this document got pulled toward Cloud Run and Fargate because those are the most visible "modern managed container" products — but they're **the wrong tool for our specific workload**:

- **Our workload is stateful per-session agent containers with an idle pool**, not stateless HTTP microservices behind a load balancer.
- **Our scaling story is vertical** (bigger VPS, or a small cluster of VPSes behind a load balancer when we need multi-tenant). Not auto-scale-to-zero for a single logical service.
- **Our isolation story is per-container** (one container = one session = one user workspace). Not shared-process multi-tenancy.

Cloud Run is designed for the opposite of every one of those characteristics. Fargate is closer but still forces S3 sync for session state because the orchestrator can't share a filesystem with the task. Both force architectural changes to the core runtime code. Neither buys us anything our users actually need.

**The Hetzner CAX11 proof point from Item 10a already showed the right pattern:** cheap VPS + Docker + one deploy script + the existing `DockerContainerRuntime` working unchanged. The correct cloud strategy is to replicate that pattern across every cloud, not to build a different architecture for each cloud.

### The cheap-VPS-with-Docker landscape (April 2026)

Every cloud has a Hetzner equivalent, and the existing `DockerContainerRuntime` works identically on all of them:

| Provider | Product | vCPU | RAM | SSD | Monthly (USD/EUR) |
|---|---|---|---|---|---|
| **Hetzner** (current) | Cloud CAX11 (ARM) | 2 | 4 GB | 40 GB | **€3.99** |
| **Oracle Cloud** | Always Free Tier (A1) | 4 | 24 GB | 200 GB | **$0 forever** |
| **DigitalOcean** | Basic Droplet | 1 | 1 GB | 25 GB | **$4** |
| **DigitalOcean** | Basic Droplet | 2 | 2 GB | 60 GB | **$12** |
| **Vultr** | Cloud Compute | 1 | 1 GB | 25 GB | **$6** |
| **Linode/Akamai** | Nanode 1GB | 1 | 1 GB | 25 GB | **$5** |
| **AWS** | Lightsail 1 GB | 2 | 1 GB | 40 GB | **$5** |
| **AWS** | Lightsail 2 GB | 2 | 2 GB | 60 GB | **$10** |
| **AWS** | Lightsail 4 GB | 2 | 4 GB | 80 GB | **$20** |
| **AWS** | EC2 t4g.small (ARM) | 2 | 2 GB | EBS extra | ~$12 |
| **GCP** | Compute Engine e2-micro | 0.25-2 burst | 1 GB | 30 GB | **$0-6** (free tier in us regions) |
| **GCP** | Compute Engine e2-small | 0.5-2 burst | 2 GB | — | ~$13 |
| **GCP** | Compute Engine e2-medium | 1-2 burst | 4 GB | — | ~$25 |
| **Azure** | B1s VM | 1 | 1 GB | 64 GB | ~$7 |
| **Azure** | B2s VM | 2 | 4 GB | 64 GB | ~$30 |
| **Alibaba Cloud** | ECS burstable | 1 | 1 GB | 40 GB | ~$4 |

All of these run Linux + Docker. All of them can be provisioned via a simple cloud CLI + cloud-init / user-data / startup-script pattern. **The existing `scripts/deploy-hetzner.sh` is the reference shape; every new cloud gets a ~300-line sibling script using that cloud's native CLI.**

### New Item 10 sequence

| Item | Target | Status |
|---|---|---|
| **10a** | Hetzner Cloud CAX11 / CX23 | ✅ Shipped (2026-04-15, commit `a639911`) |
| **10b** | AWS Lightsail | 🔜 Next |
| **10c** | Google Cloud Compute Engine | 🔜 Later |
| **10d** | Azure Virtual Machines | 🔜 Later |
| **10e** | DigitalOcean / Linode / Vultr / Oracle Cloud | 🔜 Later (any one or all) |
| **10f+** | Cloud Run / Fargate / Cloudflare Containers | 🔜 Partnership-driven only, not core |

Each sub-item is a ~300-line deploy script + ~200-line deploy guide + a README cost-comparison row with live-measured numbers. No orchestrator core changes. No new interfaces. No refactor.

### What the Cloud Run / Fargate research is still useful for

1. **If a specific cloud partner asks for native serverless integration** (AWS Marketplace requires Fargate, GCP Marketplace requires Cloud Run, etc.), we have a thorough record of the tradeoffs and a refactor plan we can execute. It's a **future option under the "10f+" bucket**, not the default path.
2. **As an architectural decision record.** The research proves we evaluated the "modern managed container" products honestly and chose the simpler path deliberately. That matters for design reviews and future contributors who wonder why we didn't go serverless.
3. **The gotchas and pricing tables** remain accurate sources for anyone evaluating those products for a different workload.

### What we are NOT giving up

- **"Multi-cloud support."** We support MORE clouds with VPSes than we would with Cloud Run + Fargate alone.
- **"Scale-to-zero."** One small VPS ($4-13/mo) is cheaper than the baseline cost of almost any serverless product at our traffic levels, and the user can `stop` the VPS when idle if they really need zero cost.
- **"Cheap deploys."** Every VPS option above is cheaper than the serverless per-session math for sustained use.
- **Production-grade architecture.** The VPS pattern is what countless indie hackers and small SaaS products use to run production workloads; it's not a toy.

### What we ARE deliberately giving up

- **"First managed agent runtime on Cloud Run / Fargate / Cloudflare Containers"** marketing hooks. Minor. We can still make each of those work as a future partnership integration when it matters.
- **Auto-scale without operator intervention.** If traffic exceeds a single VPS's capacity, the operator adds another VPS or upsizes. Single-tenant scope, this is fine.
- **"Native serverless" vibes.** Our target audience is "I want to run my own managed agent runtime cheaply on whatever cloud I already have." That audience wants a VPS, not a Cloud Run service.

### Action items flowing from this decision

1. ✅ Mark this document as a superseded ADR (done, see the header).
2. Update the plan file's Item 10 sub-tasks to the new VPS sequence.
3. Update README's Status/Next section to list the new sub-items.
4. Update the README's backend cost comparison table to preview the multi-VPS lineup.
5. Ship Item 10b as AWS Lightsail deploy script + guide + live benchmark.
6. Future items 10c–10e follow the same pattern.
7. Cloud Run / Fargate / Cloudflare Containers / Container Apps become Item 10f+ — partnership-driven, bottom of the priority stack.

**The research in sections 2–11 remains useful; the implementation plan in those sections does not. If you need to make a decision here, read sections 2, 3, and 13 only.**
