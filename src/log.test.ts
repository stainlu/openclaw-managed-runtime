import { describe, expect, it } from "vitest";
import {
  addContext,
  currentContext,
  withCapturedContext,
  withContext,
} from "./log.js";

describe("log context (AsyncLocalStorage)", () => {
  it("returns undefined outside any scope", () => {
    expect(currentContext()).toBeUndefined();
  });

  it("withContext makes the context visible inside the callback", () => {
    const seen = withContext({ requestId: "req_abc" }, () => currentContext());
    expect(seen?.requestId).toBe("req_abc");
  });

  it("addContext mutates the active context", () => {
    withContext({ requestId: "req_1" }, () => {
      addContext({ sessionId: "ses_abc", agentId: "agt_x" });
      const ctx = currentContext();
      expect(ctx?.requestId).toBe("req_1");
      expect(ctx?.sessionId).toBe("ses_abc");
      expect(ctx?.agentId).toBe("agt_x");
    });
  });

  it("addContext is a no-op outside a scope", () => {
    addContext({ requestId: "req_should_not_escape" });
    expect(currentContext()).toBeUndefined();
  });

  it("context does not leak across parallel scopes", async () => {
    const a = withContext({ requestId: "req_a" }, async () =>
      new Promise<string | undefined>((resolve) => {
        setImmediate(() => resolve(currentContext()?.requestId));
      }),
    );
    const b = withContext({ requestId: "req_b" }, async () =>
      new Promise<string | undefined>((resolve) => {
        setImmediate(() => resolve(currentContext()?.requestId));
      }),
    );
    const [seenA, seenB] = await Promise.all([a, b]);
    expect(seenA).toBe("req_a");
    expect(seenB).toBe("req_b");
  });

  it("withCapturedContext restores context in a later microtask", async () => {
    const captured = withContext({ requestId: "req_captured" }, () =>
      withCapturedContext(() => currentContext()?.requestId),
    );
    // After withContext returns the outer scope is gone. Calling the
    // captured closure should still see req_captured because it was
    // bound when the closure was created.
    expect(currentContext()).toBeUndefined();
    expect(captured()).toBe("req_captured");
  });

  it("withCapturedContext returns the raw fn when called outside a scope", () => {
    const wrapped = withCapturedContext(() => "ran");
    expect(wrapped()).toBe("ran");
  });

  it("nested withContext shadows the outer scope", () => {
    const outer = { requestId: "req_outer", sessionId: "ses_x" };
    const innerRequestId = withContext(outer, () =>
      withContext({ requestId: "req_inner" }, () => currentContext()?.requestId),
    );
    expect(innerRequestId).toBe("req_inner");
  });
});
