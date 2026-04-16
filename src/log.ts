import { AsyncLocalStorage } from "node:async_hooks";
import pino, { type Logger } from "pino";

// Structured logging + per-request context propagation.
//
// Why AsyncLocalStorage: the orchestrator does a lot of fire-and-forget
// background work (router.executeInBackground, warmForAgent, warmSession,
// approval subscriptions). A per-request request_id threads through
// HTTP handler → router.runEvent → pool.acquireForSession → WS client,
// and we want every log line along the way to carry it without passing
// `ctx` through every function signature. ALS handles the async cross-
// scheduling ( `void promise.catch()`, `setInterval`, `setTimeout`)
// transparently for code that runs in the same call tree.
//
// For fire-and-forget work that crosses the `void ...` boundary AND must
// survive a later event, capture the current context and restore it
// inside the background function via `withContext`. The pool sweeper
// runs in a fresh tick (setInterval) so it builds its own context
// intentionally — we tag sweeper logs with `source: "sweeper"`.

export type LogContext = {
  requestId?: string;
  agentId?: string;
  sessionId?: string;
};

const storage = new AsyncLocalStorage<LogContext>();

const level = process.env.OPENCLAW_LOG_LEVEL ?? "info";

// Prod: raw JSON lines (one per log). Dev: pretty-printed TTY.
// Choose based on NODE_ENV — production defaults to JSON so docker-compose
// logs and log collectors (Loki, Cloud Logging, CloudWatch) parse natively.
const devPretty = process.env.NODE_ENV !== "production";

const baseLogger: Logger = pino(
  {
    level,
    // Mix the async-local context into every log line.
    mixin: () => {
      const ctx = storage.getStore();
      if (!ctx) return {};
      const out: Record<string, unknown> = {};
      if (ctx.requestId) out.request_id = ctx.requestId;
      if (ctx.agentId) out.agent_id = ctx.agentId;
      if (ctx.sessionId) out.session_id = ctx.sessionId;
      return out;
    },
    // Standard field names: ts (ms since epoch), level as string, msg.
    timestamp: pino.stdTimeFunctions.epochTime,
    formatters: {
      level(label) {
        return { level: label };
      },
    },
    base: { service: "openclaw-managed-agents" },
  },
  devPretty
    ? pino.transport({
        target: "pino-pretty",
        options: { colorize: true, translateTime: "SYS:HH:MM:ss.l" },
      })
    : pino.destination(1),
);

/** Root logger — call directly for one-off startup lines. */
export const rootLogger = baseLogger;

/**
 * Child logger tagged with a module name. Use this from every file that
 * wants to log — keeps the `module` field consistent for filtering.
 */
export function getLogger(module: string): Logger {
  return baseLogger.child({ module });
}

/**
 * Run `fn` with the given context attached to every log line it emits,
 * including through nested awaits. Used by (a) the HTTP request-id
 * middleware and (b) background task dispatchers that need to carry
 * a captured context across `void promise.catch()`.
 */
export function withContext<T>(ctx: LogContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/**
 * Capture the current context for deferred execution. Returns a function
 * that runs the supplied `fn` with the captured context re-established.
 * Useful when handing a callback to something that won't propagate ALS
 * scope (setInterval, setTimeout with delay > 0, raw Promise chain,
 * event emitters).
 */
export function withCapturedContext<Args extends unknown[], R>(
  fn: (...args: Args) => R,
): (...args: Args) => R {
  const captured = storage.getStore();
  if (!captured) return fn;
  return (...args: Args) => storage.run(captured, () => fn(...args));
}

/** Read the current context. Undefined if no request/background scope active. */
export function currentContext(): LogContext | undefined {
  return storage.getStore();
}

/**
 * Augment the current context with additional fields. No-op if no scope
 * is active. Used to add session_id / agent_id once the route handler
 * knows them. Intentionally mutates — ALS stores maintain identity.
 */
export function addContext(extra: Partial<LogContext>): void {
  const ctx = storage.getStore();
  if (!ctx) return;
  Object.assign(ctx, extra);
}
