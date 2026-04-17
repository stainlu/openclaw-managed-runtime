# openclaw-egress-proxy

The sidecar that runs next to a `networking: limited` agent container and enforces an egress allowlist at both the HTTP proxy layer (TCP 8118) and the DNS layer (UDP 53).

Design doc: [`docs/designs/networking-limited.md`](../../docs/designs/networking-limited.md).

## Ports

| Port | Proto | Purpose |
|---|---|---|
| `8118` | TCP | HTTP(S) proxy. The agent container's `HTTP_PROXY` / `HTTPS_PROXY` env vars point here. |
| `8119` | TCP | `GET /healthz` liveness probe (orchestrator uses this to decide when the sidecar is ready). |
| `53` | UDP | DNS filter. The agent container's `--dns` flag points here so raw `socket` / `getaddrinfo` code hits the allowlist too, not just HTTP clients. |

## Config (env vars)

| Env | Required | Default | Meaning |
|---|---|---|---|
| `OPENCLAW_EGRESS_ALLOWED_HOSTS` | yes | — | JSON array of hostname patterns. `"api.openai.com"` (exact) or `"*.example.com"` (wildcard prefix, any depth, doesn't match the bare apex). |
| `OPENCLAW_EGRESS_SESSION_ID` | yes | — | Session id for log correlation. Surfaced in every log line. |
| `OPENCLAW_EGRESS_UPSTREAM_DNS` | no | `1.1.1.1` | Resolver used when forwarding allowed DNS queries. |
| `OPENCLAW_EGRESS_HTTP_PORT` | no | `8118` | Override for testing. |
| `OPENCLAW_EGRESS_HEALTHZ_PORT` | no | `8119` | Override for testing. |
| `OPENCLAW_EGRESS_DNS_PORT` | no | `53` | Override for testing. |

## Enforcement boundary

**What is enforced:**
- HTTP/HTTPS requests from anything that respects the standard proxy env vars (Node `fetch`, Python `requests`, `curl`, `git`, etc.) are filtered by host. Denied hosts get `403 Forbidden`.
- DNS resolution is filtered by name. Denied hosts return `NXDOMAIN`, so even a raw-socket caller that bypasses the proxy can't resolve them.
- Used together with a `--internal` Docker network topology (see design doc), there is no path out for a confined container except through this sidecar.

**What is NOT enforced:**
- Per-URL path allowlist (e.g. "only `POST /v1/chat/completions`"). Allowlist is host-level only.
- Egress to an allowlisted host's IP range if a different hostname resolves there (shared-IP CDN footgun — not a v1 concern).
- Side-channel data leaks via timing or allowed hosts (e.g. encoding secrets into DNS queries against an allowlisted domain).

## Logging

One JSON-per-line to stdout per allow/deny decision plus proxy readiness. Example:

```json
{"ts":"2026-04-17T20:04:00.000Z","session_id":"ses_abc","decision":"allow","protocol":"connect","host":"api.openai.com","port":443}
{"ts":"2026-04-17T20:04:01.000Z","session_id":"ses_abc","decision":"deny","protocol":"dns","host":"evil.example.org"}
```

Docker's stdout capture picks these up. For a shared host, pipe to the operator's log aggregator like any other container.
