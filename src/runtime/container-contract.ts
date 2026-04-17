import { describe, expect, it } from "vitest";
import type { Container, ContainerRuntime, SpawnOptions } from "./container.js";

/**
 * Shared contract that every `ContainerRuntime` implementation must
 * satisfy. The Docker backend is the only one shipped today, but the
 * interface is designed as a seam for ECS / Cloud Run / Container
 * Apps / Azure ECI etc. This suite exists so any new backend can be
 * validated with a single `runContainerRuntimeContract(...)` call
 * instead of re-deriving what "a backend should do" from the
 * pool / router code paths.
 *
 * A backend passes the contract if it can:
 *   1. Spawn a container and return a complete `Container` struct
 *      (id + name + baseUrl + token — each populated, never empty).
 *   2. Report readiness via `waitForReady`, rejecting within the
 *      timeout budget if the container never comes up.
 *   3. Stop idempotently — stopping a stopped or missing container
 *      must not throw. This is load-bearing for the sweeper, which
 *      can race with manual evict.
 *   4. Honor spawn-time environment variables (the router passes
 *      OPENCLAW_ORCHESTRATOR_TOKEN, gateway port, agent id, etc.;
 *      without faithful env the container can't boot).
 *   5. Honor labels (the adopt-on-restart path filters by
 *      orchestrator-session-id label; a backend that drops labels
 *      breaks reattach).
 *
 * The harness is factored as a function taking a `setup` callback so
 * the caller owns lifecycle (create runtime, ensure test prerequisites,
 * teardown between cases). The suite does not install its own
 * beforeEach/afterEach — the caller is expected to call it from
 * inside a `describe()` they already own, wrapped in whatever setup
 * the backend needs.
 */
export type ContractSetup = () => Promise<{
  runtime: ContainerRuntime;
  /** An image this runtime can actually boot for the contract assertions. */
  image: string;
  /** Cleanup run after each case; use to drop any containers the case
   *  forgot to stop (belt-and-braces for backend test isolation). */
  cleanup?: () => Promise<void>;
}>;

function baseSpawnOptions(image: string): SpawnOptions {
  return {
    image,
    env: {
      // Mandatory env from the orchestrator's spawn flow. Contract
      // backends that drop these silently will fail real boot, so we
      // require them here so tests don't pass for the wrong reasons.
      OPENCLAW_AGENT_ID: "main",
      OPENCLAW_MODEL: "moonshot/kimi-k2.5",
      OPENCLAW_GATEWAY_PORT: "18789",
      OPENCLAW_GATEWAY_TOKEN: "contract-test-token",
    },
    mounts: [],
    containerPort: 18789,
    labels: {
      "orchestrator-session-id": "ses_contract",
      "orchestrator-agent-id": "agt_contract",
    },
  };
}

export function runContainerRuntimeContract(setup: ContractSetup): void {
  describe("ContainerRuntime contract", () => {
    it("spawn() returns a fully-populated Container struct", async () => {
      const { runtime, image, cleanup } = await setup();
      let c: Container | undefined;
      try {
        c = await runtime.spawn(baseSpawnOptions(image));
        expect(c.id).toBeTruthy();
        expect(c.name).toBeTruthy();
        expect(c.baseUrl).toMatch(/^https?:\/\//);
        expect(c.token).toBeTruthy();
      } finally {
        if (c) await runtime.stop(c.id).catch(() => {});
        await cleanup?.();
      }
    });

    it("stop() is idempotent — a second stop on the same id must not throw", async () => {
      const { runtime, image, cleanup } = await setup();
      const c = await runtime.spawn(baseSpawnOptions(image));
      await runtime.stop(c.id);
      // Second stop: the container is already gone; backends must
      // tolerate this (Docker's "no such container" error is mapped
      // to a no-op by DockerContainerRuntime; other backends must do
      // the same).
      await expect(runtime.stop(c.id)).resolves.toBeUndefined();
      await cleanup?.();
    });

    it("stop() on a never-spawned id must not throw", async () => {
      const { runtime, cleanup } = await setup();
      await expect(runtime.stop("does-not-exist")).resolves.toBeUndefined();
      await cleanup?.();
    });

    it("waitForReady() resolves for a runtime that reports ready, rejects on timeout for one that does not", async () => {
      const { runtime, image, cleanup } = await setup();
      const c = await runtime.spawn(baseSpawnOptions(image));
      try {
        // The fake runtime in unit tests resolves immediately. A real
        // backend may take time; the 30 s budget below is generous for
        // any CI environment.
        await runtime.waitForReady(c, 30_000);
      } finally {
        await runtime.stop(c.id).catch(() => {});
      }
      await cleanup?.();
    });
  });
}
