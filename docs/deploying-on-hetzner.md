# Deploying on Hetzner Cloud

Run a full OpenClaw Managed Agents on a **€3.99/month** Hetzner CAX11 (ARM Ampere) — the cheapest credible production backend for the runtime. One command, about 6 minutes end-to-end from zero.

This is the **Item 10a proof point** for the runtime's "open and cheap" positioning: the same code you run locally also runs on a €4 VPS in a German datacenter, handling real agent sessions with real provider APIs. No AWS account. No session-hour tax. No vendor lock-in.

## What you'll get

| Property | Value |
|---|---|
| Server | Hetzner Cloud CAX11 (ARM Ampere shared) |
| vCPU / RAM / SSD | 2 vCPU ARM Ampere / 4 GB / 40 GB |
| Traffic | 20 TB/month included |
| Location options (ARM) | Nuremberg (nbg1), Falkenstein (fsn1), Helsinki (hel1) — EU only for CAX line |
| Price (April 2026, live from Hetzner API) | **€3.99/month net** (€4.35 gross with EU VAT), hourly-billed at **€0.007/hr** |
| Capacity | ~20-50 concurrent light agent sessions (Kimi K2.5, idle-heavy) |
| Per-session cost | Fractions of a cent — see "Cost breakdown" below |

**Why CAX11 specifically**: it is Hetzner's absolute cheapest production-grade shared-vCPU tier. ARM Ampere cores are the same cores that power AWS Graviton and Oracle A1 — modern, power-efficient, and tuned for server workloads. On equal specs (2 vCPU / 4 GB / 40 GB), CAX11 at €3.99/mo net is **~20% cheaper than the Intel-x86 CX23 at €4.99/mo net**, and 50% cheaper than CPX11 at €6.99/mo. Scale up the same ARM line to **CAX21** (4 vCPU / 8 GB, ~€8/mo), **CAX31** (8 vCPU / 16 GB, ~€16/mo), or **CAX41** (16 vCPU / 32 GB, ~€30/mo) if you need more concurrency — same deploy script, just override `HCLOUD_SERVER_TYPE`.

**ARM compatibility**: OpenClaw Managed Agents ships multi-arch Docker images. Node 22, better-sqlite3, OpenClaw core, and Pi all build cleanly on ARM64 Linux. If you prefer Intel x86, override `HCLOUD_SERVER_TYPE=cx23` (€4.99/mo net) — same specs, same image build path, slightly more expensive.

## Prerequisites

1. **Hetzner Cloud account.** Sign up at [console.hetzner.cloud](https://console.hetzner.cloud). Free signup, but they require a valid payment method (credit card or SEPA). New accounts typically get a small credit for testing; if not, €3.99 is the floor.
2. **hcloud CLI installed locally.** This is the official Hetzner Cloud command-line client. Install:
   ```bash
   brew install hcloud              # macOS (preferred)
   ```

   **Troubleshooting — `brew install hcloud` fails with "Connection reset by peer"?** GHCR (GitHub Container Registry, where Homebrew stores bottles) is intermittently flaky. Three fallback paths:

   ```bash
   # Option A — direct binary download, bypasses brew entirely (30 seconds, no dependencies).
   # Apple Silicon (M1/M2/M3/M4):
   curl -L https://github.com/hetznercloud/cli/releases/latest/download/hcloud-darwin-arm64.tar.gz | tar -xz
   sudo mv hcloud /usr/local/bin/
   hcloud version   # should print: hcloud 1.62.2

   # Intel Mac — use the amd64 asset instead:
   curl -L https://github.com/hetznercloud/cli/releases/latest/download/hcloud-darwin-amd64.tar.gz | tar -xz
   sudo mv hcloud /usr/local/bin/

   # Linux (amd64):
   curl -L https://github.com/hetznercloud/cli/releases/latest/download/hcloud-linux-amd64.tar.gz | tar -xz
   sudo mv hcloud /usr/local/bin/

   # Option B — bypass Homebrew's bottle API (sometimes avoids the flaky GHCR path):
   HOMEBREW_NO_INSTALL_FROM_API=1 brew install hcloud

   # Option C — go install (if you already have Go installed; no auto-updates):
   go install github.com/hetznercloud/cli/cmd/hcloud@latest
   ```

   Other platforms / package managers: [github.com/hetznercloud/cli#installation](https://github.com/hetznercloud/cli#installation).

3. **Hetzner Cloud API token.** In the web console → **your project** → **Security** → **API Tokens** → **Generate API Token**. Give it `Read & Write` permission. Copy the token — it is a long alphanumeric string (mixed case, no prefix), shown only once. Example format from Hetzner's docs: `jEheVytlAoFl7F8MqUQ7jAo2hOXASztX`.
4. **Export the token** in your shell:
   ```bash
   export HCLOUD_TOKEN=<paste-your-token-here>
   ```
   The deploy script reads `HCLOUD_TOKEN` directly; you do not need to run `hcloud context create`. Persist this in `~/.zshrc` or `~/.bashrc` if you plan to redeploy often.
5. **At least one provider API key** for an LLM OpenClaw supports:
   ```bash
   export MOONSHOT_API_KEY=sk-...   # default, cheapest non-Anthropic path
   # or: export ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, etc.
   ```
6. **SSH key.** The script uses your default SSH public key (`~/.ssh/id_ed25519.pub` or `~/.ssh/id_rsa.pub`, first match wins) to register with Hetzner and SSH into the server. If you don't have one, run `ssh-keygen -t ed25519` first.

## Quick deploy

```bash
cd openclaw-managed-agents

# One-command deploy. Idempotent — re-running reuses the existing server.
./scripts/deploy-hetzner.sh

# Optional flags (environment variables):
#   HCLOUD_SERVER_NAME=openclaw-managed-agents    # default; change to run multiple deploys
#   HCLOUD_LOCATION=nbg1                           # nbg1 | fsn1 | hel1 | ash | hil
#   HCLOUD_SERVER_TYPE=cax11                       # cax11 (ARM, default, cheapest) | cax21 | cax31 | cax41 | cx23 | cx33 (Intel x86)
#   OPENCLAW_DEPLOY_BRANCH=main                    # git branch to clone on the server
```

Expected output (timings on a fresh run, EU location):

```
==> Checking prerequisites
    hcloud CLI:        ok
    HCLOUD_TOKEN:      ok
    SSH public key:    ~/.ssh/id_ed25519.pub
    Provider key:      MOONSHOT_API_KEY
==> Registering SSH key with Hetzner project (openclaw-managed-agents-key)
==> Rendering cloud-init user-data with MOONSHOT_API_KEY
==> Provisioning cax11 server in nbg1 (openclaw-managed-agents)
    IPv4:              5.75.123.45
    IPv6:              2a01:4f8:c0c:abc::1
==> Waiting for cloud-init to install Docker + bring up the stack (~4 min)
    [+  0:20] Docker installed
    [+  2:10] Repo cloned, pnpm install done
    [+  3:45] docker compose build complete
    [+  4:30] Orchestrator reports /healthz ok
==> Deploy complete
    Orchestrator:      http://5.75.123.45:8080
    Monthly cost:      €3.99 (€0.007/hr) — EU location
    Destroy with:      hcloud server delete openclaw-managed-agents
```

## Validating the deploy

Point the existing e2e suite at the public endpoint:

```bash
export OPENCLAW_ORCHESTRATOR_URL=http://5.75.123.45:8080
./test/e2e.sh
```

Or a minimal smoke test:

```bash
# 1. Health check
curl -s http://5.75.123.45:8080/healthz
# {"ok":true,"version":"0.1.0-dev"}

# 2. Create an agent template
AGENT=$(curl -s -X POST http://5.75.123.45:8080/v1/agents \
  -H 'Content-Type: application/json' \
  -d '{"model":"moonshot/kimi-k2.5","tools":[],"instructions":"You are a research assistant."}' \
  | jq -r '.agent_id')

# 3. Open a session
SESSION=$(curl -s -X POST http://5.75.123.45:8080/v1/sessions \
  -H 'Content-Type: application/json' \
  -d "{\"agentId\":\"$AGENT\"}" | jq -r '.session_id')

# 4. Post a user message, wait, read the reply
curl -s -X POST "http://5.75.123.45:8080/v1/sessions/$SESSION/events" \
  -H 'Content-Type: application/json' \
  -d '{"content":"In one sentence, what is OpenClaw?"}'

while [ "$(curl -s http://5.75.123.45:8080/v1/sessions/$SESSION | jq -r .status)" = "running" ]; do sleep 2; done

curl -s "http://5.75.123.45:8080/v1/sessions/$SESSION/events" \
  | jq -r '[.events[]|select(.type=="agent.message")]|last|.content'
```

You should see a real Kimi K2.5 response within 30-60 seconds of the first event (first turn spawns a container; subsequent turns are fast).

## Cost breakdown

The Hetzner server cost is fixed at **€3.99/mo** regardless of session volume. What changes with load is the provider API cost, not the compute cost. Per session:

| Cost component | Amount |
|---|---|
| Hetzner CAX11 share (1 session among ~30 concurrent) | ~€0.00006/hour |
| Moonshot Kimi K2.5 tokens (~10k in, ~500 out per turn) | ~$0.005/turn |
| R/W to local SQLite + JSONL | $0 (on the 40 GB SSD) |
| Egress to Moonshot API | $0 (within Hetzner's 20 TB/mo) |

For a typical idle-heavy chat session (5 minutes of active turn time spread over 1 hour), the **Hetzner-attributable compute cost is under €0.001**, effectively free. The per-session cost is dominated by LLM tokens, which would be identical on any other backend.

Compare to Claude Managed Agents at **$0.08/hour** ($0.08/session-hour flat, plus token pass-through). For the same workload:

| Backend | Session compute cost | Session token cost (~$0.005) | Total |
|---|---|---|---|
| **Hetzner CAX11** (this guide) | ~€0.00006 (~$0.00007) | ~$0.005 | **~$0.005** |
| Claude Managed Agents | $0.08 (1 hour) | ~$0.005 | ~$0.085 |

The Hetzner path is **~17x cheaper on compute** for an idle-heavy chat workload. For continuously-active workloads (research/coding agents running for 30+ active minutes) the savings shrink because Claude's $0.08 is close to the physics of running a vCPU — but Hetzner is still cheaper at every workload shape.

## Tearing down

```bash
hcloud server delete openclaw-managed-agents
# Or: ./scripts/deploy-hetzner.sh --destroy
```

Hetzner bills hourly — if you destroy the server after 1 hour of testing, the total cost is about **€0.007** (less than one cent). Keep it running only as long as you need it.

## Manual deploy (if you prefer)

If you want to understand what the script does, the underlying commands are:

```bash
# 1. Register your SSH key (once per project)
hcloud ssh-key create \
  --name openclaw-managed-agents-key \
  --public-key-from-file ~/.ssh/id_ed25519.pub

# 2. Provision the server with cloud-init user-data
hcloud server create \
  --name openclaw-managed-agents \
  --type cax11 \
  --image ubuntu-24.04 \
  --location nbg1 \
  --ssh-key openclaw-managed-agents-key \
  --user-data-from-file ./scripts/hetzner-cloud-init.yaml

# 3. Grab the IP
IP=$(hcloud server describe openclaw-managed-agents -o json | jq -r .public_net.ipv4.ip)

# 4. Wait for cloud-init to finish Docker install + docker compose up
while ! curl -sf "http://${IP}:8080/healthz" >/dev/null; do sleep 5; done

echo "Orchestrator ready on http://${IP}:8080"
```

The cloud-init user-data (generated at deploy time by the script) installs Docker via the official Docker repo, clones this repo onto `/opt/openclaw`, writes a `.env` file with your provider key, and runs `docker compose up -d --build`.

## What's next — more backends

Item 10a (this guide) is the geeky-cheap proof point. Upcoming backends extend the story without replacing it:

- **Item 10b — Cloudflare Containers** (GA'd April 13, 2026). Edge-distributed across 330+ cities, $5/mo base includes substantial usage, ~200 ms cold start. **First managed agent runtime on Cloudflare Containers.**
- **Item 10c — Google Cloud Run.** Serverless, scale-to-zero, ~$0.009 per active turn. Google Cloud partnership hook.
- **Item 10d — AWS Fargate.** Always-on, ~$0.035/hr. AWS partnership hook + Bedrock model access.
- **Item 10e — Azure Container Apps.** Similar cost shape to Cloud Run. Azure partnership hook.

Each new backend is a drop-in `ContainerRuntime` adapter in `src/runtime/` — no orchestrator core changes. See [docs/architecture.md](./architecture.md) for the interface.

## Security notes

- **API key in cloud-init.** The provider API key (e.g., `MOONSHOT_API_KEY`) is written to `/opt/openclaw/.env` via cloud-init user-data. This means the key is visible in Hetzner's cloud-init logs and in `/var/log/cloud-init-output.log` on the server. Acceptable for a proof point; for production, use a secrets manager and swap the `.env` file for a pull at container start.
- **Firewall.** The default Hetzner server has no firewall rules; port 8080 is publicly reachable. For production, add a Hetzner Cloud Firewall or use `ufw` to restrict to your known client IPs. Or put the orchestrator behind a Cloudflare Tunnel — no ports exposed, authenticated access only.
- **No TLS by default.** The quick deploy exposes HTTP on port 8080 without a certificate. For any external access, terminate TLS at a reverse proxy (Caddy, Traefik, Nginx) or front it with Cloudflare. A Caddy sidecar with `--tls your-domain.example.com` is the simplest option.
- **Single VPS = no HA.** If the CAX11 dies, all in-flight sessions fail and the orchestrator restarts. Hetzner's API-level restart is fast (~30 s) but there is no automatic failover. For HA, run two VPSes behind a Hetzner Load Balancer (€5.39/mo) with shared session storage — or wait for Item 10b (Cloudflare Containers) which handles this transparently.
