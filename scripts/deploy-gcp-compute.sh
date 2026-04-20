#!/usr/bin/env bash
#
# deploy-gcp-compute.sh — one-command deploy of the OpenClaw Managed Agents
# to a Google Cloud Compute Engine instance. Idempotent: re-running reuses
# the existing instance if present.
#
# Usage:
#     gcloud auth login                                # once per machine
#     gcloud config set project <your-project-id>      # once per machine
#     export MOONSHOT_API_KEY=sk-...                   # or ANTHROPIC_API_KEY / OPENAI_API_KEY / etc.
#     ./scripts/deploy-gcp-compute.sh                  # provision + bring up
#     ./scripts/deploy-gcp-compute.sh --destroy        # tear down
#
# Environment variables (all optional except gcloud auth + a provider key):
#     GCE_INSTANCE_NAME=openclaw-managed-agents        # run multiple deploys by setting different names
#     GCE_REGION=us-central1                           # us-central1 | us-east1 | us-west1 | europe-west1 | asia-northeast1 | etc.
#     GCE_ZONE=us-central1-a                           # must match region (region + a/b/c)
#     GCE_MACHINE_TYPE=e2-medium                       # e2-micro ($0 free tier) | e2-small ($13/mo) | e2-medium ($25/mo default) | e2-standard-2 ($49/mo)
#     GCE_IMAGE_FAMILY=ubuntu-2404-lts-amd64           # image family in project ubuntu-os-cloud
#     GCE_IMAGE_PROJECT=ubuntu-os-cloud
#     GCE_DISK_SIZE_GB=20                              # boot disk size (min 10; e2-micro free-tier eligible up to 30 GB)
#     GCE_SSH_USER=ubuntu                              # username injected with your SSH key
#     GCE_NETWORK=default                              # VPC network (default created automatically per project)
#     OPENCLAW_DEPLOY_BRANCH=main                      # git branch to clone on the instance
#     OPENCLAW_DEPLOY_REPO=https://github.com/stainlu/openclaw-managed-agents.git
#
# See docs/deploying-on-gcp-compute.md for the full walkthrough.

set -euo pipefail

# ------------------------------------------------------------------------------
# Configuration (with overridable defaults)
# ------------------------------------------------------------------------------

INSTANCE_NAME="${GCE_INSTANCE_NAME:-openclaw-managed-agents}"
REGION="${GCE_REGION:-us-central1}"
ZONE="${GCE_ZONE:-${REGION}-a}"
MACHINE_TYPE="${GCE_MACHINE_TYPE:-e2-medium}"
IMAGE_FAMILY="${GCE_IMAGE_FAMILY:-ubuntu-2404-lts-amd64}"
IMAGE_PROJECT="${GCE_IMAGE_PROJECT:-ubuntu-os-cloud}"
DISK_SIZE_GB="${GCE_DISK_SIZE_GB:-20}"
SSH_USER="${GCE_SSH_USER:-ubuntu}"
NETWORK="${GCE_NETWORK:-default}"
REPO_URL="${OPENCLAW_DEPLOY_REPO:-https://github.com/stainlu/openclaw-managed-agents.git}"
REPO_BRANCH="${OPENCLAW_DEPLOY_BRANCH:-main}"
ORCH_PORT=8080
FIREWALL_RULE_ORCH="${INSTANCE_NAME}-allow-orchestrator"
INSTANCE_TAG="${INSTANCE_NAME}"

# Known provider-key env vars that the runtime forwards to agent containers.
# The first one set in the local environment is written into the instance's .env.
# Must match the PROVIDER_KEY_NAMES list in scripts/deploy-aws-lightsail.sh and
# scripts/deploy-hetzner.sh so cross-backend behavior stays identical.
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
DEFAULT_TEST_MODEL="${OPENCLAW_TEST_MODEL:-moonshot/kimi-k2.5}"

# ------------------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------------------

log() { printf "==> %s\n" "$*"; }
err() { printf "error: %s\n" "$*" >&2; }
die() { err "$*"; exit 1; }

# Shortcut for gcloud compute with zone/project pinned. `gcloud` reads the
# active project from `gcloud config get-value project`.
gce() { gcloud compute "$@"; }

# ------------------------------------------------------------------------------
# Teardown path
# ------------------------------------------------------------------------------

if [[ "${1:-}" == "--destroy" ]]; then
    log "Destroying ${INSTANCE_NAME} in ${ZONE}"
    command -v gcloud >/dev/null 2>&1 || die "gcloud CLI not found"

    if gce instances describe "${INSTANCE_NAME}" --zone "${ZONE}" >/dev/null 2>&1; then
        gce instances delete "${INSTANCE_NAME}" --zone "${ZONE}" --quiet >/dev/null
        log "Instance ${INSTANCE_NAME} deleted."
    else
        log "Instance ${INSTANCE_NAME} not found — nothing to destroy."
    fi

    if gce firewall-rules describe "${FIREWALL_RULE_ORCH}" >/dev/null 2>&1; then
        gce firewall-rules delete "${FIREWALL_RULE_ORCH}" --quiet >/dev/null
        log "Firewall rule ${FIREWALL_RULE_ORCH} deleted."
    else
        log "Firewall rule ${FIREWALL_RULE_ORCH} not found — nothing to destroy."
    fi
    exit 0
fi

# ------------------------------------------------------------------------------
# Preflight checks
# ------------------------------------------------------------------------------

log "Checking prerequisites"

command -v gcloud >/dev/null 2>&1 || die "gcloud CLI not found. Install: brew install --cask google-cloud-sdk (macOS), or see https://cloud.google.com/sdk/docs/install"
printf "    gcloud CLI:        ok (%s)\n" "$(gcloud version 2>&1 | head -n 1)"

# Verify the user is authenticated. A fresh laptop after install gcloud has no
# active account until `gcloud auth login` runs.
ACTIVE_ACCOUNT="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null | head -n 1)"
if [[ -z "${ACTIVE_ACCOUNT}" ]]; then
    err "No active gcloud account. Run: gcloud auth login"
    exit 1
fi
printf "    gcloud account:    %s\n" "${ACTIVE_ACCOUNT}"

# Verify a project is selected. Without it, gcloud compute commands fail
# with a confusing "No project specified" message.
PROJECT_ID="$(gcloud config get-value project 2>/dev/null || true)"
if [[ -z "${PROJECT_ID}" || "${PROJECT_ID}" == "(unset)" ]]; then
    err "No gcloud project configured. Run: gcloud config set project <your-project-id>"
    err "List your projects: gcloud projects list"
    exit 1
fi
printf "    gcloud project:    %s\n" "${PROJECT_ID}"
printf "    Region:            %s\n" "${REGION}"
printf "    Zone:              %s\n" "${ZONE}"

# Verify the Compute Engine API is enabled for this project. First-time users
# of a fresh project hit this — enablement takes ~30 s.
if ! gcloud services list --enabled --filter='config.name=compute.googleapis.com' --format='value(config.name)' 2>/dev/null | grep -q compute.googleapis.com; then
    err "Compute Engine API is not enabled for project ${PROJECT_ID}."
    err "Enable it with: gcloud services enable compute.googleapis.com"
    err "Or visit:       https://console.cloud.google.com/apis/library/compute.googleapis.com?project=${PROJECT_ID}"
    exit 1
fi
printf "    Compute API:       enabled\n"

# Find the user's default SSH public key. GCE supports injecting SSH keys via
# instance metadata (format: "<username>:<pubkey-content>"); that's simpler and
# more auditable than OS Login for a single-operator deploy.
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
printf "    Machine type:      %s\n" "${MACHINE_TYPE}"
printf "    Image:             %s (%s)\n" "${IMAGE_FAMILY}" "${IMAGE_PROJECT}"
printf "    Boot disk:         %s GB\n" "${DISK_SIZE_GB}"

# ------------------------------------------------------------------------------
# Render the startup script (pure shell, no command substitutions)
# ------------------------------------------------------------------------------
#
# GCE runs the `startup-script` metadata value as root on first boot via
# google-startup-scripts.service. Stdout/stderr go to the serial console and
# /var/log/google-startup-scripts.log. Pure shell — same shape as the
# Lightsail deploy (not cloud-config YAML) for consistency and to avoid any
# interpretation ambiguity. No command substitutions inside the heredoc: the
# outer bash (on the operator's machine) would try to evaluate them before
# the string reaches GCE.

log "Rendering startup-script (pure shell)"

STARTUP_SCRIPT="$(cat <<USERDATA
#!/bin/bash
set -eux

# --- Startup logging ---
# The google-startup-scripts.service already tees stdout/stderr to
# /var/log/google-startup-scripts.log. Tee again to a short-named file so
# the operator can SSH in and read it without knowing the google path.
exec > >(tee -a /var/log/openclaw-bootstrap.log) 2>&1

# --- Ensure the target SSH user exists (GCE images start with no default user) ---
if ! id -u '${SSH_USER}' >/dev/null 2>&1; then
    useradd -m -s /bin/bash '${SSH_USER}'
    usermod -aG sudo '${SSH_USER}' || true
    echo '${SSH_USER} ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/90-${SSH_USER}
    chmod 0440 /etc/sudoers.d/90-${SSH_USER}
fi

# --- Add the operator's SSH public key to the user's authorized_keys ---
install -o '${SSH_USER}' -g '${SSH_USER}' -m 0700 -d /home/${SSH_USER}/.ssh
printf '%s\\n' '${SSH_PUBKEY_CONTENT}' >> /home/${SSH_USER}/.ssh/authorized_keys
chown ${SSH_USER}:${SSH_USER} /home/${SSH_USER}/.ssh/authorized_keys
chmod 0600 /home/${SSH_USER}/.ssh/authorized_keys

# --- Install baseline packages ---
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y apt-transport-https ca-certificates curl git gnupg jq lsb-release

# --- Install Docker from the official Docker apt repo ---
# Hardcoded amd64 + noble because GCE ubuntu-2404-lts-amd64 is always x86 + noble.
# Avoiding \$(dpkg --print-architecture) here because it breaks the outer
# heredoc render on the operator's machine.
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
printf '%s=%s\\nOPENCLAW_TEST_MODEL=%s\\nOPENCLAW_MAX_WARM_CONTAINERS=3\\n' '${PROVIDER_KEY_NAME}' '${PROVIDER_KEY_VALUE}' '${DEFAULT_TEST_MODEL}' > .env

# --- Pull pre-built multi-arch images from GHCR and bring up the stack.
# Skipping --build cuts deploy time from ~12 min (build-from-source) to
# ~2 min on GCE e2-medium. Local disk on GCE is SSD PD, much faster than
# Lightsail's burstable EBS, so first-turn cold spawn is comparable to
# Hetzner's ~78 s rather than Lightsail's ~294 s. ---
docker compose pull
docker compose up -d
echo "startup-script bootstrap complete" > /var/log/openclaw-ready.log
USERDATA
)"

# ------------------------------------------------------------------------------
# Provision (or reuse) the instance
# ------------------------------------------------------------------------------

# Write startup-script to a tmp file. Passing huge strings via --metadata is
# fragile on macOS because argv has a 256 KB cap; --metadata-from-file is the
# documented path for anything over a few KB.
STARTUP_FILE="$(mktemp -t openclaw-gce-startup.XXXXXX.sh)"
trap 'rm -f "${STARTUP_FILE}"' EXIT
printf '%s' "${STARTUP_SCRIPT}" > "${STARTUP_FILE}"

# Also write the ssh-keys metadata to a tmp file. The format GCE expects is
# "<username>:<pubkey-with-comment>" — Google's guest agent parses this at
# boot and places the key in the matching user's authorized_keys. Belt-and-
# suspenders: the startup script also writes the key directly, so if the
# guest agent is slow, SSH still works.
SSH_KEYS_FILE="$(mktemp -t openclaw-gce-ssh-keys.XXXXXX)"
trap 'rm -f "${STARTUP_FILE}" "${SSH_KEYS_FILE}"' EXIT
printf '%s:%s\n' "${SSH_USER}" "${SSH_PUBKEY_CONTENT}" > "${SSH_KEYS_FILE}"

if gce instances describe "${INSTANCE_NAME}" --zone "${ZONE}" >/dev/null 2>&1; then
    log "Instance ${INSTANCE_NAME} already exists — reusing"
    SERVER_IPV4="$(gce instances describe "${INSTANCE_NAME}" --zone "${ZONE}" --format='value(networkInterfaces[0].accessConfigs[0].natIP)')"
    printf "    IPv4:              %s\n" "${SERVER_IPV4}"
    printf "    Note:              startup-script already ran on first provision. If the runtime\n"
    printf "                       is not live, SSH in and inspect /var/log/openclaw-bootstrap.log.\n"
else
    log "Provisioning ${MACHINE_TYPE} instance in ${ZONE} (${INSTANCE_NAME})"
    gce instances create "${INSTANCE_NAME}" \
        --zone "${ZONE}" \
        --machine-type "${MACHINE_TYPE}" \
        --image-family "${IMAGE_FAMILY}" \
        --image-project "${IMAGE_PROJECT}" \
        --boot-disk-size "${DISK_SIZE_GB}GB" \
        --boot-disk-type pd-balanced \
        --network "${NETWORK}" \
        --tags "${INSTANCE_TAG}" \
        --metadata-from-file "startup-script=${STARTUP_FILE},ssh-keys=${SSH_KEYS_FILE}" \
        --labels "managed-by=openclaw-managed-agents" \
        --quiet >/dev/null

    # The instance is reachable immediately after `create` returns, but the
    # startup-script runs asynchronously. We'll poll /healthz below.
    SERVER_IPV4="$(gce instances describe "${INSTANCE_NAME}" --zone "${ZONE}" --format='value(networkInterfaces[0].accessConfigs[0].natIP)')"
    printf "    IPv4:              %s\n" "${SERVER_IPV4}"
fi

# ------------------------------------------------------------------------------
# Open port 8080 via a tag-scoped firewall rule
# ------------------------------------------------------------------------------
#
# Port 22 is already open on the default network for all GCE instances (via
# `default-allow-ssh`). We only need to open 8080. Scope the rule to the
# instance's tag so it doesn't accidentally expose unrelated instances in
# the project.

log "Opening port ${ORCH_PORT} (firewall rule: ${FIREWALL_RULE_ORCH})"
if gce firewall-rules describe "${FIREWALL_RULE_ORCH}" >/dev/null 2>&1; then
    printf "    %-18s already exists, reusing.\n" "firewall rule:"
else
    gce firewall-rules create "${FIREWALL_RULE_ORCH}" \
        --network "${NETWORK}" \
        --allow "tcp:${ORCH_PORT}" \
        --source-ranges '0.0.0.0/0' \
        --target-tags "${INSTANCE_TAG}" \
        --description 'Allow public access to OpenClaw Managed Agents orchestrator HTTP API' \
        --quiet >/dev/null
    printf "    %-18s created.\n" "firewall rule:"
fi

# ------------------------------------------------------------------------------
# Wait for the orchestrator to be reachable from the public IP
# ------------------------------------------------------------------------------

log "Waiting for startup-script to install Docker + bring up the stack (~3 min)"
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
    case "${MACHINE_TYPE}" in
        e2-micro)
            printf "    Monthly cost:      ~\$0 in us-east1, us-central1, us-west1 (free tier: 1 e2-micro + 30 GB PD + 1 GB egress/month)\n"
            printf "                       Outside those regions: ~\$7/mo\n"
            ;;
        e2-small)
            printf "    Monthly cost:      ~\$13 (e2-small: 0.5 vCPU burstable / 2 GB / 20 GB PD)\n"
            printf "                       Free-tier-eligible egress: 1 GB/mo; beyond that \$0.12/GB to internet in NA/EU\n"
            ;;
        e2-medium)
            printf "    Monthly cost:      ~\$25 (e2-medium: 1 vCPU burstable / 4 GB / %s GB PD) — matches Hetzner CAX11 + Lightsail medium_3_0\n" "${DISK_SIZE_GB}"
            printf "                       Override GCE_MACHINE_TYPE=e2-small for ~\$13/mo (2 GB), or e2-micro for free-tier eligibility\n"
            ;;
        *)
            printf "    Monthly cost:      see https://cloud.google.com/compute/pricing for %s in %s\n" "${MACHINE_TYPE}" "${REGION}"
            ;;
    esac
    printf "    Destroy with:      ./scripts/deploy-gcp-compute.sh --destroy\n"
    printf "    SSH:               gcloud compute ssh %s@%s --zone %s\n" "${SSH_USER}" "${INSTANCE_NAME}" "${ZONE}"
    printf "                       # or directly: ssh %s@%s\n" "${SSH_USER}" "${SERVER_IPV4}"
    printf "    Tail bootstrap:    gcloud compute ssh %s@%s --zone %s --command 'sudo tail -f /var/log/openclaw-bootstrap.log'\n" "${SSH_USER}" "${INSTANCE_NAME}" "${ZONE}"
else
    err "Orchestrator did not become reachable at ${ORCH_URL}/healthz after 10 minutes."
    err "Debug: gcloud compute ssh ${SSH_USER}@${INSTANCE_NAME} --zone ${ZONE} --command 'sudo tail -f /var/log/openclaw-bootstrap.log'"
    err "Or view the serial console: gcloud compute instances get-serial-port-output ${INSTANCE_NAME} --zone ${ZONE}"
    exit 1
fi
