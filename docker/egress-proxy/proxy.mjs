// OpenClaw Managed Agents egress-proxy sidecar.
//
// Runs next to a `networking: limited` agent container and is the only
// thing that can talk to the internet. Enforces an allowlist at two
// layers: HTTP proxy on TCP 8118 (including CONNECT for HTTPS) and DNS
// filter on UDP 53. Both must be blocked for a confined container to
// have no path out; an HTTP-only proxy is not enough because a raw
// `socket.connect()` caller can bypass it.
//
// Config, via env vars (all required except UPSTREAM_DNS):
//   OPENCLAW_EGRESS_ALLOWED_HOSTS = JSON array of hostname patterns
//   OPENCLAW_EGRESS_SESSION_ID    = session id for log correlation
//   OPENCLAW_EGRESS_UPSTREAM_DNS  = upstream resolver (default 1.1.1.1)
//
// Ports:
//   TCP 8118 — HTTP(S) proxy listener
//   TCP 8119 — /healthz listener (orchestrator readiness probe)
//   UDP 53   — DNS filter
//
// Design doc: docs/designs/networking-limited.md

import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { connect as netConnect } from "node:net";
import { createSocket } from "node:dgram";
import { compileAllowlist } from "./allowlist.mjs";
import { parseFirstQuestionName, synthesizeNxdomain } from "./dns.mjs";

const HTTP_PROXY_PORT = Number(process.env.OPENCLAW_EGRESS_HTTP_PORT ?? 8118);
const HEALTHZ_PORT = Number(process.env.OPENCLAW_EGRESS_HEALTHZ_PORT ?? 8119);
const DNS_PORT = Number(process.env.OPENCLAW_EGRESS_DNS_PORT ?? 53);
const UPSTREAM_DNS = process.env.OPENCLAW_EGRESS_UPSTREAM_DNS ?? "1.1.1.1";
const SESSION_ID = process.env.OPENCLAW_EGRESS_SESSION_ID ?? "unknown";
const MAX_HEADER_BYTES = 8 * 1024;
const TUNNEL_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

function readAllowedHosts() {
  const raw = process.env.OPENCLAW_EGRESS_ALLOWED_HOSTS ?? "[]";
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("must be JSON array");
    for (const entry of parsed) {
      if (typeof entry !== "string" || entry.length === 0) {
        throw new Error(`invalid entry: ${JSON.stringify(entry)}`);
      }
    }
    return parsed;
  } catch (err) {
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "fatal",
        session_id: SESSION_ID,
        msg: `OPENCLAW_EGRESS_ALLOWED_HOSTS must be a JSON array of hostnames: ${err.message}`,
      }),
    );
    process.exit(2);
  }
}

const allowed = compileAllowlist(readAllowedHosts());

function log(decision, extra) {
  process.stdout.write(
    `${JSON.stringify({
      ts: new Date().toISOString(),
      session_id: SESSION_ID,
      decision,
      ...extra,
    })}\n`,
  );
}

// ---------------------------------------------------------------------
// HTTP/HTTPS proxy (TCP 8118)
// ---------------------------------------------------------------------

function parseHostPort(target, defaultPort) {
  // IPv6 targets are disallowed upstream by the hostname regex, so
  // we don't need bracket handling. Plain host[:port].
  const idx = target.lastIndexOf(":");
  if (idx === -1) return { host: target, port: defaultPort };
  const host = target.slice(0, idx);
  const port = Number.parseInt(target.slice(idx + 1), 10);
  if (Number.isNaN(port) || port < 1 || port > 65535) return null;
  return { host, port };
}

function handleConnect(req, clientSocket, head) {
  // CONNECT <host>:<port> HTTP/1.1 — used by every HTTPS client.
  const target = parseHostPort(req.url ?? "", 443);
  if (!target) {
    clientSocket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    return;
  }
  if (!allowed(target.host)) {
    log("deny", { protocol: "connect", host: target.host, port: target.port });
    clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    return;
  }
  log("allow", { protocol: "connect", host: target.host, port: target.port });
  const upstream = netConnect(target.port, target.host, () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head && head.length > 0) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  upstream.setTimeout(TUNNEL_IDLE_TIMEOUT_MS, () => {
    upstream.destroy();
    clientSocket.destroy();
  });
  clientSocket.setTimeout(TUNNEL_IDLE_TIMEOUT_MS, () => {
    upstream.destroy();
    clientSocket.destroy();
  });
  const closeBoth = () => {
    upstream.destroy();
    clientSocket.destroy();
  };
  upstream.on("error", closeBoth);
  clientSocket.on("error", closeBoth);
}

function handleRequest(req, res) {
  // Plain HTTP: the client sends an absolute-URI to the proxy, e.g.
  // `GET http://api.example.com/v1/foo HTTP/1.1`. Node parses that
  // into req.url (full URI when the proxy is the target). The Host
  // header carries the authority too.
  let targetHost;
  let targetPort = 80;
  let targetPath;
  try {
    const parsed = new URL(req.url);
    targetHost = parsed.hostname;
    targetPort = parsed.port ? Number(parsed.port) : 80;
    targetPath = `${parsed.pathname}${parsed.search}`;
  } catch {
    // Relative URL — pull authority from Host header.
    const hostHdr = req.headers.host;
    if (!hostHdr) {
      res.writeHead(400).end();
      return;
    }
    const hp = parseHostPort(hostHdr, 80);
    if (!hp) {
      res.writeHead(400).end();
      return;
    }
    targetHost = hp.host;
    targetPort = hp.port;
    targetPath = req.url ?? "/";
  }
  if (!allowed(targetHost)) {
    log("deny", { protocol: "http", host: targetHost, port: targetPort });
    res.writeHead(403, { "content-type": "text/plain" });
    res.end("egress-proxy: host not in allowlist\n");
    return;
  }
  log("allow", { protocol: "http", host: targetHost, port: targetPort });
  const upstreamReq = httpRequest(
    {
      host: targetHost,
      port: targetPort,
      method: req.method,
      path: targetPath,
      headers: req.headers,
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );
  upstreamReq.on("error", (err) => {
    log("error", { protocol: "http", host: targetHost, err: err.message });
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end(`egress-proxy: upstream error: ${err.message}\n`);
    } else {
      res.destroy();
    }
  });
  req.pipe(upstreamReq);
}

const proxyServer = createHttpServer({ maxHeaderSize: MAX_HEADER_BYTES });
proxyServer.on("request", handleRequest);
proxyServer.on("connect", handleConnect);
proxyServer.on("clientError", (err, socket) => {
  // Malformed request line / oversized headers — 400 and close.
  try {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  } catch {
    /* ignore */
  }
});
proxyServer.listen(HTTP_PROXY_PORT, "0.0.0.0", () => {
  log("ready", { component: "http-proxy", port: HTTP_PROXY_PORT });
});

// ---------------------------------------------------------------------
// /healthz (TCP 8119)
// ---------------------------------------------------------------------

const healthServer = createHttpServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, session_id: SESSION_ID }));
    return;
  }
  res.writeHead(404);
  res.end();
});
healthServer.listen(HEALTHZ_PORT, "0.0.0.0", () => {
  log("ready", { component: "healthz", port: HEALTHZ_PORT });
});

// ---------------------------------------------------------------------
// DNS filter (UDP 53)
// ---------------------------------------------------------------------

const dnsSocket = createSocket("udp4");
dnsSocket.on("message", (msg, rinfo) => {
  const name = parseFirstQuestionName(msg);
  if (name === undefined) {
    // Malformed query. Drop silently — no response is less actionable to
    // a scanner than FORMERR.
    return;
  }
  if (!allowed(name)) {
    log("deny", { protocol: "dns", host: name });
    const nx = synthesizeNxdomain(msg);
    if (nx.length > 0) dnsSocket.send(nx, rinfo.port, rinfo.address);
    return;
  }
  log("allow", { protocol: "dns", host: name });
  // Forward to upstream resolver and relay the response back.
  const forwarder = createSocket("udp4");
  let responded = false;
  const timer = setTimeout(() => {
    if (!responded) forwarder.close();
  }, 3000);
  forwarder.on("message", (reply) => {
    responded = true;
    clearTimeout(timer);
    dnsSocket.send(reply, rinfo.port, rinfo.address, () => forwarder.close());
  });
  forwarder.on("error", () => {
    clearTimeout(timer);
    forwarder.close();
  });
  forwarder.send(msg, 53, UPSTREAM_DNS);
});
dnsSocket.on("error", (err) => {
  log("error", { component: "dns", err: err.message });
  process.exit(1);
});
dnsSocket.bind(DNS_PORT, "0.0.0.0", () => {
  log("ready", { component: "dns", port: DNS_PORT });
});

// ---------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------

function shutdown(signal) {
  log("shutdown", { signal });
  proxyServer.close();
  healthServer.close();
  dnsSocket.close();
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
