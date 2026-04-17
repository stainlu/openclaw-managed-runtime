import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ParentTokenMinter, type MintInput } from "./parent-token.js";

function sampleInput(overrides: Partial<MintInput> = {}): MintInput {
  return {
    parentSessionId: "ses_abc123",
    parentAgentId: "agt_xyz789",
    allowlist: ["agt_worker1", "agt_worker2"],
    remainingDepth: 2,
    ...overrides,
  };
}

describe("ParentTokenMinter", () => {
  it("round-trips a minted token through verify", () => {
    const minter = new ParentTokenMinter();
    const input = sampleInput();
    const token = minter.mint(input);
    const payload = minter.verify(token);
    expect(payload).toBeDefined();
    expect(payload?.parentSessionId).toBe(input.parentSessionId);
    expect(payload?.parentAgentId).toBe(input.parentAgentId);
    expect(payload?.allowlist).toEqual(input.allowlist);
    expect(payload?.remainingDepth).toBe(input.remainingDepth);
    expect(payload?.expiresAt).toBeGreaterThan(Date.now());
  });

  it("rejects tokens minted by a different instance (different secret)", () => {
    const minter1 = new ParentTokenMinter();
    const minter2 = new ParentTokenMinter();
    const token = minter1.mint(sampleInput());
    expect(minter2.verify(token)).toBeUndefined();
  });

  // Flip the FIRST char, not the last: base64url's last character can
  // be in the "padding" position (low bits ignored on decode) for some
  // payload lengths, so changing it doesn't always change the decoded
  // bytes — which made the naïve "append A" version flaky. The first
  // char always encodes data bits, so flipping it reliably tampers the
  // decoded MAC/payload.
  function flipFirstChar(s: string): string {
    const first = s[0];
    const replacement = first === "A" ? "B" : "A";
    return `${replacement}${s.slice(1)}`;
  }

  it("rejects tokens with tampered payload", () => {
    const minter = new ParentTokenMinter();
    const token = minter.mint(sampleInput());
    const [payloadB64, macB64] = token.split(".");
    const tampered = `${flipFirstChar(payloadB64!)}.${macB64}`;
    expect(minter.verify(tampered)).toBeUndefined();
  });

  it("rejects tokens with tampered MAC", () => {
    const minter = new ParentTokenMinter();
    const token = minter.mint(sampleInput());
    const [payloadB64, macB64] = token.split(".");
    const tampered = `${payloadB64}.${flipFirstChar(macB64!)}`;
    expect(minter.verify(tampered)).toBeUndefined();
  });

  it("rejects expired tokens", () => {
    const minter = new ParentTokenMinter();
    // ttl of -1 means expiresAt is already in the past at mint time.
    const token = minter.mint({ ...sampleInput(), ttlMs: -1 });
    expect(minter.verify(token)).toBeUndefined();
  });

  it("rejects malformed tokens (missing dot)", () => {
    const minter = new ParentTokenMinter();
    expect(minter.verify("not-a-token")).toBeUndefined();
    expect(minter.verify("")).toBeUndefined();
    expect(minter.verify(".only-mac")).toBeUndefined();
    expect(minter.verify("only-payload.")).toBeUndefined();
  });

  it("rejects tokens with bogus JSON in payload", () => {
    const minter = new ParentTokenMinter();
    // Construct a payload-shaped string that's not JSON, sign it correctly.
    // verify must still reject because the parsed structure is wrong.
    // Use a minted token then replace the payload half with a valid
    // base64url of non-JSON bytes.
    const validToken = minter.mint(sampleInput());
    const [, macB64] = validToken.split(".");
    // "not-json" base64url'd:
    const nonJsonPayload = Buffer.from("not-json", "utf8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    // Different payload → MAC won't match, verify rejects on that signal first.
    expect(minter.verify(`${nonJsonPayload}.${macB64}`)).toBeUndefined();
  });

  it("accepts an empty allowlist (no delegation targets)", () => {
    const minter = new ParentTokenMinter();
    const token = minter.mint(sampleInput({ allowlist: [] }));
    const payload = minter.verify(token);
    expect(payload?.allowlist).toEqual([]);
  });

  it("accepts zero remaining depth (deepest leaf)", () => {
    const minter = new ParentTokenMinter();
    const token = minter.mint(sampleInput({ remainingDepth: 0 }));
    const payload = minter.verify(token);
    expect(payload?.remainingDepth).toBe(0);
  });

  it("accepts an injected secret and survives across instances with the same secret", () => {
    const secret = randomBytes(32);
    const minterA = new ParentTokenMinter(secret);
    const token = minterA.mint(sampleInput());
    // A brand-new minter that doesn't share the secret must reject it —
    // baseline for the next assertion.
    expect(new ParentTokenMinter().verify(token)).toBeUndefined();
    // Second minter re-constructed with the SAME secret (as happens across
    // an orchestrator restart when the secret is loaded from SecretStore)
    // accepts tokens minted by the first instance. This is the property
    // that keeps long-running subagent delegation chains safe across
    // deploys.
    const minterB = new ParentTokenMinter(secret);
    const payload = minterB.verify(token);
    expect(payload?.parentSessionId).toBe(sampleInput().parentSessionId);
  });

  it("rejects a secret shorter than 16 bytes", () => {
    expect(() => new ParentTokenMinter(Buffer.alloc(8))).toThrow(/too short/);
  });
});
