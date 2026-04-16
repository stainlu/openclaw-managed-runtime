import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from "prom-client";

// Prometheus metrics exposed at GET /metrics. One process-wide Registry so
// the endpoint can emit everything in one call. Default Node.js metrics
// (process_cpu_seconds_total, process_resident_memory_bytes, event loop
// lag, etc.) are collected automatically.
//
// Naming conventions follow Prometheus best practices:
//   - `_total` suffix on counters
//   - `_seconds` suffix on duration histograms
//   - snake_case labels
//   - low-cardinality label values (no user IDs, no raw URLs)

export const registry = new Registry();
registry.setDefaultLabels({ service: "openclaw-managed-agents" });
collectDefaultMetrics({ register: registry });

/** Every HTTP request the orchestrator answers. */
export const httpRequestsTotal = new Counter({
  name: "http_requests_total",
  help: "Total HTTP requests handled by the orchestrator.",
  labelNames: ["method", "route", "status"] as const,
  registers: [registry],
});

/** Per-request wall-clock duration (seconds). */
export const httpRequestDurationSeconds = new Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request wall-clock duration in seconds.",
  labelNames: ["method", "route"] as const,
  // Buckets: 5 ms up to 30 s — covers health pings through long chat.completions polls.
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [registry],
});

/** Number of live active (per-session) containers held by the pool. */
export const poolActiveContainers = new Gauge({
  name: "pool_active_containers",
  help: "Number of active per-session containers in the pool.",
  registers: [registry],
});

/** Number of pre-warmed containers waiting to be claimed. */
export const poolWarmContainers = new Gauge({
  name: "pool_warm_containers",
  help: "Number of pre-warmed (not-yet-claimed) containers in the pool.",
  registers: [registry],
});

/** One tick per acquireForSession call, labelled by which source served it. */
export const poolAcquireTotal = new Counter({
  name: "pool_acquire_total",
  help: "Total pool acquisitions, by serving source.",
  labelNames: ["source"] as const, // "active" | "warm" | "spawn"
  registers: [registry],
});

/** Time to spawn a fresh container (spawn + /readyz wait + WS handshake). */
export const poolSpawnDurationSeconds = new Histogram({
  name: "pool_spawn_duration_seconds",
  help: "Cold-spawn duration from runtime.spawn through WS handshake, in seconds.",
  // Buckets tuned for the observed range across backends: Hetzner ~80s,
  // Lightsail ~300s, GCE ~80s (projected).
  buckets: [5, 15, 30, 60, 90, 120, 180, 240, 300, 420, 600],
  registers: [registry],
});

/** Wall-clock of a single run (user.message → agent.message via /v1/chat/completions). */
export const sessionRunDurationSeconds = new Histogram({
  name: "session_run_duration_seconds",
  help: "Duration of a single agent run, from runEvent kickoff to success, in seconds.",
  // Buckets cover fast turns (0.5 s Moonshot cache-hit) through long
  // tool-using multi-turn runs at the 600 s runTimeoutMs cap.
  buckets: [0.5, 1, 2.5, 5, 10, 30, 60, 120, 240, 480, 600],
  registers: [registry],
});

/** Total background-run failures that hit handleBackgroundFailure. */
export const sessionRunFailuresTotal = new Counter({
  name: "session_run_failures_total",
  help: "Total agent runs that failed (not counting client-cancelled runs).",
  registers: [registry],
});

/** Total agent templates created via POST /v1/agents. */
export const agentsCreatedTotal = new Counter({
  name: "agents_created_total",
  help: "Total agent templates created since process start.",
  registers: [registry],
});

/** Total events posted to POST /v1/sessions/:id/events, labelled by type. */
export const sessionEventsTotal = new Counter({
  name: "session_events_total",
  help: "Total events accepted by POST /v1/sessions/:id/events.",
  labelNames: ["type"] as const, // "user.message" | "user.tool_confirmation"
  registers: [registry],
});
