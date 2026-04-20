# Store layer

The store layer is the **pluggable persistence boundary** for the orchestrator. Every durable entity (Agent, Environment, Session, Vault, audit record, session→container mapping, queued events, per-process secrets) goes through a typed interface defined in `types.ts`. Concrete backends implement those interfaces; `buildStore()` in `index.ts` picks one based on `OPENCLAW_STORE`. The orchestrator never sees the backend directly — only the interface.

Same pattern as `ContainerRuntime` (Docker today; ECS / Cloud Run / Fly tomorrow) and provider-model pass-through (`collectPassthroughEnv()`). **The interface is the product; technologies are swappable.**

## What a backend must implement

Seven small interfaces, all defined in `types.ts`. Their method signatures are the contract; docstrings on each method encode invariants the caller relies on.

| Interface                | Role                                                                                                                                   | Transactional methods                                |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `AgentStore`             | Agents + their version history (immutable `agent_versions` snapshot on every `update`).                                                | `update(agentId, req)` — optimistic-lock on version  |
| `EnvironmentStore`       | Environment configs (packages + networking policy).                                                                                    | None                                                 |
| `SessionStore`           | Sessions + usage accumulation (`tokens_in`, `tokens_out`, `cost_usd`) + status transitions (`idle` / `running` / `failed`).            | `beginRun / endRun* / addUsage / failRunningSessions` — atomic status + usage update |
| `VaultStore`             | Credential bundles (static_bearer + mcp_oauth) with encryption at rest. Cascade delete credentials when vault is deleted.             | `addCredential` — insert + touch vault timestamp     |
| `AuditStore`             | Append-only mutation log with prefix filters on action and time.                                                                       | None (insert-only)                                   |
| `SessionContainerStore`  | Bookkeeping of which container currently holds which session (for pool adoption across restarts).                                      | None                                                 |
| `QueueStore`             | Per-session FIFO of events that arrived while the session was busy.                                                                    | `shift` — dequeue head atomically                    |
| `SecretStore`            | Orchestrator-private byte bag for the ParentTokenMinter HMAC seed. Narrow — add a second table if a second use case appears.           | None                                                 |

## Sync → async migration (Phase 1)

Historically every method returned `T` (sync). Correct for `better-sqlite3`, which executes queries on the calling thread. But any networked backend — Postgres, MySQL, DynamoDB, Spanner, Firestore — is necessarily async in Node. There is no production-grade sync Postgres client and there can't be one without blocking the event loop.

So **the first concrete work of Phase 1 is to change every store method signature to `Promise<T>`**. This is a mechanical change, not a behavioral one:

- `better-sqlite3` stays the default, wrapped to return resolved promises. Zero performance regression.
- Every caller inside the orchestrator is already in an `async` context (every Hono handler, every router method). Adding `await` in front of store calls is the only caller change.
- Contract tests keep working — they also get `await`.

Concrete mechanical steps:

1. `types.ts` — rewrap every method return type: `T → Promise<T>`, `T | undefined → Promise<T | undefined>`, `void → Promise<void>`. No method signatures change beyond the wrap.
2. `sqlite.ts` — mark every method `async`; the `_sync` private functions (already there) keep running better-sqlite3 synchronously, methods become `async foo() { return this._syncFoo(); }`.
3. `memory.ts` — same treatment, `async` on every method.
4. Every caller (`orchestrator/router.ts`, `orchestrator/server.ts`, `runtime/pool.ts`, `runtime/parent-token.ts`, the startup sequence in `index.ts`) — add `await` in front of store calls. TypeScript will flag missing awaits as compile errors; run `pnpm lint` and fix all of them.
5. Contract tests in `store/*.test.ts` — add `await` in every assertion that hits the store.

This is a big PR but a safe one: the types guarantee no caller is forgotten, and each change is local.

## Postgres backend (after the migration)

Once interfaces are async, the Postgres backend is a direct line-for-line translation of `sqlite.ts`, substituting SQL dialect differences:

| SQLite detail                                 | Postgres equivalent                                                                                   |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `INTEGER PRIMARY KEY AUTOINCREMENT`           | `BIGSERIAL PRIMARY KEY`                                                                              |
| `INTEGER` for booleans (0/1)                  | `BOOLEAN`                                                                                            |
| `BLOB` for raw bytes                          | `BYTEA`                                                                                              |
| `TEXT` holding JSON                           | Keep `TEXT` (mechanical), or `JSONB` (requires parsing discipline — defer for now)                   |
| `INSERT OR REPLACE`                           | `INSERT ... ON CONFLICT (pk) DO UPDATE SET ...`                                                      |
| `PRAGMA journal_mode = WAL`                   | N/A (Postgres always multi-reader)                                                                    |
| In-process atomicity (single better-sqlite3)  | Explicit `BEGIN … COMMIT` around multi-statement operations: `SessionStore.update`, `VaultStore.addCredential`, `QueueStore.shift` |
| Schema migration via additive `ALTER TABLE`   | Same pattern; idempotent `IF NOT EXISTS` wherever possible                                           |

**Driver choice**: `pg` (node-postgres). Battle-tested, ESM-compatible, maps 1:1 to our prepared-statement style. No ORM — keep raw SQL so the Postgres impl reads side-by-side with `sqlite.ts`.

**Connection**: One `pg.Pool` instance shared across all `PostgresStore` methods. Default pool size 10 (overridable via `OPENCLAW_POSTGRES_POOL_SIZE`). Timeout tuning at the pool level, not per-query.

**Isolation**: Default `READ COMMITTED`. Transactions wrap the multi-statement ops; single-statement ops run at pool-level auto-commit. If Phase 2 introduces multiple orchestrator replicas writing concurrently, revisit for `SELECT ... FOR UPDATE SKIP LOCKED` on the queue store.

## How to add a new backend

1. Create `src/store/<backend>/index.ts` exporting a class that implements the 7 interfaces (or composes 7 smaller classes that each implement one).
2. Add a dispatch case in `buildStore()` keyed on your `OPENCLAW_STORE` value.
3. Add a fixture in `src/store/*.test.ts` so the existing contract tests run against your backend. If they all pass, the backend is API-compatible. If they don't, the interface has a latent assumption that needs documenting here first.
4. Open a PR. The reviewer will look for: method-by-method parity with `sqlite.ts`, contract tests green, no new methods added beyond the interface.

## Non-goals

- **ORM (Drizzle / Prisma / TypeORM).** An ORM makes the SQLite↔Postgres parity harder to audit. The current hand-rolled SQL is short (~1000 lines total) and readable; an ORM would add a schema DSL, migration runner, and query-builder layer for no gain.
- **Schema migration framework.** The `sqlite.ts` pattern — `CREATE TABLE IF NOT EXISTS` + additive `ALTER TABLE ... IF NOT EXISTS` in a fixed order at startup — works for both backends. If we ever need non-additive migrations, revisit.
- **Cross-backend data import/export.** Operators change backends by starting a new deploy and re-seeding — session state is short-lived enough that the migration cost is low. If a customer asks for in-place migration, it's a separate tool, not a runtime concern.

## Phase 1 commit plan

Recorded here so the PR structure is predictable:

1. This README (design + migration plan).
2. `types.ts` + `sqlite.ts` + `memory.ts`: sync → async signatures. No new code, mechanical wrap.
3. Every caller: add `await` where missing. Compile-error-driven. One commit per module: router, server, pool, parent-token, index startup, tests.
4. `pg` dependency + `src/store/postgres/schema.ts` (DDL) + `src/store/postgres/index.ts` (class skeleton that throws on every unimplemented method).
5. `PostgresAgentStore` + re-run contract tests under a Postgres fixture — must pass.
6. Each other store, one commit per interface. `PostgresSessionStore` is the biggest; `PostgresQueueStore` needs the explicit transaction wrapper.
7. `buildStore()` dispatch for `OPENCLAW_STORE=postgres`; env var docs updated.
8. Deploy-script env var plumbing — optional, defaults stay `sqlite`. Operator opts in by setting `OPENCLAW_POSTGRES_URL`.
9. Portal overview chip showing the active backend. One line of JSX.

Each step keeps the single-VM SQLite path working. Any commit can be shipped to production without breaking existing deploys.
