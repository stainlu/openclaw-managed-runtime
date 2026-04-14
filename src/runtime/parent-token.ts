import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// Item 12-14: parent-token signing for the in-container `call_agent` tool.
//
// The orchestrator mints a signed token at container spawn time and
// injects it into the container's env as OPENCLAW_ORCHESTRATOR_TOKEN.
// When the in-container `call_agent` CLI tool makes an HTTP call back to
// POST /v1/sessions, it attaches the token via the X-OpenClaw-Parent-Token
// header. The orchestrator verifies the signature, checks the allowlist
// and recursion depth, and mints a new token for the child container.
//
// The token is a compact `<base64url-payload>.<base64url-hmac>` string,
// signed with HMAC-SHA256 over the payload bytes using a secret generated
// at orchestrator startup. Restart regenerates the secret, invalidating
// every outstanding token — consistent with the runtime's other
// "restart drops ephemeral state" invariants (post-restart running
// sessions become failed in Item 3, queued events are lost in Item 7).
//
// What's NOT here:
//   - Persistence: by design, tokens don't survive orchestrator restart.
//   - JWT/PASETO libraries: overkill for an internal signed envelope. A
//     flat HMAC over JSON is trivial to reason about, trivial to
//     audit, and has no external crypto dependency.
//   - Asymmetric signing: there's one signer (the orchestrator) and one
//     verifier (also the orchestrator). HMAC is the right primitive.
//   - Refresh logic: tokens last longer than any reasonable container
//     lifetime (24h), and the pool re-mints on every new container spawn.

export interface ParentTokenPayload {
  /** The session id this token is scoped to. */
  parentSessionId: string;
  /** The agent template id for the parent session. */
  parentAgentId: string;
  /** Agent ids this token is permitted to spawn via POST /v1/sessions. */
  allowlist: string[];
  /**
   * How many more levels of subagent spawning this token allows. Each
   * spawn decrements this counter; the orchestrator rejects further
   * spawns when it reaches zero.
   */
  remainingDepth: number;
  /** Unix milliseconds when the token stops being valid. */
  expiresAt: number;
}

export interface MintInput {
  parentSessionId: string;
  parentAgentId: string;
  allowlist: string[];
  remainingDepth: number;
  /** Default: 24 hours from now. */
  ttlMs?: number;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

function base64urlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(str: string): Buffer {
  const padLen = (4 - (str.length % 4)) % 4;
  const padded = str.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(padLen);
  return Buffer.from(padded, "base64");
}

/**
 * Orchestrator-side token minter and verifier. One instance per
 * orchestrator process. Secret is generated in the constructor and
 * never leaves the process.
 */
export class ParentTokenMinter {
  private readonly secret: Buffer;

  constructor() {
    this.secret = randomBytes(32);
  }

  /** Produce a signed token string for injection into a container's env. */
  mint(input: MintInput): string {
    const payload: ParentTokenPayload = {
      parentSessionId: input.parentSessionId,
      parentAgentId: input.parentAgentId,
      allowlist: input.allowlist,
      remainingDepth: input.remainingDepth,
      expiresAt: Date.now() + (input.ttlMs ?? DEFAULT_TTL_MS),
    };
    const payloadJson = JSON.stringify(payload);
    const payloadB64 = base64urlEncode(Buffer.from(payloadJson, "utf8"));
    const mac = createHmac("sha256", this.secret).update(payloadB64).digest();
    const macB64 = base64urlEncode(mac);
    return `${payloadB64}.${macB64}`;
  }

  /**
   * Verify a token and return its payload, or undefined if the token is
   * invalid, tampered with, expired, or malformed. Uses constant-time
   * comparison for the HMAC check.
   */
  verify(token: string): ParentTokenPayload | undefined {
    if (typeof token !== "string") return undefined;
    const dot = token.indexOf(".");
    if (dot <= 0 || dot === token.length - 1) return undefined;
    const payloadB64 = token.slice(0, dot);
    const macB64 = token.slice(dot + 1);

    let providedMac: Buffer;
    try {
      providedMac = base64urlDecode(macB64);
    } catch {
      return undefined;
    }
    const expectedMac = createHmac("sha256", this.secret).update(payloadB64).digest();
    if (providedMac.length !== expectedMac.length) return undefined;
    if (!timingSafeEqual(providedMac, expectedMac)) return undefined;

    let payload: ParentTokenPayload;
    try {
      const payloadJson = base64urlDecode(payloadB64).toString("utf8");
      payload = JSON.parse(payloadJson) as ParentTokenPayload;
    } catch {
      return undefined;
    }

    if (
      typeof payload.parentSessionId !== "string" ||
      typeof payload.parentAgentId !== "string" ||
      !Array.isArray(payload.allowlist) ||
      typeof payload.remainingDepth !== "number" ||
      typeof payload.expiresAt !== "number"
    ) {
      return undefined;
    }

    if (Date.now() >= payload.expiresAt) return undefined;

    return payload;
  }
}
