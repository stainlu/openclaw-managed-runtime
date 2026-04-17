import { describe, expect, it } from "vitest";

import { CreateEnvironmentRequestSchema, NetworkingSchema } from "./types.js";

describe("NetworkingSchema", () => {
  it("accepts the default unrestricted case", () => {
    const parsed = NetworkingSchema.parse({ type: "unrestricted" });
    expect(parsed).toEqual({ type: "unrestricted" });
  });

  it("rejects limited — the feature is deferred until the runtime topology returns", () => {
    // Historical note: the schema previously accepted {type: "limited",
    // allowedHosts: [...]} and the pool spawned a per-session egress-proxy
    // sidecar. The runtime wiring was reverted; accepting the config at the
    // schema layer while the pool silently ignores it would be fail-open
    // security, so the schema rejects it too. See
    // docs/designs/networking-limited.md for the design we'd re-implement.
    expect(() =>
      NetworkingSchema.parse({
        type: "limited",
        allowedHosts: ["api.openai.com"],
      }),
    ).toThrow();
  });

  it("rejects an unknown `type`", () => {
    expect(() =>
      NetworkingSchema.parse({ type: "paranoid" } as unknown),
    ).toThrow();
  });
});

describe("CreateEnvironmentRequestSchema", () => {
  it("defaults networking to unrestricted when omitted", () => {
    const parsed = CreateEnvironmentRequestSchema.parse({ name: "default" });
    expect(parsed.networking).toEqual({ type: "unrestricted" });
  });

  it("rejects a limited environment end-to-end", () => {
    expect(() =>
      CreateEnvironmentRequestSchema.parse({
        name: "locked-down",
        networking: {
          type: "limited",
          allowedHosts: ["api.openai.com"],
        },
      }),
    ).toThrow();
  });
});
