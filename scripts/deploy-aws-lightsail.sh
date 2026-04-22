#!/usr/bin/env bash
#
# deploy-aws-lightsail.sh — one-command deploy of the OpenClaw Managed Agents
# to an AWS Lightsail instance. Idempotent: re-running reuses the existing
# instance if present.
#
# Usage:
#     export AWS_ACCESS_KEY_ID=AKIA...
#     export AWS_SECRET_ACCESS_KEY=...
#     export AWS_DEFAULT_REGION=us-east-1      # or whichever region you prefer
#     export MOONSHOT_API_KEY=sk-...           # or ANTHROPIC_API_KEY / OPENAI_API_KEY / etc.
#     ./scripts/deploy-aws-lightsail.sh        # provision + bring up
#     ./scripts/deploy-aws-lightsail.sh --destroy  # tear down
#
# Environment variables (all optional except AWS creds + a provider key):
#     LIGHTSAIL_INSTANCE_NAME=openclaw-managed-agents    # run multiple deploys by setting different names
#     LIGHTSAIL_REGION=us-east-1                          # us-east-1 | us-east-2 | eu-west-1 | etc.
#     LIGHTSAIL_AVAILABILITY_ZONE=us-east-1a              # must match region
#     LIGHTSAIL_BUNDLE_ID=medium_3_0                      # nano_3_0 ($5) | micro_3_0 ($7) | small_3_0 ($12, 2GB) | medium_3_0 ($24, 4GB) | large_3_0 ($44, 8GB)
#     LIGHTSAIL_BLUEPRINT_ID=ubuntu_24_04
#     OPENCLAW_DEPLOY_BRANCH=main                         # git branch to clone on the instance
#     OPENCLAW_DEPLOY_REPO=https://github.com/stainlu/openclaw-managed-agents.git
#
# See docs/deploying-on-aws-lightsail.md for the full walkthrough.

set -euo pipefail

# ------------------------------------------------------------------------------
# Configuration (with overridable defaults)
# ------------------------------------------------------------------------------

INSTANCE_NAME="${LIGHTSAIL_INSTANCE_NAME:-openclaw-managed-agents}"
REGION="${LIGHTSAIL_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"
AVAILABILITY_ZONE="${LIGHTSAIL_AVAILABILITY_ZONE:-${REGION}a}"
BUNDLE_ID="${LIGHTSAIL_BUNDLE_ID:-medium_3_0}"
BLUEPRINT_ID="${LIGHTSAIL_BLUEPRINT_ID:-ubuntu_24_04}"
REPO_URL="${OPENCLAW_DEPLOY_REPO:-https://github.com/stainlu/openclaw-managed-agents.git}"
REPO_BRANCH="${OPENCLAW_DEPLOY_BRANCH:-main}"
ORCH_PORT=8080

# Known provider-key env vars that the runtime forwards to agent containers.
# The first one set in the local environment is written into the instance's .env.
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

# Shortcut for aws lightsail with region pinned.
ls_cli() { aws lightsail --region "${REGION}" "$@"; }

# ------------------------------------------------------------------------------
# Teardown path
# ------------------------------------------------------------------------------

if [[ "${1:-}" == "--destroy" ]]; then
    log "Destroying ${INSTANCE_NAME} in ${REGION}"
    command -v aws >/dev/null 2>&1 || die "aws CLI not found"
    if ls_cli get-instance --instance-name "${INSTANCE_NAME}" >/dev/null 2>&1; then
        ls_cli delete-instance --instance-name "${INSTANCE_NAME}" >/dev/null
        log "Instance ${INSTANCE_NAME} deleted."
    else
        log "Instance ${INSTANCE_NAME} not found — nothing to destroy."
    fi
    exit 0
fi

# ------------------------------------------------------------------------------
# Preflight checks
# ------------------------------------------------------------------------------

log "Checking prerequisites"

command -v aws >/dev/null 2>&1 || die "aws CLI not found. Install: brew install awscli (macOS), or see https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html"
printf "    aws CLI:           ok (%s)\n" "$(aws --version 2>&1 | head -n 1)"

# Verify credentials are valid by calling STS. Surfaces a clear error if
# AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_PROFILE isn't set correctly.
if ! CALLER=$(aws sts get-caller-identity --output text --query 'Arn' 2>&1); then
    err "aws sts get-caller-identity failed. Check your credentials."
    err "Either: export AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY, or: aws configure"
    err "Underlying error: ${CALLER}"
    exit 1
fi
printf "    AWS credentials:   ok (%s)\n" "${CALLER}"
printf "    Region:            %s\n" "${REGION}"
printf "    Availability zone: %s\n" "${AVAILABILITY_ZONE}"

# Find the user's default SSH public key. We inject it via cloud-init rather
# than using Lightsail's native key pair model, matching the Hetzner deploy
# script's pattern.
SSH_PUBKEY_PATH=""
for candidate in "${HOME}/.ssh/id_ed25519.pub" "${HOME}/.ssh/id_rsa.pub" "${HOME}/.ssh/id_ecdsa.pub"; do
    if [[ -f "${candidate}" ]]; then
        SSH_PUBKEY_PATH="${candidate}"
        break
    fi
done
[[ -n "${SSH_PUBKEY_PATH}" ]] || die "No SSH public key found in ~/.ssh/. Run: ssh-keygen -t ed25519"
printf "    SSH public key:    %s\n" "${SSH_PUBKEY_PATH}"
SSH_PUBKEY_CONTENT="$(cat "${SSH_PUBKEY_PATH}")"

# Find the first provider key that is set.
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
printf "    Bundle:            %s\n" "${BUNDLE_ID}"
printf "    Blueprint:         %s\n" "${BLUEPRINT_ID}"

# ------------------------------------------------------------------------------
# Render the user-data as a pure shell script
# ------------------------------------------------------------------------------
#
# AWS Lightsail PREPENDS its own `#!/bin/sh` boot script to every instance's
# user-data before cloud-init sees it (to install Lightsail's browser-SSH CA
# into /etc/ssh/sshd_config). This means cloud-init's content-type detection
# reads `#!/bin/sh` as the first line and treats the ENTIRE user-data as a
# shell script — NOT as cloud-config YAML. Any `#cloud-config`, `write_files`,
# `ssh_authorized_keys`, or `runcmd` directives are silently ignored.
#
# The Hetzner deploy uses cloud-config YAML and works because Hetzner doesn't
# prepend anything. On Lightsail we must write the user-data as pure shell.
# Lightsail's prepended script runs first (configures the SSH CA), then our
# script runs after. The outputs of both go to /var/log/cloud-init-output.log.
#
# Notable differences from the cloud-config version:
#   - SSH key is written directly to /home/ubuntu/.ssh/authorized_keys (Ubuntu
#     blueprint's default user is `ubuntu`, not `root`) instead of via the
#     cloud-config `ssh_authorized_keys:` directive.
#   - Package install + Docker install are imperative `apt-get install` lines.
#   - The .env file is written via `printf` (not a nested heredoc) to avoid
#     any heredoc-inside-heredoc terminator matching bugs.
#   - No ssh.socket overrides, no port 222, no fail2ban tweaks. SSH is a
#     break-glass hatch only; routine operator UX is the HTTP API on 8080
#     and the portal at /v2. Same philosophy as deploy-hetzner.sh post-
#     cleanup.

log "Rendering user-data (pure shell for Lightsail)"

# The user-data is rendered as pure shell, and it contains NO `$(cmd)` or
# backtick command substitutions — those would confuse bash's outer heredoc
# parser on the Mac side (it can't distinguish `\$(...)` from a real command
# substitution and tries to find the matching `)`, producing a cryptic
# "unexpected EOF" at heredoc-open-time). Anywhere we need runtime command
# output on the server, we use hardcoded values (amd64 / noble) or a
# separately-rendered piece of shell that avoids parens entirely. We also
# drop the in-user-data healthz poll loop because the deploy script polls
# /healthz from the Mac side after create-instances returns.

USER_DATA="$(cat <<USERDATA
set -eux

# --- Add the operator's SSH public key to ubuntu's authorized_keys ---
install -o ubuntu -g ubuntu -m 0700 -d /home/ubuntu/.ssh
printf '%s\\n' '${SSH_PUBKEY_CONTENT}' >> /home/ubuntu/.ssh/authorized_keys
chown ubuntu:ubuntu /home/ubuntu/.ssh/authorized_keys
chmod 0600 /home/ubuntu/.ssh/authorized_keys

# --- Don't touch sshd. Stock Ubuntu defaults are fine because nobody is
# supposed to SSH under normal operation — the HTTP API + portal are the
# routine UX, SSH is only for the rare incident where the VM itself is
# wedged. Lightsail also provides a browser-based SSH console for that
# case that bypasses any client-side networking issues.

# --- Install baseline packages ---
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y apt-transport-https ca-certificates curl git gnupg jq lsb-release

# --- Install Docker from the official Docker apt repo ---
# Hardcoded amd64 + noble because Lightsail ubuntu_24_04 is always x86 + noble.
# Avoiding \$(dpkg --print-architecture) here because it breaks the outer
# heredoc render on the Mac side.
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable" > /etc/apt/sources.list.d/docker.list
apt-get update -y
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker

# --- Clone the runtime repo ---
git clone --depth 1 --branch '${REPO_BRANCH}' '${REPO_URL}' /opt/openclaw
cd /opt/openclaw
mkdir -p data/sessions data/state

# --- Write .env via printf (no nested heredoc) ---
# OPENCLAW_MAX_WARM_CONTAINERS=3 opts this cloud VM into the warm pool.
# Library default is 0 so local dev never spawns idle-but-expensive
# openclaw containers; cloud deploys explicitly opt in here.
GENERATED_TOKEN=\$(openssl rand -hex 32)
printf '%s=%s\\nOPENCLAW_TEST_MODEL=%s\\nOPENCLAW_MAX_WARM_CONTAINERS=3\\nOPENCLAW_API_TOKEN=%s\\n' '${PROVIDER_KEY_NAME}' '${PROVIDER_KEY_VALUE}' '${DEFAULT_TEST_MODEL}' "\${GENERATED_TOKEN}" > .env
echo "OPENCLAW_API_TOKEN=\${GENERATED_TOKEN}" > /home/ubuntu/.openclaw-api-token

# --- Pull pre-built images from GHCR and bring up the stack. Skipping
# --build cuts Lightsail deploy time from ~12 min to ~3 min. ---
docker compose pull
# The egress-proxy sidecar is spawned dynamically (not a compose
# service), so docker compose pull doesn't fetch it.
docker pull ghcr.io/stainlu/openclaw-managed-agents-egress-proxy:latest
docker compose up -d
echo "user-data bootstrap complete" > /var/log/openclaw-ready.log
USERDATA
)"

# ------------------------------------------------------------------------------
# Provision (or reuse) the instance
# ------------------------------------------------------------------------------

if ls_cli get-instance --instance-name "${INSTANCE_NAME}" >/dev/null 2>&1; then
    log "Instance ${INSTANCE_NAME} already exists — reusing"
    INSTANCE_INFO="$(ls_cli get-instance --instance-name "${INSTANCE_NAME}")"
    SERVER_IPV4="$(echo "${INSTANCE_INFO}" | jq -r '.instance.publicIpAddress')"
    printf "    IPv4:              %s\n" "${SERVER_IPV4}"
    printf "    Note:              cloud-init already ran on first provision. If the runtime\n"
    printf "                       is not live, SSH in and inspect /var/log/openclaw-bootstrap.log.\n"
else
    log "Provisioning ${BUNDLE_ID} instance in ${AVAILABILITY_ZONE} (${INSTANCE_NAME})"
    ls_cli create-instances \
        --instance-names "${INSTANCE_NAME}" \
        --availability-zone "${AVAILABILITY_ZONE}" \
        --blueprint-id "${BLUEPRINT_ID}" \
        --bundle-id "${BUNDLE_ID}" \
        --user-data "${USER_DATA}" \
        --tags 'key=managed-by,value=openclaw-managed-agents' >/dev/null

    # Wait for Lightsail to finish provisioning the instance. Poll state until
    # it's "running", which means the VM is up and cloud-init has started.
    log "Waiting for Lightsail to bring the instance to running state"
    for i in $(seq 1 60); do
        STATE="$(ls_cli get-instance --instance-name "${INSTANCE_NAME}" 2>/dev/null | jq -r '.instance.state.name' 2>/dev/null || echo "unknown")"
        if [[ "${STATE}" == "running" ]]; then
            printf "    state:             running (after %d probes)\n" "${i}"
            break
        fi
        sleep 5
        if [[ "${i}" -eq 60 ]]; then
            die "Instance did not reach running state within 5 minutes (last state: ${STATE})"
        fi
    done

    SERVER_IPV4="$(ls_cli get-instance --instance-name "${INSTANCE_NAME}" | jq -r '.instance.publicIpAddress')"
    printf "    IPv4:              %s\n" "${SERVER_IPV4}"
fi

# ------------------------------------------------------------------------------
# Open port 8080 (orchestrator)
# ------------------------------------------------------------------------------
#
# put-instance-public-ports REPLACES the entire port list, so we include
# port 22 (default SSH, break-glass only) alongside 8080. Routine operator
# interaction is via the HTTP API on 8080; SSH is not part of the managed
# UX and should only be used when the VM itself is wedged.

log "Opening ports 22 (break-glass SSH), ${ORCH_PORT} (orchestrator)"
ls_cli put-instance-public-ports \
    --instance-name "${INSTANCE_NAME}" \
    --port-infos \
        'fromPort=22,toPort=22,protocol=tcp' \
        "fromPort=${ORCH_PORT},toPort=${ORCH_PORT},protocol=tcp" >/dev/null

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
    printf "    Monthly cost:      ~\$24 (medium_3_0 bundle: 2 vCPU / 4 GB / 80 GB / 4 TB egress)\n"
    printf "                       Override LIGHTSAIL_BUNDLE_ID=small_3_0 for \$12/mo (2 GB)\n"
    printf "    Destroy with:      ./scripts/deploy-aws-lightsail.sh --destroy\n"
    printf "    SSH (port 22):     ssh ubuntu@%s\n" "${SERVER_IPV4}"
    printf "    Tail bootstrap:    ssh ubuntu@%s 'sudo tail -f /var/log/openclaw-bootstrap.log'\n" "${SERVER_IPV4}"
else
    err "Orchestrator did not become reachable at ${ORCH_URL}/healthz after 10 minutes."
    err "Debug: ssh ubuntu@${SERVER_IPV4} 'sudo tail -f /var/log/openclaw-bootstrap.log'"
    exit 1
fi
