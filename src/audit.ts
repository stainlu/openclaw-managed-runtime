import { createHash } from "node:crypto";
import type { Context } from "hono";
import type { AuditStore } from "./store/types.js";

/**
 * Helper for writing structured audit records from HTTP handlers.
 *
 * The actor extraction policy:
 *   - Bearer token present → first 8 hex chars of sha256(token). One-way
 *     hash so the audit log never leaks the secret but tokens are still
 *     distinguishable across callers.
 *   - No bearer token but `x-forwarded-for` or peer IP present → "ip:<addr>".
 *   - Otherwise → "anonymous".
 *
 * `target` is the resource id the action affects. For creates, pass
 * the id of the newly-created resource. For updates/deletes, the
 * target id from the path. For action-against-session mutators
 * (cancel, post_event), the session id.
 */
export function writeAudit(
  store: AuditStore,
  c: Context,
  params: {
    action: string;
    target: string | null;
    outcome: string;
    metadata?: Record<string, unknown>;
  },
): void {
  const authHeader = c.req.header("authorization") ?? "";
  const bearer = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7).trim()
    : "";
  let actor: string;
  if (bearer) {
    actor = `token:${createHash("sha256").update(bearer).digest("hex").slice(0, 8)}`;
  } else {
    const xff = c.req.header("x-forwarded-for") ?? "";
    const ip = xff.split(",")[0]?.trim() || clientPeerAddress(c) || "";
    actor = ip ? `ip:${ip}` : "anonymous";
  }
  try {
    store.record({
      ts: Date.now(),
      requestId: c.res.headers.get("x-request-id") ?? null,
      actor,
      action: params.action,
      target: params.target,
      outcome: params.outcome,
      metadata: params.metadata ?? null,
    });
  } catch {
    // Audit write failures must not mask the API response. Log-level
    // observability on the write itself lives in pino (the sqlite
    // prepare/run will surface errors there when they fire); here we
    // drop to "best-effort" so a corrupted audit_events row or a WAL
    // checkpoint stall doesn't fail-close the mutating API call.
  }
}

function clientPeerAddress(c: Context): string {
  // Hono's node-server adapter puts the socket address on
  // c.env.incoming.socket.remoteAddress when available. Best-effort.
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } };
  return env?.incoming?.socket?.remoteAddress ?? "";
}
