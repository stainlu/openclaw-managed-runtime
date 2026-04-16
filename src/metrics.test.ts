import { describe, expect, it } from "vitest";
import {
  agentsCreatedTotal,
  httpRequestsTotal,
  poolAcquireTotal,
  poolActiveContainers,
  poolSpawnDurationSeconds,
  poolWarmContainers,
  registry,
  sessionEventsTotal,
  sessionRunDurationSeconds,
  sessionRunFailuresTotal,
} from "./metrics.js";

describe("metrics registry", () => {
  it("exposes the expected metric names", async () => {
    const text = await registry.metrics();
    const names = [
      "http_requests_total",
      "http_request_duration_seconds",
      "pool_active_containers",
      "pool_warm_containers",
      "pool_acquire_total",
      "pool_spawn_duration_seconds",
      "session_run_duration_seconds",
      "session_run_failures_total",
      "agents_created_total",
      "session_events_total",
    ];
    for (const name of names) {
      expect(text).toContain(name);
    }
  });

  it("includes the default Node.js process metrics", async () => {
    const text = await registry.metrics();
    expect(text).toContain("process_cpu_seconds_total");
    expect(text).toContain("process_resident_memory_bytes");
    expect(text).toContain("nodejs_heap_size_used_bytes");
  });

  it("tags every series with service=openclaw-managed-agents", async () => {
    const text = await registry.metrics();
    expect(text).toContain('service="openclaw-managed-agents"');
  });

  it("counter increments and histograms record observations", async () => {
    agentsCreatedTotal.inc();
    httpRequestsTotal.inc({ method: "GET", route: "/test", status: "200" });
    sessionEventsTotal.inc({ type: "user.message" });
    sessionRunFailuresTotal.inc();
    poolAcquireTotal.inc({ source: "spawn" });
    poolAcquireTotal.inc({ source: "warm" });
    poolActiveContainers.set(3);
    poolWarmContainers.set(2);
    poolSpawnDurationSeconds.observe(42);
    sessionRunDurationSeconds.observe(1.5);

    const text = await registry.metrics();
    expect(text).toMatch(/agents_created_total\{[^}]*\}\s+\d+/);
    expect(text).toMatch(/http_requests_total\{[^}]*method="GET"[^}]*\}\s+\d+/);
    expect(text).toMatch(/session_events_total\{[^}]*type="user.message"[^}]*\}\s+\d+/);
    expect(text).toMatch(/pool_acquire_total\{[^}]*source="spawn"[^}]*\}\s+\d+/);
    expect(text).toMatch(/pool_active_containers\{[^}]*\}\s+3/);
    expect(text).toMatch(/pool_warm_containers\{[^}]*\}\s+2/);
    expect(text).toMatch(/pool_spawn_duration_seconds_count\{[^}]*\}\s+1/);
    expect(text).toMatch(/session_run_duration_seconds_count\{[^}]*\}\s+1/);
  });

  it("exposes the correct Prometheus content-type", () => {
    expect(registry.contentType).toContain("text/plain");
    expect(registry.contentType).toContain("version=0.0.4");
  });
});
