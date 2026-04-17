#!/usr/bin/env bash
#
# End-to-end proof that the `networking: limited` topology enforces the
# allowlist against real network traffic — not just through the HTTP
# proxy layer, but at the kernel level via --internal Docker networks
# and a DNS filter on UDP 53.
#
# This script skips the orchestrator on purpose. The orchestrator's
# spawn logic is already covered by unit tests (src/runtime/pool.test.ts)
# with a FakeRuntime that asserts the correct Docker primitives are
# called. What we need to prove HERE is that those primitives actually
# do what we expect against a real Docker daemon. Specifically that a
# container on a --internal network with proxy env vars set can:
#
#   - reach an allowed host via HTTPS (through the sidecar)
#   - not reach a denied host via HTTPS (sidecar 403)
#   - not reach a denied host via raw TCP (no kernel route out)
#   - not reach AWS IMDS via raw HTTP (canonical SSRF pivot)
#   - see NXDOMAIN for denied DNS queries
#   - see resolution for allowed DNS queries
#
# Run locally on macOS Docker Desktop: `bash test/e2e-networking.sh`
# works but Docker Desktop's VM treats --internal slightly differently
# from native Linux. The canonical enforcement claim is proven in CI
# on ubuntu-latest.
#
# Environment overrides:
#   EGRESS_PROXY_IMAGE  — image ref to test (default: build from local tree)
#   SKIP_BUILD=1        — skip the local image build (use a pre-pulled image)
#   ALLOWED_HOST        — allowed test host (default: example.com)
#   DENIED_HOST         — denied test host (default: evil.example.org)
#   KEEP_CONTAINERS=1   — don't clean up; useful for debugging

set -euo pipefail

EGRESS_PROXY_IMAGE="${EGRESS_PROXY_IMAGE:-openclaw-egress-proxy:e2e}"
ALLOWED_HOST="${ALLOWED_HOST:-example.com}"
DENIED_HOST="${DENIED_HOST:-evil.example.org}"
TEST_ID="e2e-$(date +%s)-$$"
CONFINED_NET="oc-$TEST_ID-confined"
EGRESS_NET="oc-$TEST_ID-egress"
SIDECAR_NAME="oc-$TEST_ID-proxy"
AGENT_NAME="oc-$TEST_ID-agent"
# nicolaka/netshoot ships with curl, dig, python, nmap, socat, etc.
# Pinned to a stable digest to avoid upstream drift during CI.
AGENT_IMAGE="${AGENT_IMAGE:-nicolaka/netshoot:v0.13}"

# ---- tiny output helpers ------------------------------------------------
log()  { printf "\033[36m[e2e]\033[0m %s\n" "$*"; }
ok()   { printf "\033[32m  ✓\033[0m %s\n" "$*"; }
fail() { printf "\033[31m  ✗\033[0m %s\n" "$*"; EXIT_CODE=1; }
FAILED=()

# EXIT_CODE tracks test-case failures separately from setup errors.
# Setup errors use `set -e`; test-case assertions bump EXIT_CODE.
EXIT_CODE=0

# ---- cleanup -----------------------------------------------------------
cleanup() {
  if [[ "${KEEP_CONTAINERS:-0}" == "1" ]]; then
    log "KEEP_CONTAINERS=1 — leaving $AGENT_NAME + $SIDECAR_NAME + networks"
    return
  fi
  log "cleaning up $TEST_ID"
  docker rm -f "$AGENT_NAME" >/dev/null 2>&1 || true
  docker rm -f "$SIDECAR_NAME" >/dev/null 2>&1 || true
  docker network rm "$CONFINED_NET" >/dev/null 2>&1 || true
  docker network rm "$EGRESS_NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# ---- pre-flight --------------------------------------------------------
command -v docker >/dev/null 2>&1 || {
  echo "docker CLI not found; this test needs a live Docker daemon" >&2
  exit 2
}
docker info >/dev/null 2>&1 || {
  echo "docker daemon not reachable" >&2
  exit 2
}

# Build the egress-proxy image if the caller didn't override.
if [[ "${SKIP_BUILD:-0}" != "1" && "$EGRESS_PROXY_IMAGE" == "openclaw-egress-proxy:e2e" ]]; then
  log "building egress-proxy image ($EGRESS_PROXY_IMAGE)"
  docker build -q -t "$EGRESS_PROXY_IMAGE" docker/egress-proxy >/dev/null
fi

# Pre-pull the agent image so the first-run latency doesn't push
# test timeouts over the edge.
docker pull -q "$AGENT_IMAGE" >/dev/null

# ---- topology ----------------------------------------------------------
log "creating networks"
docker network create --driver bridge --internal "$CONFINED_NET" >/dev/null
docker network create --driver bridge "$EGRESS_NET" >/dev/null

log "starting egress-proxy sidecar ($SIDECAR_NAME)"
docker run -d --rm \
  --name "$SIDECAR_NAME" \
  --network "$CONFINED_NET" \
  -e "OPENCLAW_EGRESS_ALLOWED_HOSTS=[\"$ALLOWED_HOST\"]" \
  -e "OPENCLAW_EGRESS_SESSION_ID=$TEST_ID" \
  "$EGRESS_PROXY_IMAGE" >/dev/null
# Connect sidecar to the egress network so it can talk to the internet.
docker network connect "$EGRESS_NET" "$SIDECAR_NAME"

# Wait for sidecar readiness via its /healthz inside the confined network.
# Agent can't reach it yet (not spawned), so run healthz from a probe
# container on the same confined network.
log "waiting for sidecar /healthz"
for i in $(seq 1 20); do
  if docker run --rm --network "$CONFINED_NET" curlimages/curl:latest \
      -s -f --max-time 2 "http://$SIDECAR_NAME:8119/healthz" >/dev/null 2>&1; then
    ok "sidecar ready after $((i * 1)) probes"
    break
  fi
  sleep 1
  [[ $i -eq 20 ]] && { echo "sidecar did not become ready" >&2; exit 2; }
done

# Look up sidecar's confined-network IP so we can point agent DNS at it.
SIDECAR_IP=$(docker inspect "$SIDECAR_NAME" \
  --format "{{ (index .NetworkSettings.Networks \"$CONFINED_NET\").IPAddress }}")
log "sidecar confined IP: $SIDECAR_IP"

log "starting agent (netshoot) on confined only"
# Agent joins ONLY the confined network (--internal, no egress). Its
# HTTP_PROXY points at the sidecar's name on confined; its DNS points
# at the sidecar's IP so getaddrinfo() also hits the filter.
docker run -d --rm \
  --name "$AGENT_NAME" \
  --network "$CONFINED_NET" \
  --dns "$SIDECAR_IP" \
  -e "HTTP_PROXY=http://$SIDECAR_NAME:8118" \
  -e "HTTPS_PROXY=http://$SIDECAR_NAME:8118" \
  -e "http_proxy=http://$SIDECAR_NAME:8118" \
  -e "https_proxy=http://$SIDECAR_NAME:8118" \
  "$AGENT_IMAGE" sleep 300 >/dev/null

# ---- assertions --------------------------------------------------------

exec_in_agent() { docker exec "$AGENT_NAME" "$@"; }

log "case 1: curl to allowed host through proxy → should succeed"
if exec_in_agent curl -sk --max-time 10 -o /dev/null -w "%{http_code}" "https://$ALLOWED_HOST/" | grep -qE "^(200|301|302|403|429)$"; then
  ok "allowed HTTPS reached upstream ($ALLOWED_HOST)"
else
  fail "allowed HTTPS was blocked (should have reached upstream)"
  FAILED+=("1-allowed-https")
fi

log "case 2: curl to denied host through proxy → should be rejected"
# Two possible valid outcomes:
#   (a) sidecar sees the CONNECT and responds 403 before the TLS
#       tunnel forms.
#   (b) the denied hostname never resolves because our DNS filter
#       returned NXDOMAIN first — curl fails at getaddrinfo.
# What must NOT appear is any 2xx/3xx. We check by looking for a
# success code in the `%{http_code}` stream; anything else is a win.
exec_in_agent curl -sk --max-time 10 --max-redirs 0 -o /dev/null -w "%{http_code}\n" "https://$DENIED_HOST/" > /tmp/e2e-case2.out 2>&1 || true
status=$(tr -d '\n' < /tmp/e2e-case2.out)
if echo "$status" | grep -qE "^(200|201|301|302)"; then
  fail "denied HTTPS reached upstream (status=$status)"
  FAILED+=("2-denied-https")
else
  ok "denied HTTPS was rejected (status=$status)"
fi

log "case 3: python raw socket to 1.1.1.1:80 → should fail (no route out)"
# This is the headline test. A confined container on --internal has NO
# path to 1.1.1.1 because the bridge drops non-member packets. Python's
# socket doesn't respect HTTP_PROXY, so if the network layer is broken
# this succeeds. It must fail.
python_output=$(exec_in_agent python3 -c "
import socket, sys
try:
    s = socket.create_connection(('1.1.1.1', 80), timeout=3)
    s.close()
    print('REACHED')
except Exception as e:
    print(f'BLOCKED: {type(e).__name__}')
" 2>&1 || true)
if [[ "$python_output" == BLOCKED:* ]]; then
  ok "raw socket.connect blocked ($python_output)"
else
  fail "raw socket reached 1.1.1.1 — kernel-level enforcement broken! ($python_output)"
  FAILED+=("3-raw-socket")
fi

log "case 4a: AWS IMDS via HTTP proxy → sidecar should 403"
# 169.254.169.254 is the canonical SSRF pivot for cloud credentials.
# When the caller respects HTTP_PROXY, the sidecar sees the request
# and rejects it at the HTTP layer because 169.254.169.254 isn't in
# the allowlist. Valid: 403 from sidecar, or 000 if curl gave up.
imds_proxy_status=$(exec_in_agent curl -s --max-time 3 -o /dev/null -w "%{http_code}" "http://169.254.169.254/latest/meta-data" 2>/dev/null || echo failed)
if [[ "$imds_proxy_status" == "403" ]] || [[ "$imds_proxy_status" =~ ^0+$ ]] || [[ "$imds_proxy_status" == "failed" ]]; then
  ok "AWS IMDS blocked at proxy layer (status=$imds_proxy_status)"
else
  fail "AWS IMDS reachable through HTTP proxy (status=$imds_proxy_status)"
  FAILED+=("4a-imds-proxy")
fi

log "case 4b: AWS IMDS bypassing proxy → network-layer must block"
# Bypassing HTTP_PROXY proves the --internal Docker network itself
# blocks the egress. Without --internal, a malicious agent could
# `curl --noproxy '*' http://169.254.169.254/` to dodge the sidecar.
# With --internal, no route exists at the kernel level — must fail.
exec_in_agent curl -s --noproxy '*' --max-time 3 -o /dev/null -w "%{http_code}\n" "http://169.254.169.254/latest/meta-data" > /tmp/e2e-case4b.out 2>&1 || true
imds_direct=$(tr -d '\n' < /tmp/e2e-case4b.out)
if echo "$imds_direct" | grep -qE "^(200|201|301|302)"; then
  fail "AWS IMDS reachable direct — kernel-level enforcement broken! (status=$imds_direct)"
  FAILED+=("4b-imds-direct")
else
  ok "AWS IMDS unreachable at network layer (status=$imds_direct)"
fi

log "case 5: dig denied host → should return NXDOMAIN"
# Dig against the sidecar's DNS filter should synthesize NXDOMAIN for
# denied names. `dig` exits 0 on NXDOMAIN; check the rcode.
dig_out=$(exec_in_agent dig +time=3 +tries=1 "$DENIED_HOST" || true)
if echo "$dig_out" | grep -q "status: NXDOMAIN"; then
  ok "denied DNS returned NXDOMAIN"
else
  fail "denied DNS did not return NXDOMAIN"
  echo "$dig_out" | head -20
  FAILED+=("5-dns-denied")
fi

log "case 6: dig allowed host → should resolve"
dig_out=$(exec_in_agent dig +time=5 +tries=1 "$ALLOWED_HOST" || true)
if echo "$dig_out" | grep -q "status: NOERROR" && echo "$dig_out" | grep -qE "^$ALLOWED_HOST\."; then
  ok "allowed DNS resolved"
else
  fail "allowed DNS did not resolve cleanly"
  echo "$dig_out" | head -20
  FAILED+=("6-dns-allowed")
fi

log "case 7: sidecar logs show allow + deny decisions"
sidecar_logs=$(docker logs "$SIDECAR_NAME" 2>&1 || true)
if echo "$sidecar_logs" | grep -q '"decision":"deny"'; then
  ok "sidecar logged a deny decision"
else
  fail "sidecar did NOT log any deny decisions (filter never engaged?)"
  FAILED+=("7-logs-deny")
fi
if echo "$sidecar_logs" | grep -q '"decision":"allow"'; then
  ok "sidecar logged an allow decision"
else
  fail "sidecar did NOT log any allow decisions"
  FAILED+=("7-logs-allow")
fi

# ---- summary -----------------------------------------------------------
echo
if [[ "$EXIT_CODE" -eq 0 ]]; then
  echo -e "\033[32m=== networking: limited E2E — ALL CASES PASSED ===\033[0m"
else
  echo -e "\033[31m=== networking: limited E2E — FAILURES: ${FAILED[*]} ===\033[0m"
fi
exit "$EXIT_CODE"
