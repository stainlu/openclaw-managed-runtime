# Design: `networking: limited` enforcement

**Status.** Shipped. Originally landed across commits `82088c6..fc52e7a` (April 17), briefly reverted alongside unrelated working-tree cleanup, then re-landed on top of the durability/observability work. The runtime topology (per-session `--internal` confined network + egress-proxy sidecar + control-plane network) lives in `src/runtime/docker.ts` + `src/runtime/pool.ts`; the schema accepts `{type: "limited", allowedHosts: [...]}` at `src/orchestrator/types.ts`; enforcement is proven in `test/e2e-networking.sh` (9 cases, run on native Linux in CI).
**Scope.** Per-session container network egress restriction via allowlist.
**Corresponds to.** Item 3 of the April 17 production-hardening pass.

## Problem

Today's schema rejects `networking: {type: "limited", allowedHosts: [...]}` with a Zod error. README documents this honestly: *"schema-rejected until per-container iptables enforcement ships — accepting 'limited' without enforcing would be false security."*

That honesty is correct but the feature is still missing. Claude Managed Agents ships network-allowlist enforcement as a first-class capability. For OpenClaw Managed Agents to credibly claim "the open alternative to Claude Managed Agents," we need to ship it.

## Goals

1. **Real enforcement, not advisory.** An agent container configured with `networking: limited` CANNOT reach a non-allowlisted host, by any means — HTTP, raw TCP, DNS exfiltration. No "the agent respects HTTP_PROXY voluntarily" half-measures.
2. **Hostname-based allowlist.** Operators specify DNS names (`api.openai.com`, `*.googleapis.com`), not raw IPs. DNS resolution happens inside the enforcement layer, not in untrusted agent code.
3. **Composable with the rest of the runtime.** Works through our existing Environment abstraction; no orchestrator rewrite. Bounded pool / lifecycle changes.
4. **No runtime-level trust in agent-owned code.** The enforcement must hold even if the agent executes arbitrary Python, Node, Go, or shell tools.

## Non-goals

1. **CIDR / IP-range allowlists** — v1 only supports hostnames. Follow-up work once v1 is shipping.
2. **Per-path URL allowlist** — `api.openai.com/v1/chat/completions` yes, `api.openai.com/v1/admin` no. Defer.
3. **Auth-aware policy** — "this agent may only use its own API keys, not the operator's." Out of scope; use separate containers.
4. **Egress bandwidth / rate limits** — defer.
5. **Observability deep-dive** — basic sidecar access log is enough for v1; no per-session flow metrics on the main `/metrics` endpoint.

## Threat model

The agent container runs model-generated code. It WILL try to reach arbitrary hosts for prompt-injection exfiltration, SSRF into internal networks, data-theft-to-attacker-controlled-endpoint. The enforcement must hold against a motivated adversary with full shell inside the container.

Specifically:
- **In scope to prevent:** raw TCP connects, DNS requests to `evil.example.com`, HTTP requests to `169.254.169.254/latest/meta-data` (AWS IMDS), IPv6 egress to any non-allowlisted host.
- **Out of scope:** the operator's own infrastructure behind a VPN/bastion that was intentionally allowlisted. Side-channel data leaks via timing or allowed hosts (e.g. encoding secrets into DNS queries against an allowlisted domain).

## Design

### Topology

Today's single-network design (agent + orchestrator both on `openclaw-net`, which has external egress) can't support `--internal` agents without breaking orchestrator↔agent traffic. Resolution: introduce a dedicated internal control-plane network alongside the existing public one, and keep limited agents OFF the public one.

Four networks total:

| Network | Mode | Members | Purpose |
|---|---|---|---|
| `openclaw-net` (existing) | normal bridge (external egress OK) | orchestrator, **unrestricted** agent containers | Unchanged. Unrestricted agents still reach LLM APIs directly; this path is untouched. |
| `openclaw-control-plane` (new) | `--internal` (no egress) | orchestrator, **limited** agent containers | Internal-only. Carries orchestrator↔agent HTTP + WebSocket control traffic for limited sessions. No external egress possible from either end. |
| `openclaw-sess-<sid>-confined` (per-session, limited only) | `--internal` (no egress) | limited agent, egress-proxy sidecar | Private network the confined agent uses to reach its sidecar. Nothing else on this network. |
| `openclaw-sess-<sid>-egress` (per-session, limited only) | normal bridge | egress-proxy sidecar only | The sidecar's upstream path. Only the sidecar has external egress. |

Membership:
- **Orchestrator container** — on `openclaw-net` (unchanged) AND `openclaw-control-plane` (new).
- **Unrestricted agent** — on `openclaw-net` (unchanged). No change in behavior vs. today.
- **Limited agent** — on `openclaw-control-plane` + `openclaw-sess-<sid>-confined`. Both are `--internal`. No route to the internet.
- **Egress-proxy sidecar** — on `openclaw-sess-<sid>-confined` + `openclaw-sess-<sid>-egress`. Receives proxy requests on the confined side, forwards via the egress side.

The critical invariant: **for a limited agent, every network it's connected to is `--internal`**. There is no physical path from the agent to the public internet except via the sidecar's `confined`-side listener. The advisor correctly flagged that connecting a confined agent to `openclaw-net` (which has egress) would let `socket.connect()` bypass the proxy entirely — hence the new control-plane network.

Agent NET capabilities stay minimal (no `NET_ADMIN`); enforcement is at the Docker bridge level, outside the agent's reach.

### Egress proxy (sidecar)

A new per-session container built from a new image `openclaw-egress-proxy:latest`. ~300 LOC Node.js using **stdlib `node:http` + `node:tls` + `node:dgram`** — no hand-rolled HTTP parsing. The advisor correctly flagged that a parser written from scratch on untrusted input is a known footgun class (malformed CONNECT lines, oversized headers, HTTP/2 upgrade attempts, smuggling); stdlib handles all of these.

- TCP 8118 listener uses `http.createServer` + its `connect` event for HTTPS CONNECT tunneling. Plain HTTP GET/POST is served via the normal request handler.
- For CONNECT (HTTPS): the connect target is a host:port string. Validate the host against the allowlist BEFORE dialing upstream. On allow: `net.connect()` to upstream and pipe sockets. On deny: write `HTTP/1.1 403 Forbidden\r\n\r\n` and close.
- For plain HTTP: inspect `req.headers.host` (or the Host pseudo-header), check allowlist, forward via `http.request`. Stream bodies with `pipeline()`.
- UDP 53 DNS filter: parse the A/AAAA question, compare name to allowlist, forward to upstream resolver (default 1.1.1.1) if allowed, synthesize NXDOMAIN response if denied. Pure DNS wire format, ~50 LOC of parsing.
- Allowlist matching: exact hostname OR wildcard prefix (`*.googleapis.com` → `foo.googleapis.com` allowed, `googleapis.com` NOT allowed — industry convention, explicit in the docs).
- Logs one line per decision to stdout (JSON): `{ts, session_id, host, port, decision, bytes_in?, bytes_out?}`. Docker logs surfaces it.
- Exposes `/healthz` on TCP 8119 for the orchestrator to poll.
- Hardening: reject headers > 8 KiB, reject CONNECT lines > 256 bytes, refuse HTTP/2 upgrades (we only proxy HTTP/1.1), timeout idle tunnels at 10 min.

Alternative considered: `tinyproxy` (C, existing). Rejected because it doesn't filter DNS (a confined container could exfiltrate via raw UDP 53), wildcard host matching is awkward, and we already have Node.js in our stack.

### Schema

Current:
```ts
NetworkingSchema = z.object({ type: z.literal("unrestricted") })
```

New:
```ts
NetworkingSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("unrestricted") }),
  z.object({
    type: z.literal("limited"),
    allowedHosts: z.array(z.string().min(1)).min(1),
  }),
])
```

Validation rules on `allowedHosts`:
- Non-empty.
- Each entry matches `/^[a-zA-Z0-9*.-]+$/` — hostnames + wildcard prefix (`*.example.com`). Reject IPs, CIDRs, ports, schemes; error message points at the doc.
- Max 256 entries per environment (bound the regex / lookup cost inside the sidecar).

### Pool + spawn flow

For each session whose environment has `networking.type === "limited"`:

1. `acquireForSession` gets the environment config from the router (environment is passed through in SpawnOptions).
2. Before spawning the agent:
   a. Create the two per-session networks (`--internal` + egress) via dockerode.
   b. Spawn the egress-proxy sidecar with the rendered allowlist, attach to both networks.
   c. Poll sidecar `/healthz` (readyTimeoutMs window).
3. Spawn the agent container with `--network openclaw-sess-<sid>-confined`. Set:
   - `HTTP_PROXY=http://openclaw-sess-<sid>-proxy:8118`
   - `HTTPS_PROXY=http://openclaw-sess-<sid>-proxy:8118`
   - `NO_PROXY=openclaw-orchestrator,localhost,127.0.0.1` (control plane + loopback bypass)
   - `--dns <sidecar-ip>` (resolves in-container via the sidecar)
4. Connect the agent container to `openclaw-net` for orchestrator control plane access.
5. Pool tracks both containers as one `ActiveContainer`. Evict tears down both.

For `networking.type === "unrestricted"` (the default and the only current behavior): unchanged — single container on `openclaw-net`.

### Pool state changes

Current `ActiveContainer`:
```ts
{ sessionId, container, wsClient, spawnedAt, lastUsedAt }
```

New:
```ts
{ sessionId, container, sidecarContainer?, wsClient, spawnedAt, lastUsedAt, networks?: string[] }
```

`sidecarContainer` and `networks` are populated only for limited sessions. Evict:
1. Stop agent container
2. Stop sidecar container
3. Remove both per-session networks

### Testing

**Unit:** proxy host-matching logic (exact + wildcard + IP rejection), allowlist validation, pool sidecar spawn path (with FakeRuntime).

**E2E:** a new `test/e2e-networking.sh` that runs against a real Docker daemon **on Linux** (macOS Docker Desktop's bridge networking behaves differently around `--internal`; the enforcement claim must be proven on Linux, where production runs).

1. Create environment with `networking: {type: "limited", allowedHosts: ["example.com"]}`
2. Create session bound to that env
3. `curl https://example.com/` → MUST succeed (via proxy)
4. `curl https://evil.example.org/` → MUST fail (connection refused by sidecar OR NXDOMAIN)
5. `python -c "import socket; socket.create_connection(('1.1.1.1', 80), timeout=3)"` → MUST fail with timeout/unreachable (no direct egress on `--internal`; Python's `socket` doesn't respect HTTP_PROXY). **This is the headline test — separates real from HTTP-layer-only enforcement.**
6. **AWS IMDS SSRF pivot (canonical SSRF case):** `curl http://169.254.169.254/latest/meta-data` → MUST fail. Advisor-flagged; cloud-native code running in a container WILL try this path to grab instance credentials.
7. DNS smoke, denied host: `dig +time=3 evil.example.org` → MUST return NXDOMAIN from our sidecar.
8. DNS smoke, allowed host: `dig example.com` → MUST resolve.
9. Orchestrator control plane still works: create a second turn in the session, verify the agent's output arrives through the normal event stream (proves `openclaw-control-plane` network is wired and routes correctly).
10. On env delete: confirm sidecar container + per-session networks are cleaned up.

Tests 5 and 6 are the "the proxy isn't bypassable" tests. If either one succeeds, enforcement is not real.

## Bounded implementation plan

Revised against advisor's scope review — HTTP+DNS proxy with robust untrusted-input handling is genuinely larger than the first draft assumed.

| Step | Scope | Files | Est. |
|---|---|---|---|
| **1. Schema** | Extend `NetworkingSchema` + types tests | `src/orchestrator/types.ts`, new `src/orchestrator/types.test.ts` case | 1 h |
| **2. Proxy — HTTP side** | stdlib `http.createServer` + CONNECT, allowlist matching, `/healthz` | `docker/egress-proxy/{Dockerfile,proxy.mjs,README.md}` | 5 h |
| **3. Proxy — DNS side** | `dgram` UDP 53 listener + wire format parse + forward/NXDOMAIN | same | 3 h |
| **4. Proxy — hardening + unit tests** | Oversized headers, malformed CONNECT, HTTP/2 reject, timeouts, wildcard matcher edge cases | `docker/egress-proxy/*.test.mjs` | 4 h |
| **5. Control-plane network** | Create `openclaw-control-plane` in `DockerContainerRuntime.ensureNetwork()`, connect orchestrator to both networks on startup | `src/runtime/docker.ts`, `docker-compose.yml` | 2 h |
| **6. Pool wire** | Per-session network create, sidecar spawn, agent spawn on confined+control-plane, evict both containers + drop networks | `src/runtime/pool.ts`, `src/runtime/docker.ts` | 5 h |
| **7. Router wire** | Read env networking, thread through SpawnOptions; pool branches on it | `src/orchestrator/router.ts`, `src/runtime/container.ts` | 2 h |
| **8. E2E script** | `test/e2e-networking.sh` with all 10 cases against a real Docker daemon | new file | 5 h |
| **9. Docs** | README update + arch doc section + design doc finalization | `README.md`, `docs/architecture.md`, this file | 2 h |
| **10. CI** | Build egress-proxy image in test workflow; publish to GHCR on main | `.github/workflows/{test,publish-images}.yaml` | 1 h |

**Revised estimate: 30 hours = ~4 working days.**

The original 18-hour estimate was off. Advisor correctly flagged that a CONNECT + HTTP + DNS proxy that robustly handles untrusted input is 10-12 hours alone, and Docker-networking E2E with flake-debug is 4-5 hours in practice. The revised plan budgets both honestly.

## Rollout — three shipments, each green

Advisor-recommended split so a topology issue in shipment 2 doesn't lose shipment 1's proxy work.

**Shipment 1 — Proxy image (dark launch). ~1 day.**
Steps 1–4 above. Schema accepts `limited`, unit tests cover the matcher and the DNS filter, image builds in CI and publishes to GHCR. No runtime wiring. No behavior change for any deploy. At the end of this shipment, `networking: limited` is still a runtime no-op — the schema lets it through but the pool ignores it.

**Shipment 2 — Pool + topology wiring. ~1.5 days.**
Steps 5–7 above. Introduce `openclaw-control-plane`, teach the pool to spawn the sidecar + per-session networks, make the router thread networking config through SpawnOptions. After this, `networking: limited` is functional. Ship with a small smoke test (not the full E2E yet) to prove the sidecar comes up and the agent can reach an allowed host.

**Shipment 3 — E2E + docs + publish. ~1.5 days.**
Steps 8–10. Full E2E including the Python raw-socket and IMDS cases. README + architecture doc update. Image publish on main. After this, `networking: limited` is documented and covered.

Each shipment stands alone. If shipment 2 surfaces a Docker-networking issue on a specific kernel / distro, shipment 1's proxy image is still useful and shipment 3 is not blocked for long.

## Open questions

1. **Wildcard semantics.** Does `*.googleapis.com` match `googleapis.com` directly? Industry convention says no (prefix-match only). Adopt that; document it.
2. **IPv6.** Our sidecar should accept IPv6 inbound and forward IPv6 outbound. Docker's `--internal` applies to both. Confirm in integration testing.
3. **Sidecar image size.** Target <100 MB. node:alpine + the proxy script should come in around 60-70 MB.
4. **Resource limits.** Sidecar needs ~64 MiB RAM and 0.1 CPU max — trivial. Set via dockerode constraints at spawn.
5. **Existing agent images without proxy env support.** Are any of our tools ignorant of HTTP_PROXY? `node` fetch respects it (via `undici`), Python `requests` respects it, `curl` respects it. But `socket.connect` calls from Python / Go / raw code do not respect HTTP_PROXY — and that's the point: those will fail cleanly at the network layer instead of silently bypassing. Document this as the "correct failure mode."

## Definition of done

- `networking: limited` accepted by schema with validation.
- E2E test passes all 8 cases against a real Docker daemon on Linux.
- README documents the feature, including the enforcement boundary.
- `openclaw-egress-proxy` image published to GHCR.
- No regression on existing `networking: unrestricted` path (default behavior unchanged).
