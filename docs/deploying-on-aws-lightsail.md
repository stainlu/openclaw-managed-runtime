# Deploying on AWS Lightsail

Run the OpenClaw Managed Agents on an **AWS Lightsail** instance for **$5–$24/month** — AWS's own "cheap VPS with Docker" product, priced as a fixed monthly bundle and designed for exactly the workloads that Item 10a proved on Hetzner. One command, about 6 minutes end-to-end from zero.

This is the **Item 10b deploy target**. It uses the same `DockerContainerRuntime` the Hetzner path uses, so the runtime behavior is identical — you're only switching the underlying VPS provider. If you already know `scripts/deploy-hetzner.sh`, this script is a one-for-one mirror with the AWS CLI instead of the Hetzner CLI.

## What you'll get

| Property | Default (`medium_3_0`) | Cheapest credible (`small_3_0`) |
|---|---|---|
| Product | Amazon Lightsail Linux instance | Same |
| vCPU / RAM / SSD | 2 / 4 GB / 80 GB | 2 / 2 GB / 60 GB |
| Included data transfer | 4 TB/month | 3 TB/month |
| Blueprint | Ubuntu 24.04 | Ubuntu 24.04 |
| IP addressing | Public IPv4 + IPv6 | Public IPv4 + IPv6 |
| Monthly price (April 2026) | **$24/month** | **$12/month** |
| Concurrent agent capacity | ~5-7 sessions | ~2-4 sessions |

**Why `medium_3_0` as the default.** It matches the Hetzner CAX11 specs (2 vCPU / 4 GB / 80 GB) so the capacity math carries across — roughly 5-7 concurrent active agent sessions per instance at ~458 MiB RAM per container. The `small_3_0` bundle at $12/month holds 2-4 concurrent sessions and is a reasonable fallback if you're cost-sensitive and don't need the headroom. The smaller `nano_3_0` ($5/month, 0.5 GB RAM) and `micro_3_0` ($7/month, 1 GB RAM) bundles are **not enough RAM** to run an agent container alongside the orchestrator reliably; don't pick them.

**Why Lightsail and not EC2.** EC2 is more flexible (custom VPCs, security groups, spot pricing, larger instance families) but adds operational surface — IAM roles, VPC + subnet configuration, security group rules, Elastic IPs. Lightsail is AWS's "simple fixed-price VPS" product that bundles all of that behind a single `aws lightsail create-instances` call. For our "drop a Docker Compose stack on a VPS" shape, Lightsail is the right tool. If you need EC2's flexibility (spot pricing, custom VPC, ARM Graviton at discount), we'll ship a separate `scripts/deploy-aws-ec2.sh` as a follow-up; for now Lightsail is the Item 10b path.

## Prerequisites

1. **AWS account.** Sign up at [aws.amazon.com](https://aws.amazon.com). Free tier covers some Lightsail bundles for the first month — read the current free-tier terms at [aws.amazon.com/free](https://aws.amazon.com/free/). At our test volume, a `medium_3_0` bundle for 1 hour of testing costs less than **$0.05**.

2. **AWS CLI installed locally.**
   ```bash
   brew install awscli              # macOS
   # or: curl "https://awscli.amazonaws.com/AWSCLIV2.pkg" -o /tmp/awscli.pkg && sudo installer -pkg /tmp/awscli.pkg -target /
   # or: see https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html for other platforms
   aws --version                    # should print something like "aws-cli/2.17.x"
   ```

3. **AWS credentials configured.** Either set environment variables OR run `aws configure`:
   ```bash
   # Option A: environment variables (simpler for a one-off deploy)
   export AWS_ACCESS_KEY_ID=AKIA...
   export AWS_SECRET_ACCESS_KEY=...
   export AWS_DEFAULT_REGION=us-east-1

   # Option B: aws configure (stores in ~/.aws/credentials)
   aws configure
   ```
   Generate an access key at [IAM → Users → your-user → Security credentials → Create access key](https://console.aws.amazon.com/iam/home#/users). **Treat the secret access key like a password** — it has full API access to your AWS account until you revoke it.

4. **IAM permissions.** The credentials you use must have Lightsail access. The simplest policy is the AWS-managed `AmazonLightsailFullAccess`. If you want tighter scope, the minimum actions are:
   - `lightsail:CreateInstances`
   - `lightsail:DeleteInstance`
   - `lightsail:GetInstance`
   - `lightsail:PutInstancePublicPorts`
   - `lightsail:GetBundles` (optional, for discovery)
   - `lightsail:GetBlueprints` (optional, for discovery)
   - `sts:GetCallerIdentity` (for the preflight check)

5. **Verify credentials work:**
   ```bash
   aws sts get-caller-identity
   # Should print your AWS account ID + IAM principal ARN.
   ```

6. **At least one provider API key** for an LLM OpenClaw supports:
   ```bash
   export MOONSHOT_API_KEY=sk-...   # default, cheapest non-Anthropic path
   # or: export ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, etc.
   ```

7. **SSH key.** The script uses your default SSH public key (`~/.ssh/id_ed25519.pub` or `~/.ssh/id_rsa.pub`, first match wins) and injects it into the instance's `authorized_keys` via cloud-init. If you don't have one, run `ssh-keygen -t ed25519` first. **This sidesteps Lightsail's native key-pair model entirely** — you don't need to manage a Lightsail key pair or download a `.pem` file.

## Quick deploy

```bash
cd openclaw-managed-agents

# One-command deploy. Idempotent — re-running reuses the existing instance.
./scripts/deploy-aws-lightsail.sh

# Optional flags (environment variables):
#   LIGHTSAIL_INSTANCE_NAME=openclaw-managed-agents  # default; change to run multiple deploys
#   LIGHTSAIL_REGION=us-east-1                        # us-east-1 | us-east-2 | eu-west-1 | eu-central-1 | ap-northeast-1 | ...
#   LIGHTSAIL_AVAILABILITY_ZONE=us-east-1a            # must match region (append a/b/c to region)
#   LIGHTSAIL_BUNDLE_ID=medium_3_0                    # nano_3_0 ($5) | micro_3_0 ($7) | small_3_0 ($12, 2GB) | medium_3_0 ($24, 4GB) | large_3_0 ($44, 8GB)
#   LIGHTSAIL_BLUEPRINT_ID=ubuntu_24_04
#   OPENCLAW_DEPLOY_BRANCH=main                       # git branch to clone on the instance
```

Expected output (timings on a fresh run, `us-east-1`, `medium_3_0`):

```
==> Checking prerequisites
    aws CLI:           ok
    AWS credentials:   ok (arn:aws:iam::123456789012:user/stainlu)
    Region:            us-east-1
    Availability zone: us-east-1a
    SSH public key:    /Users/stainlu/.ssh/id_ed25519.pub
    Provider key:      MOONSHOT_API_KEY
    Test model:        moonshot/kimi-k2.5
    Bundle:            medium_3_0
    Blueprint:         ubuntu_24_04
==> Rendering cloud-init user-data with MOONSHOT_API_KEY
==> Provisioning medium_3_0 instance in us-east-1a (openclaw-managed-agents)
==> Waiting for Lightsail to bring the instance to running state
    state:             running (after 6 probes)
    IPv4:              54.196.x.x
==> Opening ports 22, 222, 8080
==> Waiting for cloud-init to install Docker + bring up the stack (~4 min)
    [+ 15 s] waiting for http://54.196.x.x:8080/healthz
    [+120 s] waiting for http://54.196.x.x:8080/healthz
    [+240 s] waiting for http://54.196.x.x:8080/healthz
==> Deploy complete
    Orchestrator:      http://54.196.x.x:8080
    Monthly cost:      ~$24 (medium_3_0 bundle: 2 vCPU / 4 GB / 80 GB / 4 TB egress)
                       Override LIGHTSAIL_BUNDLE_ID=small_3_0 for $12/mo (2 GB)
    Destroy with:      ./scripts/deploy-aws-lightsail.sh --destroy
    SSH (port 22):     ssh ubuntu@54.196.x.x
    SSH (port 222):    ssh -p 222 ubuntu@54.196.x.x
    Tail bootstrap:    ssh ubuntu@54.196.x.x 'sudo tail -f /var/log/openclaw-bootstrap.log'
```

## Validating the deploy

Point the existing e2e suite at the public endpoint:

```bash
export OPENCLAW_ORCHESTRATOR_URL=http://54.196.x.x:8080
./test/e2e.sh
```

Or a minimal smoke test:

```bash
ORCH=http://54.196.x.x:8080

# 1. Health check
curl -s $ORCH/healthz
# {"ok":true,"version":"0.1.0-dev"}

# 2. Create an agent template
AGENT=$(curl -s -X POST $ORCH/v1/agents -H 'Content-Type: application/json' \
  -d '{"model":"moonshot/kimi-k2.5","tools":[],"instructions":"One-sentence answers."}' \
  | jq -r '.agent_id')

# 3. Open a session
SESSION=$(curl -s -X POST $ORCH/v1/sessions -H 'Content-Type: application/json' \
  -d "{\"agentId\":\"$AGENT\"}" | jq -r '.session_id')

# 4. Post a user message
curl -s -X POST "$ORCH/v1/sessions/$SESSION/events" \
  -H 'Content-Type: application/json' \
  -d '{"content":"In one sentence, what is 2+2?"}'

# 5. Wait and read the reply
while [ "$(curl -s $ORCH/v1/sessions/$SESSION | jq -r .status)" = "running" ]; do sleep 2; done
curl -s "$ORCH/v1/sessions/$SESSION/events" \
  | jq -r '[.events[]|select(.type=="agent.message")]|last|.content'
```

## Measured performance (live on 2026-04-16)

| Metric | `medium_3_0` bundle | Hetzner CAX11 (comparison) |
|---|---|---|
| **End-to-end deploy time** (fresh instance → /healthz OK) | **~5 min** | ~4 min |
| **Turn 1 cold spawn** (agent container + Pi SessionManager boot) | **294 s** (~5 min) | **78 s** |
| **Turn 2 pool reuse** (session already spawned) | **5 s** | **4 s** |
| RAM per agent container | ~458 MiB | ~458 MiB |
| Concurrent active agent sessions | ~5-7 | ~5-7 |

**Why Lightsail's first-turn is ~4× slower than Hetzner's.** `medium_3_0` runs on a shared-burstable vCPU with EBS-backed storage (~5-15 ms per I/O operation). Pi's `SessionManager` reads provider catalogs, skill manifests, and auth config from disk during boot — on Hetzner CAX11's local NVMe this completes in ~60 seconds; on Lightsail's burstable SSD it takes 3-5 minutes. Subsequent turns reuse the already-booted container from the orchestrator's session pool and complete in 4-5 seconds on both backends.

**The deploy uses pre-built images from GHCR** — `ghcr.io/stainlu/openclaw-managed-agents-{orchestrator,agent}:latest`, published by `.github/workflows/publish-images.yaml` on every push to `main`. Deploy time dropped from ~12 min (earlier build-from-source baseline) to ~5 min because `npm install -g openclaw@2026.4.11` (6.5 min of the original 12) no longer runs on the target VM. CPU burst credits also stay full for the first turn, shortening cold-spawn time as a side effect.

**The orchestrator's `OPENCLAW_READY_TIMEOUT_MS` is set to 600 seconds (10 minutes)** on every deploy specifically to accommodate Lightsail's slow first-turn. Hetzner never hits the old 120-second timeout, so the bump is free there; Lightsail needed it to avoid failing the first turn and forcing an immediate respawn.

## Cost breakdown

The Lightsail bundle cost is fixed per month regardless of how many sessions you run — you pay the same $24/month whether the instance serves 0 sessions or 500. What scales is the LLM token cost, which is billed directly by your provider (Moonshot, Anthropic, OpenAI, etc.) and is identical across every backend.

| Cost component | Amount |
|---|---|
| Lightsail `medium_3_0` share (1 session among ~5 concurrent) | ~$4.80/month allocated |
| Moonshot Kimi K2.5 tokens (~10k in, ~500 out per turn) | ~$0.005/turn |
| Data transfer to Moonshot API | Within 4 TB/month free |
| Data out to end user | Within 4 TB/month free |

For an idle-heavy chat session (5 minutes of active turn time per hour, 10 sessions per day), the Lightsail-attributable compute cost per session is well under **$0.01**. Compared to Claude Managed Agents at **$0.08/hour**, this is **~8x cheaper per session-hour** — less dramatic than the Hetzner comparison (which is ~11x cheaper), but well within "clearly cheaper than the incumbent" territory, and with the added benefit that the deploy is natively on AWS.

## Tearing down

```bash
./scripts/deploy-aws-lightsail.sh --destroy
# or: aws lightsail delete-instance --instance-name openclaw-managed-agents
```

Lightsail bills in hourly increments — if you destroy an instance after 1 hour of testing, the total cost is about **$0.035** for the `medium_3_0` bundle (or $0.017 for `small_3_0`). Keep the instance running only as long as you need it.

## Manual deploy (if you prefer)

If you want to understand what the script does, the underlying commands are:

```bash
# 1. Render the cloud-init user-data in a variable (see scripts/deploy-aws-lightsail.sh)
USER_DATA="$(cat <<CLOUDINIT
#cloud-config
ssh_authorized_keys:
  - $(cat ~/.ssh/id_ed25519.pub)
packages:
  - git
  - curl
runcmd:
  - curl -fsSL https://get.docker.com | sh
  - git clone https://github.com/stainlu/openclaw-managed-agents.git /opt/openclaw
  - cd /opt/openclaw && echo "MOONSHOT_API_KEY=$MOONSHOT_API_KEY" > .env && docker compose up -d --build
CLOUDINIT
)"

# 2. Create the instance
aws lightsail create-instances \
  --instance-names openclaw-managed-agents \
  --availability-zone us-east-1a \
  --blueprint-id ubuntu_24_04 \
  --bundle-id medium_3_0 \
  --user-data "$USER_DATA" \
  --tags 'key=managed-by,value=openclaw-managed-agents'

# 3. Wait for it to reach 'running' state
while [ "$(aws lightsail get-instance --instance-name openclaw-managed-agents --query 'instance.state.name' --output text)" != "running" ]; do
  sleep 5
done

# 4. Open port 8080 (and keep 22 open for SSH)
aws lightsail put-instance-public-ports \
  --instance-name openclaw-managed-agents \
  --port-infos 'fromPort=22,toPort=22,protocol=tcp' 'fromPort=8080,toPort=8080,protocol=tcp'

# 5. Get the public IP
IP=$(aws lightsail get-instance --instance-name openclaw-managed-agents --query 'instance.publicIpAddress' --output text)

# 6. Wait for the orchestrator healthz
while ! curl -sf "http://${IP}:8080/healthz" >/dev/null; do sleep 5; done

echo "Orchestrator ready on http://${IP}:8080"
```

The `scripts/deploy-aws-lightsail.sh` wrapper adds preflight checks, SSH fallback on port 222, idempotent re-runs, and a `--destroy` flag — but the core flow is the six steps above.

## What's next — more backends

Item 10b (this guide) is the AWS path. Upcoming Item 10 backends extend the story without replacing it:

- **Item 10c — Google Cloud Compute Engine.** Targets `e2-small` / `e2-medium` via `gcloud compute instances create`. Same pattern.
- **Item 10d — Azure Virtual Machines.** Targets `B2s` via `az vm create`. Same pattern. Azure partnership hook.
- **Item 10e — DigitalOcean / Linode / Vultr / Oracle Cloud free tier.** One deploy script per provider, all at $0-$13/month. Oracle's Always-Free A1 tier gives 4 vCPU + 24 GB RAM for **$0 forever** (signup is the hard part).
- **Item 10f+ — Optional serverless integrations** (Cloud Run, Fargate, Cloudflare Containers) — deferred, partnership-driven only. See [`docs/cloud-backends.md`](./cloud-backends.md) for the architectural decision record on why serverless containers are the wrong default for our workload.

Each new backend is a ~300-line sibling of this script. No orchestrator core changes. All of them run the same `DockerContainerRuntime` you're running locally with `docker compose up`.

## Security notes

- **API key in cloud-init user-data.** The provider API key (e.g., `MOONSHOT_API_KEY`) is written to `/opt/openclaw/.env` via cloud-init. The user-data is visible via `aws lightsail get-instance --include-details` and in the instance's `/var/log/cloud-init-output.log`. Acceptable for a proof point; for production, use AWS Secrets Manager and pull the key at container start.
- **Public ingress on port 8080.** The orchestrator is reachable from the public internet. The existing `OPENCLAW_GATEWAY_TOKEN` Bearer auth is the only gate in the default setup. For production, either (a) restrict the Lightsail firewall to specific source IPs via `aws lightsail put-instance-public-ports` with a `cidrs` field, (b) front with a Cloudflare Tunnel (no ports exposed), or (c) put the orchestrator behind an Application Load Balancer with IAM authorization.
- **No TLS by default.** The quick deploy exposes HTTP on port 8080 without a certificate. For any real access, terminate TLS at a reverse proxy (Caddy is simplest) or front with Cloudflare. A Caddy sidecar with `--tls your-domain.example.com` is the two-line fix.
- **Single instance = no HA.** If the Lightsail instance dies, all in-flight sessions fail and the orchestrator restarts. Lightsail's instance uptime SLA is best-effort. For HA, run two instances behind a Lightsail Load Balancer (~$18/month) with shared session state on S3 — Item 11 territory, not shipped today.
- **IAM credentials on your laptop.** The access key pair you configured with `aws configure` has full Lightsail API access to your account. **Rotate the key** (delete + create new) every quarter, or use AWS SSO / IAM Identity Center for short-lived credentials.

## Troubleshooting

- **`aws sts get-caller-identity` fails with "Unable to locate credentials"**: your credentials aren't configured. Run `aws configure` and enter your access key pair, or export the env vars directly.
- **`aws lightsail create-instances` fails with "User is not authorized"**: your IAM principal doesn't have Lightsail permissions. Attach the `AmazonLightsailFullAccess` managed policy in the IAM console, or use the fine-grained list from the prereqs section.
- **Instance reaches "running" state but `/healthz` never responds**: cloud-init is still running. SSH in (`ssh ubuntu@<ip>`) and inspect `sudo tail -f /var/log/openclaw-bootstrap.log`. Most commonly this is an image-build failure (check `cd /opt/openclaw && docker compose logs`).
- **SSH to port 22 fails with "Connection closed by remote host"**: some ISPs and corporate networks block outbound SSH to port 22 on cloud provider IP ranges. The deploy script opens port 222 as a fallback — try `ssh -p 222 ubuntu@<ip>` instead.
- **Port 222 is also blocked**: this is rare but possible on heavily-filtered networks. Use AWS Systems Manager Session Manager as a last resort — it tunnels SSH over the AWS API and bypasses network-level restrictions. See [Session Manager docs](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager.html).
