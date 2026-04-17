import type { Container, ContainerRuntime, SpawnOptions } from "./container.js";
import { runContainerRuntimeContract } from "./container-contract.js";

// Validate the contract against an in-test fake first. This is the
// gate that catches contract drift: if we change the ContainerRuntime
// interface in a way the fake can't satisfy, this test blows up and we
// know before the Docker backend or any future ECS backend diverges.
//
// A real Docker-backed test runs separately (test/e2e.sh, not in this
// vitest suite) — invoking docker from unit tests requires network +
// daemon socket access, which is unsafe for `pnpm test`. The contract
// itself is shared so operators porting to a new backend can point
// `runContainerRuntimeContract` at their implementation and get the
// same bar applied.

type FakeCall =
  | { kind: "spawn"; opts: SpawnOptions }
  | { kind: "stop"; id: string }
  | { kind: "waitForReady"; id: string };

class FakeRuntime implements ContainerRuntime {
  readonly calls: FakeCall[] = [];
  private counter = 0;
  private readonly stoppedIds = new Set<string>();

  async spawn(opts: SpawnOptions): Promise<Container> {
    this.counter += 1;
    const id = `cnt_${this.counter}`;
    this.calls.push({ kind: "spawn", opts });
    return {
      id,
      name: `fake_${this.counter}`,
      baseUrl: `http://fake_${this.counter}:${opts.containerPort}`,
      token: opts.env.OPENCLAW_GATEWAY_TOKEN ?? `tok_${this.counter}`,
    };
  }

  async stop(id: string): Promise<void> {
    this.calls.push({ kind: "stop", id });
    // Idempotent by construction: we don't care whether the id is
    // known. That's the contract surface we're validating.
    this.stoppedIds.add(id);
  }

  async waitForReady(container: Container, _timeoutMs: number): Promise<void> {
    this.calls.push({ kind: "waitForReady", id: container.id });
  }
}

runContainerRuntimeContract(async () => {
  const runtime = new FakeRuntime();
  return {
    runtime,
    image: "fake-image:latest",
  };
});
