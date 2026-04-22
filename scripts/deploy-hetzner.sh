#!/usr/bin/env bash
#
# deploy-hetzner.sh — one-command deploy of the OpenClaw Managed Agents to a
# Hetzner Cloud CX22 VPS. Idempotent: re-running reuses the existing server.
#
# Usage:
#     export HCLOUD_TOKEN=<paste-your-token-here>
#     export MOONSHOT_API_KEY=sk-...      # or ANTHROPIC_API_KEY / OPENAI_API_KEY / etc.
#     ./scripts/deploy-hetzner.sh         # provision + bring up
#     ./scripts/deploy-hetzner.sh --destroy  # tear down
#
# Environment variables (all optional except HCLOUD_TOKEN + a provider key):
#     HCLOUD_SERVER_NAME=openclaw-managed-agents   # run multiple deploys by setting different names
#     HCLOUD_LOCATION=nbg1                          # nbg1 | fsn1 | hel1 | ash | hil
#     HCLOUD_SERVER_TYPE=cax11                      # cax11 (ARM, default, cheapest) | cax21 | cax31 | cx23 | cx33 (Intel x86)
#     HCLOUD_IMAGE=ubuntu-24.04
#     OPENCLAW_DEPLOY_BRANCH=main                   # git branch to clone on the server
#     OPENCLAW_DEPLOY_REPO=https://github.com/stainlu/openclaw-managed-agents.git
#
# See docs/deploying-on-hetzner.md for the full walkthrough.

set -euo pipefail

# ------------------------------------------------------------------------------
# Configuration (with overridable defaults)
# ------------------------------------------------------------------------------

SERVER_NAME="${HCLOUD_SERVER_NAME:-openclaw-managed-agents}"
SSH_KEY_NAME="${HCLOUD_SERVER_NAME:-openclaw-managed-agents}-key"
LOCATION="${HCLOUD_LOCATION:-nbg1}"
SERVER_TYPE="${HCLOUD_SERVER_TYPE:-cax11}"
IMAGE="${HCLOUD_IMAGE:-ubuntu-24.04}"
REPO_URL="${OPENCLAW_DEPLOY_REPO:-https://github.com/stainlu/openclaw-managed-agents.git}"
REPO_BRANCH="${OPENCLAW_DEPLOY_BRANCH:-main}"
ORCH_PORT=8080

# Known provider-key env vars that the runtime forwards to agent containers.
# The first one set in the local environment is written into the server's .env.
PROVIDER_KEY_NAMES=(
    MOONSHOT_API_KEY
    ANTHROPIC_API_KEY
    OPENAI_API_KEY
    GEMINI_API_KEY
    GOOGLE_API_KEY
    DEEPSEEK_API_KEY
    QWEN_API_KEY
    DASHSCOPE_API_KEY
    MISTRAL_API_KEY
    XAI_API_KEY
    TOGETHER_API_KEY
    OPENROUTER_API_KEY
    FIREWORKS_API_KEY
    GROQ_API_KEY
)

# Default test model matches the local smoke path.
DEFAULT_TEST_MODEL="${OPENCLAW_TEST_MODEL:-moonshot/kimi-k2.6}"

# ------------------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------------------

log() { printf "==> %s\n" "$*"; }
err() { printf "error: %s\n" "$*" >&2; }
die() { err "$*"; exit 1; }

# Run hcloud with HCLOUD_TOKEN already exported. We intentionally do NOT rely on
# `hcloud context create` so the script is reproducible.
hc() { hcloud "$@"; }

# ------------------------------------------------------------------------------
# Teardown path
# ------------------------------------------------------------------------------

if [[ "${1:-}" == "--destroy" ]]; then
    log "Destroying ${SERVER_NAME}"
    [[ -n "${HCLOUD_TOKEN:-}" ]] || die "HCLOUD_TOKEN is not set"
    if hc server describe "${SERVER_NAME}" >/dev/null 2>&1; then
        hc server delete "${SERVER_NAME}"
        log "Server ${SERVER_NAME} deleted."
    else
        log "Server ${SERVER_NAME} not found — nothing to destroy."
    fi
    exit 0
fi

# ------------------------------------------------------------------------------
# Preflight checks
# ------------------------------------------------------------------------------

log "Checking prerequisites"

command -v hcloud >/dev/null 2>&1 || die "hcloud CLI not found. Install: brew install hcloud  OR  see https://github.com/hetznercloud/cli"
printf "    hcloud CLI:        ok (%s)\n" "$(hcloud version 2>&1 | head -n 1)"

[[ -n "${HCLOUD_TOKEN:-}" ]] || die "HCLOUD_TOKEN is not set. Generate one at https://console.hetzner.cloud → project → Security → API Tokens (Read & Write)."
printf "    HCLOUD_TOKEN:      ok\n"

# Find the user's default SSH public key
SSH_PUBKEY_PATH=""
for candidate in "${HOME}/.ssh/id_ed25519.pub" "${HOME}/.ssh/id_rsa.pub" "${HOME}/.ssh/id_ecdsa.pub"; do
    if [[ -f "${candidate}" ]]; then
        SSH_PUBKEY_PATH="${candidate}"
        break
    fi
done
[[ -n "${SSH_PUBKEY_PATH}" ]] || die "No SSH public key found in ~/.ssh/. Run: ssh-keygen -t ed25519"
printf "    SSH public key:    %s\n" "${SSH_PUBKEY_PATH}"

# Find the first provider key that is set
PROVIDER_KEY_NAME=""
PROVIDER_KEY_VALUE=""
for name in "${PROVIDER_KEY_NAMES[@]}"; do
    value="${!name:-}"
    if [[ -n "${value}" ]]; then
        PROVIDER_KEY_NAME="${name}"
        PROVIDER_KEY_VALUE="${value}"
        break
    fi
done
if [[ -z "${PROVIDER_KEY_NAME}" ]]; then
    die "No provider API key is exported. Set at least one of: ${PROVIDER_KEY_NAMES[*]}"
fi
printf "    Provider key:      %s\n" "${PROVIDER_KEY_NAME}"
printf "    Test model:        %s\n" "${DEFAULT_TEST_MODEL}"

# ------------------------------------------------------------------------------
# Register the SSH key with the Hetzner project (idempotent)
# ------------------------------------------------------------------------------

log "Registering SSH key with Hetzner project (${SSH_KEY_NAME})"
if hc ssh-key describe "${SSH_KEY_NAME}" >/dev/null 2>&1; then
    printf "    SSH key already registered, reusing.\n"
else
    hc ssh-key create \
        --name "${SSH_KEY_NAME}" \
        --public-key-from-file "${SSH_PUBKEY_PATH}"
fi

# ------------------------------------------------------------------------------
# Render the cloud-init user-data
# ------------------------------------------------------------------------------

log "Rendering cloud-init user-data with ${PROVIDER_KEY_NAME}"

USER_DATA_FILE="$(mktemp -t openclaw-cloud-init.XXXXXX.yaml)"
trap 'rm -f "${USER_DATA_FILE}"' EXIT

# Read the user's SSH public key so we can inject it into authorized_keys via
# cloud-init directly. This is more reliable than the --ssh-key CLI flag, which
# has been observed to silently fail to attach the key on some deploys.
SSH_PUBKEY_CONTENT="$(cat "${SSH_PUBKEY_PATH}")"

cat > "${USER_DATA_FILE}" <<CLOUDINIT
#cloud-config
package_update: true
package_upgrade: false

ssh_authorized_keys:
  - ${SSH_PUBKEY_CONTENT}

packages:
  - apt-transport-https
  - ca-certificates
  - curl
  - git
  - gnupg
  - jq
  - lsb-release

write_files:
  - path: /opt/openclaw-bootstrap.sh
    permissions: '0755'
    content: |
      #!/usr/bin/env bash
      set -euxo pipefail

      # Deploy is intentionally minimal: install Docker, clone the repo,
      # write .env, bring the stack up. SSH exists only as a break-glass
      # escape hatch — all routine operator interaction happens via the
      # HTTP API on :8080 and the portal at /v2. If this VM breaks, the
      # correct response is `./scripts/deploy-hetzner.sh --destroy &&
      # ./scripts/deploy-hetzner.sh` (cattle, not pets), not SSH in to
      # fix it. No ssh.socket overrides, no port 222 kludge, no fail2ban
      # tweaks — stock Ubuntu defaults are fine because nobody is
      # supposed to be SSHing under normal operation.

      # --- Install Docker via the official Docker repo ---
      install -m 0755 -d /etc/apt/keyrings
      curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
      chmod a+r /etc/apt/keyrings/docker.asc
      echo "deb [arch=\$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu \$(. /etc/os-release && echo \$VERSION_CODENAME) stable" > /etc/apt/sources.list.d/docker.list
      apt-get update -y
      apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
      systemctl enable --now docker

      # --- Clone the runtime repo ---
      git clone --depth 1 --branch ${REPO_BRANCH} ${REPO_URL} /opt/openclaw
      cd /opt/openclaw
      mkdir -p data/sessions data/state

      # --- Write .env with the provider API key ---
      # OPENCLAW_MAX_WARM_CONTAINERS=3 opts this cloud VM into the warm
      # pool (first-event latency ~0 ms instead of ~10 s). The library
      # default is 0 so local dev machines never accidentally spawn a
      # pool of idle containers that each burn ~250% CPU — warming is
      # only sensible on a dedicated VM with idle capacity.
      # 3 was picked for CAX11 (4 vCPU, 8 GiB) as a balance — each
      # warm holds ~500 MiB steady-state and won't peg all cores.
      # NB: printf (not a nested heredoc) — the outer cloud-init heredoc
      # already preserves leading whitespace, which would corrupt every
      # key in the inner heredoc (" KEY=…" ≠ "KEY=…" for dotenv parsers).
      # Generate a random API token for this deployment. openssl is
      # available after the packages step above.
      GENERATED_TOKEN=\$(openssl rand -hex 32)
      printf '%s=%s\\nOPENCLAW_TEST_MODEL=%s\\nOPENCLAW_MAX_WARM_CONTAINERS=3\\nOPENCLAW_API_TOKEN=%s\\n' '${PROVIDER_KEY_NAME}' '${PROVIDER_KEY_VALUE}' '${DEFAULT_TEST_MODEL}' "\${GENERATED_TOKEN}" > .env
      echo "OPENCLAW_API_TOKEN=\${GENERATED_TOKEN}" > /root/.openclaw-api-token

      # --- Pull pre-built images from GHCR (published by .github/workflows/
      # publish-images.yaml on every push to main) and bring up the stack.
      # Skipping --build cuts deploy time from ~4 min to ~1-2 min on Hetzner
      # CAX11 and from ~12 min to ~3 min on Lightsail medium_3_0. ---
      docker compose pull
      # The egress-proxy sidecar is spawned dynamically (not a compose
      # service), so `docker compose pull` doesn't fetch it. Pull it
      # explicitly so networking:limited sessions don't fail on first use.
      docker pull ghcr.io/stainlu/openclaw-managed-agents-egress-proxy:latest
      docker compose up -d

      # --- Health-check loop (up to 10 min) ---
      for i in \$(seq 1 120); do
          if curl -sf http://127.0.0.1:${ORCH_PORT}/healthz >/dev/null; then
              echo "orchestrator ready after \${i} probes" > /var/log/openclaw-ready.log
              exit 0
          fi
          sleep 5
      done
      echo "orchestrator did not become ready after 10 minutes" > /var/log/openclaw-ready.log
      exit 1

runcmd:
  - bash /opt/openclaw-bootstrap.sh 2>&1 | tee /var/log/openclaw-bootstrap.log
CLOUDINIT

# ------------------------------------------------------------------------------
# Provision (or reuse) the server
# ------------------------------------------------------------------------------

if hc server describe "${SERVER_NAME}" >/dev/null 2>&1; then
    log "Server ${SERVER_NAME} already exists — reusing"
    SERVER_IPV4="$(hc server describe "${SERVER_NAME}" -o json | jq -r '.public_net.ipv4.ip')"
    SERVER_IPV6="$(hc server describe "${SERVER_NAME}" -o json | jq -r '.public_net.ipv6.ip')"
    printf "    IPv4:              %s\n" "${SERVER_IPV4}"
    printf "    IPv6:              %s\n" "${SERVER_IPV6}"
    printf "    Note:              cloud-init already ran on first provision. If the runtime\n"
    printf "                       is not live, SSH in and inspect /var/log/openclaw-bootstrap.log.\n"
else
    log "Provisioning ${SERVER_TYPE} server in ${LOCATION} (${SERVER_NAME})"
    # Note: --ssh-key is passed as a belt-and-suspenders to the cloud-init
    # ssh_authorized_keys directive above. Cloud-init is the source of truth;
    # the CLI flag is a safety net in case cloud-init fails early.
    # --start-after-create is intentionally omitted — default is true.
    hc server create \
        --name "${SERVER_NAME}" \
        --type "${SERVER_TYPE}" \
        --image "${IMAGE}" \
        --location "${LOCATION}" \
        --ssh-key "${SSH_KEY_NAME}" \
        --user-data-from-file "${USER_DATA_FILE}" \
        >/dev/null
    SERVER_IPV4="$(hc server describe "${SERVER_NAME}" -o json | jq -r '.public_net.ipv4.ip')"
    SERVER_IPV6="$(hc server describe "${SERVER_NAME}" -o json | jq -r '.public_net.ipv6.ip')"
    printf "    IPv4:              %s\n" "${SERVER_IPV4}"
    printf "    IPv6:              %s\n" "${SERVER_IPV6}"
fi

# ------------------------------------------------------------------------------
# Wait for the orchestrator to be reachable from the public IP
# ------------------------------------------------------------------------------

log "Waiting for cloud-init to install Docker + bring up the stack (~4 min)"
ORCH_URL="http://${SERVER_IPV4}:${ORCH_PORT}"
DEADLINE=$(( $(date +%s) + 600 ))
SUCCESS=0
while [[ "$(date +%s)" -lt "${DEADLINE}" ]]; do
    if curl -sf --max-time 3 "${ORCH_URL}/healthz" >/dev/null 2>&1; then
        SUCCESS=1
        break
    fi
    printf "    [+%3d s] waiting for %s/healthz\n" "$(( $(date +%s) - (DEADLINE - 600) ))" "${ORCH_URL}"
    sleep 15
done

if [[ "${SUCCESS}" -eq 1 ]]; then
    log "Deploy complete"
    printf "    Orchestrator:      %s\n" "${ORCH_URL}"
    printf "    Portal:            %s/v2\n" "${ORCH_URL}"
    # Retrieve the generated API token from the instance
    API_TOKEN_LINE="$(ssh -q -o StrictHostKeyChecking=no -o ConnectTimeout=5 "root@${SERVER_IPV4}" 'cat /root/.openclaw-api-token 2>/dev/null' 2>/dev/null || echo "")"
    if [[ -n "${API_TOKEN_LINE}" ]]; then
        printf "    API token:         %s\n" "${API_TOKEN_LINE}"
        printf "                       (saved on instance at /root/.openclaw-api-token)\n"
    fi
    printf "    Monthly cost:      ~€4.35 gross / €3.99 net (€0.007/hr) — cax11 ARM, EU\n"
    printf "    Destroy + reset:   ./scripts/deploy-hetzner.sh --destroy && ./scripts/deploy-hetzner.sh\n"
    printf "    Break-glass SSH:   ssh root@%s   (not for routine ops — use the HTTP API)\n" "${SERVER_IPV4}"
else
    err "Orchestrator did not become reachable at ${ORCH_URL}/healthz after 10 minutes."
    err "Break-glass: ssh root@${SERVER_IPV4} 'tail -f /var/log/openclaw-bootstrap.log'"
    exit 1
fi
