#!/usr/bin/env bash
#
# rotate-api-token.sh — set or rotate OPENCLAW_API_TOKEN on a live
# openclaw-managed-agents deploy. Idempotent. Generates a fresh
# 32-byte-hex token unless one is supplied.
#
# Usage:
#   ./scripts/rotate-api-token.sh hetzner    <ip>                    [token]
#   ./scripts/rotate-api-token.sh lightsail  <ip>                    [token]
#   ./scripts/rotate-api-token.sh gcp        <instance-name> <zone>  [token]
#   ./scripts/rotate-api-token.sh local                              [token]
#
# What it does, per target:
#   1. Generates a token (openssl rand -hex 32) unless one is supplied.
#   2. Rewrites /opt/openclaw/.env (remote) or ./.env (local):
#      strips any existing OPENCLAW_API_TOKEN line, appends the new one.
#   3. Runs `docker compose up -d` to apply — only the orchestrator
#      container is recreated because only its env changed.
#   4. Polls /healthz, then hits /v1/agents twice — once without the
#      Bearer header (expects 401) and once with (expects 200). Fails
#      loudly if either assertion doesn't hold.
#   5. Prints the token at the end so you can save it in your password
#      manager. Save it — the only copies on disk after this are in
#      the deploy's .env (owned by root on the remote) and your
#      terminal scrollback.
#
# Requirements:
#   - openssl (token generation)
#   - ssh (Hetzner / Lightsail)
#   - gcloud (GCP only)
#   - curl (verification)
#
# SSH notes:
#   - Hetzner default user: root
#   - Lightsail default user: ubuntu (sudo required to write .env)
#   - GCP default user: ubuntu (sudo required)
#   - Uses StrictHostKeyChecking=accept-new so first-time SSH to a
#     fresh deploy doesn't prompt; subsequent calls use the stored key.

set -euo pipefail

log() { printf "==> %s\n" "$*"; }
err() { printf "error: %s\n" "$*" >&2; }
die() { err "$*"; exit 1; }

usage() {
  cat <<EOF >&2
usage:
  rotate-api-token.sh hetzner    <ip>                    [token]
  rotate-api-token.sh lightsail  <ip>                    [token]
  rotate-api-token.sh gcp        <instance-name> <zone>  [token]
  rotate-api-token.sh local                              [token]

If [token] is omitted, a fresh 32-byte-hex token is generated
(openssl rand -hex 32). The token is printed at the end.
EOF
  exit 1
}

generate_token() {
  command -v openssl >/dev/null 2>&1 || die "openssl not found — install it or pass an explicit token"
  openssl rand -hex 32
}

PROVIDER=${1:-}
[[ -n "${PROVIDER}" ]] || usage

# Per-provider resolution of: the SSH target + sudo prefix + orchestrator URL.
# For `local`, no SSH — we rewrite the repo-root .env directly.
SSH_TARGET=""       # e.g. root@1.2.3.4  (for ssh) or ubuntu@instance (for gcp)
SSH_MODE=""         # "ssh" | "gcp" | "local"
ZONE=""
REMOTE_SUDO=""
ORCH_URL=""
LOCAL_ENV_PATH=""

case "${PROVIDER}" in
  hetzner)
    HOST=${2:-}
    TOKEN=${3:-}
    [[ -n "${HOST}" ]] || usage
    SSH_TARGET="root@${HOST}"
    SSH_MODE="ssh"
    ORCH_URL="http://${HOST}:8080"
    REMOTE_SUDO=""
    ;;
  lightsail)
    HOST=${2:-}
    TOKEN=${3:-}
    [[ -n "${HOST}" ]] || usage
    SSH_TARGET="ubuntu@${HOST}"
    SSH_MODE="ssh"
    ORCH_URL="http://${HOST}:8080"
    REMOTE_SUDO="sudo"
    ;;
  gcp)
    INSTANCE=${2:-}
    ZONE=${3:-}
    TOKEN=${4:-}
    [[ -n "${INSTANCE}" ]] || usage
    [[ -n "${ZONE}" ]] || usage
    command -v gcloud >/dev/null 2>&1 || die "gcloud CLI not found"
    HOST=$(gcloud compute instances describe "${INSTANCE}" --zone "${ZONE}" \
      --format='value(networkInterfaces[0].accessConfigs[0].natIP)' 2>/dev/null) \
      || die "cannot resolve public IP for ${INSTANCE} in ${ZONE}"
    [[ -n "${HOST}" ]] || die "empty public IP for ${INSTANCE} in ${ZONE}"
    SSH_TARGET="ubuntu@${INSTANCE}"
    SSH_MODE="gcp"
    ORCH_URL="http://${HOST}:8080"
    REMOTE_SUDO="sudo"
    ;;
  local)
    TOKEN=${2:-}
    SSH_MODE="local"
    ORCH_URL="http://localhost:8080"
    LOCAL_ENV_PATH="$(cd "$(dirname "$0")/.." && pwd)/.env"
    ;;
  *)
    usage
    ;;
esac

# Generate a token if not supplied.
if [[ -z "${TOKEN}" ]]; then
  TOKEN=$(generate_token)
  log "generated new token"
else
  log "using supplied token"
fi

# Sanity-check the token shape: must be non-empty, no whitespace, no
# newlines (would break the .env line append).
case "${TOKEN}" in
  *[[:space:]]*)
    die "token contains whitespace — use a single-line value"
    ;;
esac

log "provider:       ${PROVIDER}"
if [[ "${SSH_MODE}" == "gcp" ]]; then
  log "instance:       ${INSTANCE} (${ZONE})"
  log "resolved IP:    ${HOST}"
elif [[ "${SSH_MODE}" == "ssh" ]]; then
  log "ssh target:     ${SSH_TARGET}"
fi
log "orchestrator:   ${ORCH_URL}"

# ------------------------------------------------------------------------------
# Remote-run helper. Accepts a shell script on stdin; dispatches via the
# resolved SSH_MODE. Sidesteps SSH quoting hell because we never embed the
# script in argv.
# ------------------------------------------------------------------------------

run_remote() {
  case "${SSH_MODE}" in
    ssh)
      ssh -o StrictHostKeyChecking=accept-new "${SSH_TARGET}" bash
      ;;
    gcp)
      gcloud compute ssh "${SSH_TARGET}" --zone "${ZONE}" --quiet -- bash
      ;;
    *)
      die "run_remote called in non-remote mode"
      ;;
  esac
}

# ------------------------------------------------------------------------------
# Apply the token
# ------------------------------------------------------------------------------

if [[ "${SSH_MODE}" == "local" ]]; then
  log "rewriting ${LOCAL_ENV_PATH}"
  touch "${LOCAL_ENV_PATH}"
  tmp=$(mktemp)
  grep -v '^OPENCLAW_API_TOKEN=' "${LOCAL_ENV_PATH}" > "${tmp}" || true
  printf 'OPENCLAW_API_TOKEN=%s\n' "${TOKEN}" >> "${tmp}"
  mv "${tmp}" "${LOCAL_ENV_PATH}"

  # `--build` forces a rebuild from the local source tree, so a brand-new
  # auth middleware or any other src/ change is picked up. Without --build,
  # compose would reuse the cached image and silently skip the feature.
  log "running docker compose up --build -d"
  ( cd "$(dirname "${LOCAL_ENV_PATH}")" && docker compose up --build -d >/dev/null )
else
  log "rewriting /opt/openclaw/.env on remote"
  # Generate the remote script locally so ${TOKEN} expands here and
  # the remote bash receives a concrete literal. The remote script
  # uses `${REMOTE_SUDO}` for the write (Lightsail + GCP need sudo
  # because cloud-init ran as root; Hetzner doesn't).
  #
  # `docker compose pull` before `up -d` is load-bearing: the remote's
  # cached orchestrator image may predate the auth middleware (or any
  # other shipped feature) and `up -d` alone would silently reuse the
  # stale cache. Pulling first ensures the rotated token lands on a
  # build that actually enforces the header.
  cat <<REMOTE_SCRIPT | run_remote
set -euo pipefail
${REMOTE_SUDO} sh -c "grep -v '^OPENCLAW_API_TOKEN=' /opt/openclaw/.env > /opt/openclaw/.env.tmp 2>/dev/null || true; printf 'OPENCLAW_API_TOKEN=%s\n' '${TOKEN}' >> /opt/openclaw/.env.tmp; mv /opt/openclaw/.env.tmp /opt/openclaw/.env; chmod 0600 /opt/openclaw/.env"
cd /opt/openclaw && ${REMOTE_SUDO} docker compose pull >/dev/null 2>&1 || true
cd /opt/openclaw && ${REMOTE_SUDO} docker compose up -d >/dev/null
REMOTE_SCRIPT
fi

# ------------------------------------------------------------------------------
# Verify
# ------------------------------------------------------------------------------

log "waiting for ${ORCH_URL}/healthz"
for i in $(seq 1 30); do
  if curl -sf --max-time 3 "${ORCH_URL}/healthz" >/dev/null 2>&1; then
    log "/healthz ok (after ${i} probes)"
    break
  fi
  sleep 2
  if [[ "${i}" -eq 30 ]]; then
    die "/healthz did not respond within 60s — rollback? SSH in and check docker compose logs orchestrator"
  fi
done

log "verifying auth"

UNAUTH=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "${ORCH_URL}/v1/agents" 2>/dev/null || echo 000)
if [[ "${UNAUTH}" != "401" ]]; then
  die "expected 401 without token, got ${UNAUTH} — auth may not be enabled yet (check 'docker compose logs orchestrator | grep api_auth')"
fi
log "  GET /v1/agents (no token)          → 401 ✓"

AUTH=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
  -H "Authorization: Bearer ${TOKEN}" \
  "${ORCH_URL}/v1/agents" 2>/dev/null || echo 000)
if [[ "${AUTH}" != "200" ]]; then
  die "expected 200 with token, got ${AUTH} — token mismatch?"
fi
log "  GET /v1/agents (Bearer token)      → 200 ✓"

# Also confirm /healthz stays open without a token (it should — it's in
# the bypass list).
HEALTH_UNAUTH=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "${ORCH_URL}/healthz" 2>/dev/null || echo 000)
if [[ "${HEALTH_UNAUTH}" != "200" ]]; then
  err "warning: /healthz returned ${HEALTH_UNAUTH} without token (expected 200 — it's in the bypass list). Check the auth middleware wiring."
else
  log "  GET /healthz (no token, bypass)    → 200 ✓"
fi

echo
log "SUCCESS"
printf "\n"
printf "    orchestrator: %s\n" "${ORCH_URL}"
printf "    api token:    %s\n" "${TOKEN}"
printf "\n"
printf "    test from your laptop:\n"
printf "      curl -H 'Authorization: Bearer %s' %s/v1/agents\n" "${TOKEN}" "${ORCH_URL}"
printf "\n"
printf "    Python client:\n"
printf "      export OPENCLAW_API_TOKEN=%s\n" "${TOKEN}"
printf "      python research_assistant.py  # or your own\n"
printf "\n"
printf "    save this token in your password manager. the only durable copy\n"
printf "    is in the deploy's .env (owned by root on remote, 0600 perms).\n"
