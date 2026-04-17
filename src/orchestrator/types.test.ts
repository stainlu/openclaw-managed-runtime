import { describe, expect, it } from "vitest";

import { CreateEnvironmentRequestSchema, NetworkingSchema } from "./types.js";

describe("NetworkingSchema", () => {
  it("accepts the default unrestricted case", () => {
    const parsed = NetworkingSchema.parse({ type: "unrestricted" });
    expect(parsed).toEqual({ type: "unrestricted" });
  });

  it("accepts limited with a single exact hostname", () => {
    const parsed = NetworkingSchema.parse({
      type: "limited",
      allowedHosts: ["api.openai.com"],
    });
    expect(parsed).toEqual({
      type: "limited",
      allowedHosts: ["api.openai.com"],
    });
  });

  it("accepts limited with wildcard prefixes", () => {
    const parsed = NetworkingSchema.parse({
      type: "limited",
      allowedHosts: ["*.googleapis.com", "*.s3.amazonaws.com"],
    });
    expect(parsed.type).toBe("limited");
    if (parsed.type === "limited") {
      expect(parsed.allowedHosts).toHaveLength(2);
    }
  });

  it("rejects limited with an empty allowedHosts list", () => {
    expect(() =>
      NetworkingSchema.parse({ type: "limited", allowedHosts: [] }),
    ).toThrow(/at least one entry/);
  });

  it("rejects limited with more than 256 entries", () => {
    const tooMany = Array.from({ length: 257 }, (_, i) => `host${i}.example.com`);
    expect(() =>
      NetworkingSchema.parse({ type: "limited", allowedHosts: tooMany }),
    ).toThrow(/at most 256/);
  });

  it("rejects IPv4 literals — operators must use hostnames", () => {
    expect(() =>
      NetworkingSchema.parse({
        type: "limited",
        allowedHosts: ["169.254.169.254"],
      }),
    ).toThrow(/IP literal/i);
  });

  it("rejects URL schemes", () => {
    expect(() =>
      NetworkingSchema.parse({
        type: "limited",
        allowedHosts: ["https://api.openai.com"],
      }),
    ).toThrow(/hostnames/);
  });

  it("rejects host:port syntax", () => {
    expect(() =>
      NetworkingSchema.parse({
        type: "limited",
        allowedHosts: ["api.openai.com:443"],
      }),
    ).toThrow(/hostnames/);
  });

  it("rejects paths", () => {
    expect(() =>
      NetworkingSchema.parse({
        type: "limited",
        allowedHosts: ["api.openai.com/v1"],
      }),
    ).toThrow(/hostnames/);
  });

  it("rejects CIDR notation", () => {
    expect(() =>
      NetworkingSchema.parse({
        type: "limited",
        allowedHosts: ["10.0.0.0/8"],
      }),
    ).toThrow(/hostnames/);
  });

  it("rejects entries longer than 253 characters", () => {
    const way_too_long = `${"a.".repeat(130)}example.com`;
    expect(() =>
      NetworkingSchema.parse({
        type: "limited",
        allowedHosts: [way_too_long],
      }),
    ).toThrow(/253 characters/);
  });

  it("rejects an unknown `type`", () => {
    expect(() =>
      NetworkingSchema.parse({ type: "paranoid", allowedHosts: ["x"] } as unknown),
    ).toThrow();
  });
});

describe("CreateEnvironmentRequestSchema", () => {
  it("accepts a limited environment end-to-end", () => {
    const parsed = CreateEnvironmentRequestSchema.parse({
      name: "locked-down",
      networking: {
        type: "limited",
        allowedHosts: ["api.openai.com", "*.anthropic.com"],
      },
    });
    expect(parsed.name).toBe("locked-down");
    expect(parsed.networking.type).toBe("limited");
  });

  it("defaults networking to unrestricted when omitted", () => {
    const parsed = CreateEnvironmentRequestSchema.parse({ name: "default" });
    expect(parsed.networking).toEqual({ type: "unrestricted" });
  });
});
