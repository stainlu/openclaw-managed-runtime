import WebSocket from "ws";

// Client for OpenClaw's gateway WebSocket control plane. The gateway
// documents a typed framed protocol at the root URL of the gateway port —
// see the openclaw upstream repo at docs/gateway/protocol.md and the
// schema definitions in src/gateway/protocol/schema/. We talk to it as an
// "operator" role with token auth so we can call sessions.abort,
// sessions.steer, sessions.send, and sessions.patch.
//
// Item 7 introduces this class so the orchestrator can expose cancel,
// interrupt, and per-session model overrides over its own HTTP API. The
// existing /v1/chat/completions HTTP path on the gateway stays the
// happy-path for posting new messages on idle sessions; the WebSocket is
// only consulted for the control operations it uniquely exposes.

// Protocol version we negotiate with the gateway. The schema enforces a
// `[minProtocol, maxProtocol]` range; 3 is current as of openclaw
// 2026.4.x.
const PROTOCOL_VERSION = 3;

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

// The handshake req gets a fixed string id so the temporary connect-time
// listener can recognize its response unambiguously. Method calls use a
// monotonic numeric id starting at 1 — no collision possible.
const HANDSHAKE_REQUEST_ID = "connect";

type RequestFrame = {
  type: "req";
  id: string;
  method: string;
  params: Record<string, unknown>;
};

type ResponseFrame =
  | {
      type: "res";
      id: string;
      ok: true;
      payload?: unknown;
    }
  | {
      type: "res";
      id: string;
      ok: false;
      error: GatewayWsErrorPayload;
    };

type EventFrame = {
  type: "event";
  event: string;
  payload?: unknown;
  seq?: number;
};

type IncomingFrame = ResponseFrame | EventFrame;

type GatewayWsErrorPayload = {
  code: string;
  message: string;
  details?: unknown;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: NodeJS.Timeout;
};

/** Typed error so callers can switch on `.code`. */
export class GatewayWsError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "GatewayWsError";
  }
}

export type GatewayWsConfig = {
  /** http:// (or https://) URL of the gateway port. The client converts the scheme to ws://. */
  baseUrl: string;
  /** Shared-secret bearer token. Same value the orchestrator passes for HTTP /v1/chat/completions. */
  token: string;
  /** Max time to wait for the handshake to complete. Default 10 s. */
  connectTimeoutMs?: number;
  /** Max time to wait for a single request's response. Default 10 s. */
  requestTimeoutMs?: number;
  /** Optional client identifier reported in the handshake. */
  clientName?: string;
  /** Optional client version reported in the handshake. */
  clientVersion?: string;
};

export class GatewayWebSocketClient {
  private ws: WebSocket | undefined;
  private readonly pending = new Map<string, PendingRequest>();
  private nextRequestId = 1;
  private connected = false;
  private closed = false;

  constructor(private readonly cfg: GatewayWsConfig) {}

  /**
   * Open the WebSocket and run the operator handshake. Resolves once the
   * gateway returns hello-ok; rejects on any handshake failure or timeout.
   * After this resolves, the client is ready for method calls.
   */
  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.closed) {
      throw new GatewayWsError("closed", "client has been closed");
    }

    // dockerode hands the pool an http:// URL; the gateway accepts WS
    // upgrades on the same port at the root path. Rewrite the scheme so
    // callers don't have to think about it.
    const wsUrl = this.cfg.baseUrl
      .replace(/^http:\/\//, "ws://")
      .replace(/^https:\/\//, "wss://");

    const connectTimeoutMs = this.cfg.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    const ws = new WebSocket(wsUrl);
    this.ws = ws;

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const handshakeTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanupTransientListeners();
        try {
          ws.terminate();
        } catch {
          /* best-effort */
        }
        reject(
          new GatewayWsError(
            "handshake_timeout",
            `handshake did not complete within ${connectTimeoutMs}ms`,
          ),
        );
      }, connectTimeoutMs);

      const onTransientError = (err: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(handshakeTimer);
        cleanupTransientListeners();
        reject(new GatewayWsError("ws_connect_failed", err.message));
      };
      const onTransientClose = (code: number, reasonBuf: Buffer): void => {
        if (settled) return;
        settled = true;
        clearTimeout(handshakeTimer);
        cleanupTransientListeners();
        const reason = reasonBuf?.toString("utf8") ?? "";
        reject(
          new GatewayWsError(
            "ws_closed",
            `socket closed during handshake: code=${code} reason=${reason}`,
          ),
        );
      };
      const onTransientMessage = (raw: WebSocket.RawData): void => {
        let frame: IncomingFrame;
        try {
          frame = JSON.parse(raw.toString("utf8")) as IncomingFrame;
        } catch {
          return;
        }
        // Token-auth clients can ignore the connect.challenge event — the
        // nonce in its payload is only consumed by device-signing flows.
        if (frame.type === "event" && frame.event === "connect.challenge") {
          return;
        }
        if (frame.type === "res" && frame.id === HANDSHAKE_REQUEST_ID) {
          if (settled) return;
          settled = true;
          clearTimeout(handshakeTimer);
          cleanupTransientListeners();
          if (frame.ok) {
            this.connected = true;
            // Hand the socket off to the persistent message router and
            // failure handlers.
            ws.on("message", (data) => this.handleMessage(data));
            ws.on("error", (err) => this.handleSocketError(err));
            ws.on("close", () => this.handleSocketClose());
            resolve();
          } else {
            reject(
              new GatewayWsError(
                frame.error.code,
                frame.error.message,
                frame.error.details,
              ),
            );
          }
        }
      };

      const cleanupTransientListeners = (): void => {
        ws.off("error", onTransientError);
        ws.off("close", onTransientClose);
        ws.off("message", onTransientMessage);
      };

      ws.on("error", onTransientError);
      ws.on("close", onTransientClose);
      ws.on("message", onTransientMessage);

      ws.once("open", () => {
        const connectReq: RequestFrame = {
          type: "req",
          id: HANDSHAKE_REQUEST_ID,
          method: "connect",
          params: {
            minProtocol: PROTOCOL_VERSION,
            maxProtocol: PROTOCOL_VERSION,
            // client.id and client.mode are constrained to enums by the
            // gateway schema (GATEWAY_CLIENT_IDS / GATEWAY_CLIENT_MODES in
            // openclaw upstream). We identify as "openclaw-tui" / "ui"
            // because:
            //   - openclaw-tui is recognized by isOperatorUiClient(), so
            //     the gateway.controlUi.dangerouslyDisableDeviceAuth flag
            //     waives the Ed25519 device-signing handshake.
            //   - It is NOT recognized by isBrowserOperatorUiClient(), so
            //     the browser-origin allowlist check (which only applies
            //     to openclaw-control-ui) does not fire — we don't need
            //     to send an Origin header.
            //
            // Without this combination, token auth alone gets operator
            // scopes cleared and sessions.abort returns "missing scope:
            // operator.write". The connection is private to openclaw-net
            // so the relaxed device-auth path is contained.
            client: {
              id: "openclaw-tui",
              displayName: this.cfg.clientName ?? "openclaw-managed-agents",
              version: this.cfg.clientVersion ?? "0.0.0",
              platform: "node",
              mode: "ui",
            },
            role: "operator",
            // operator.write covers abort/steer/send; operator.admin is
            // required for sessions.patch. Request all three so a single
            // client instance can drive every Item 7 operation.
            scopes: ["operator.read", "operator.write", "operator.admin"],
            auth: { token: this.cfg.token },
          },
        };
        try {
          ws.send(JSON.stringify(connectReq));
        } catch (err) {
          if (settled) return;
          settled = true;
          clearTimeout(handshakeTimer);
          cleanupTransientListeners();
          reject(
            new GatewayWsError(
              "send_failed",
              err instanceof Error ? err.message : String(err),
            ),
          );
        }
      });
    });
  }

  /**
   * Abort the in-flight run for the given session. `sessionKey` is the
   * canonical `agent:main:<session_id>` form the orchestrator already
   * uses on the HTTP /v1/chat/completions session-key header.
   */
  async abort(sessionKey: string, runId?: string): Promise<unknown> {
    return this.request("sessions.abort", {
      key: sessionKey,
      ...(runId ? { runId } : {}),
    });
  }

  /** Interrupt the active run (if any) and route this message as its replacement. */
  async steer(sessionKey: string, message: string): Promise<unknown> {
    return this.request("sessions.steer", { key: sessionKey, message });
  }

  /** Send a new message without interrupting the active run. */
  async send(sessionKey: string, message: string): Promise<unknown> {
    return this.request("sessions.send", { key: sessionKey, message });
  }

  /**
   * Mutate session-scoped fields. The most common use from the runtime is
   * `{ model: "<provider>/<model-id>" }` to switch the inference model.
   * Pi's setModel is session-scoped — the change persists for this and
   * all subsequent runs on the session.
   */
  async patch(sessionKey: string, fields: Record<string, unknown>): Promise<unknown> {
    return this.request("sessions.patch", { key: sessionKey, ...fields });
  }

  /**
   * Close the underlying socket and reject every outstanding request. Safe
   * to call more than once. After close(), the client cannot be reused.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.connected = false;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new GatewayWsError("closed", "client closed"));
    }
    this.pending.clear();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* best-effort */
      }
      this.ws = undefined;
    }
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new GatewayWsError("closed", "ws client is closed"));
    }
    if (!this.connected || !this.ws) {
      return Promise.reject(
        new GatewayWsError("not_connected", "ws client is not connected"),
      );
    }
    const id = String(this.nextRequestId++);
    const requestTimeoutMs = this.cfg.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new GatewayWsError(
            "request_timeout",
            `request ${method} timed out after ${requestTimeoutMs}ms`,
          ),
        );
      }, requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });

      const frame: RequestFrame = { type: "req", id, method, params };
      try {
        this.ws!.send(JSON.stringify(frame));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(
          new GatewayWsError(
            "send_failed",
            err instanceof Error ? err.message : String(err),
          ),
        );
      }
    });
  }

  private handleMessage(raw: WebSocket.RawData): void {
    let frame: IncomingFrame;
    try {
      frame = JSON.parse(raw.toString("utf8")) as IncomingFrame;
    } catch {
      return;
    }
    if (frame.type !== "res") {
      // Event frames (chat.delta, sessions.changed, ...) — not consumed
      // by Item 7. A future item could subscribe here for SSE streaming
      // sourced from the WS event bus instead of the JSONL tail.
      return;
    }
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    this.pending.delete(frame.id);
    clearTimeout(pending.timer);
    if (frame.ok) {
      pending.resolve(frame.payload);
    } else {
      pending.reject(
        new GatewayWsError(frame.error.code, frame.error.message, frame.error.details),
      );
    }
  }

  private handleSocketError(err: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new GatewayWsError("socket_error", err.message));
    }
    this.pending.clear();
    this.connected = false;
  }

  private handleSocketClose(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new GatewayWsError("socket_closed", "ws closed unexpectedly"));
    }
    this.pending.clear();
    this.connected = false;
  }
}
