#!/usr/bin/env bash
#
# OpenClaw Managed Agents — container entrypoint
#
# Reads the agent's configuration from environment variables, writes a minimal
# openclaw.json to the state directory, exports OPENCLAW_CONFIG_PATH so the CLI
# picks it up, and execs the gateway in foreground mode.
#
# Expected environment variables (all injected by the orchestrator at spawn time):
#
#   OPENCLAW_AGENT_ID      - unique agent identifier (required)
#   OPENCLAW_MODEL         - model reference, e.g. "moonshot/kimi-k2.5" (required)
#                            Format: "<provider>/<model-id>" where <provider>
#                            is any OpenClaw provider plugin id.
#   OPENCLAW_PLUGIN        - provider plugin to enable in the generated config.
#                            Must match the <provider> prefix in OPENCLAW_MODEL.
#                            (default: parsed from OPENCLAW_MODEL)
#   OPENCLAW_TOOLS         - comma-separated allowlist of skill IDs that must
#                            exist under the OpenClaw workspace (e.g. "github,notion,slack")
#                            Empty string = omit the allowlist, letting the agent
#                            fall back to agents.defaults.skills. The published
#                            openclaw npm package bundles 53 real skills — see
#                            /skills/ in openclaw/openclaw for the actual IDs.
#   OPENCLAW_INSTRUCTIONS  - system prompt override (optional)
#   OPENCLAW_STATE_DIR     - persistent volume mount (default: /workspace)
#   OPENCLAW_GATEWAY_PORT  - HTTP port (default: 18789)
#
# Session continuity is NOT carried in env vars. OpenClaw derives a stable
# session key from either the `x-openclaw-session-key` HTTP header or the
# OpenAI `user` field (see src/gateway/http-utils.ts:resolveSessionKey in the
# upstream openclaw repo). The orchestrator sets both on every internal call.
# The per-agent bind mount at OPENCLAW_STATE_DIR gives Pi's SessionManager a
# stable filesystem where it can find prior session JSONLs and resume them.
#
# Provider API keys (whichever one matches OPENCLAW_PLUGIN) must be present in
# the container environment. The orchestrator forwards them via the passthrough
# env list in src/index.ts:collectPassthroughEnv().

set -euo pipefail

: "${OPENCLAW_AGENT_ID:?OPENCLAW_AGENT_ID is required}"
: "${OPENCLAW_MODEL:?OPENCLAW_MODEL is required}"
: "${OPENCLAW_STATE_DIR:=/workspace}"
: "${OPENCLAW_GATEWAY_PORT:=18789}"
: "${OPENCLAW_TOOLS:=}"
: "${OPENCLAW_INSTRUCTIONS:=}"

# Derive the plugin id from OPENCLAW_MODEL if not explicitly set. Model format
# is "<provider>/<model-id>"; the provider half maps 1:1 to an OpenClaw plugin
# id for every first-party provider except "bedrock" which enables the
# "amazon-bedrock" plugin.
if [[ -z "${OPENCLAW_PLUGIN:-}" ]]; then
  provider_prefix="${OPENCLAW_MODEL%%/*}"
  case "${provider_prefix}" in
    bedrock) OPENCLAW_PLUGIN="amazon-bedrock" ;;
    *)       OPENCLAW_PLUGIN="${provider_prefix}" ;;
  esac
fi

# Per-container auth token. The orchestrator generates this at spawn time and
# passes it in to both secure the container and include it as a Bearer header
# on its own /v1/chat/completions calls. OpenClaw refuses to bind to non-
# loopback interfaces without shared-secret auth, and in a Docker network we
# need 0.0.0.0 binding so the orchestrator can reach us by name. See
# /src/cli/gateway-cli/run.ts:505-528 for the refuse-to-bind check.
if [[ -z "${OPENCLAW_GATEWAY_TOKEN:-}" ]]; then
  # Fallback: self-generate. Useful for standalone debugging via `docker run`.
  # In production, the orchestrator always injects the token.
  OPENCLAW_GATEWAY_TOKEN=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
  echo "[entrypoint] generated fallback gateway token: ${OPENCLAW_GATEWAY_TOKEN}"
fi
export OPENCLAW_GATEWAY_TOKEN

STATE_DIR="${OPENCLAW_STATE_DIR}"
CONFIG_PATH="${STATE_DIR}/openclaw.json"

mkdir -p "${STATE_DIR}"

# Build the tools allowlist as a JSON array. Empty → omit the field so OpenClaw
# applies its default skill policy.
tools_json_fragment() {
  if [[ -z "${OPENCLAW_TOOLS}" ]]; then
    printf '{}'
    return
  fi
  # Split on commas, trim whitespace around each entry, and hand to jq to get a
  # proper JSON array.
  echo "${OPENCLAW_TOOLS}" \
    | tr ',' '\n' \
    | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' \
    | grep -v '^$' \
    | jq -R '.' \
    | jq -s '{alsoAllow: .}'
}

TOOLS_JSON=$(tools_json_fragment)

# Build denied-tools list as a JSON array for OpenClaw's tools.deny config.
denied_tools_json_fragment() {
  if [[ -z "${OPENCLAW_DENIED_TOOLS:-}" ]]; then
    printf '[]'
    return
  fi
  echo "${OPENCLAW_DENIED_TOOLS}" \
    | tr ',' '\n' \
    | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' \
    | grep -v '^$' \
    | jq -R '.' \
    | jq -s '.'
}

DENIED_TOOLS_JSON=$(denied_tools_json_fragment)

# OpenTelemetry passthrough. When OTEL_EXPORTER_OTLP_ENDPOINT is set in
# the container env (forwarded by the orchestrator's passthrough list
# in src/index.ts:collectPassthroughEnv), populate diagnostics.otel in
# openclaw.json so openclaw's built-in OTEL exporter turns on traces +
# metrics + logs at boot. Uses the standard OTel env-var names so
# operators who already run an OTel collector can drop it in via the
# same OTEL_EXPORTER_OTLP_ENDPOINT / OTEL_EXPORTER_OTLP_HEADERS pair
# their other services use.
otel_json_fragment() {
  if [[ -z "${OTEL_EXPORTER_OTLP_ENDPOINT:-}" ]]; then
    printf 'null'
    return
  fi
  # Headers are comma-separated key=value pairs per OTel spec. Parse to
  # a JSON object; missing or empty → omit the field entirely.
  local headers_json='null'
  if [[ -n "${OTEL_EXPORTER_OTLP_HEADERS:-}" ]]; then
    headers_json=$(echo "${OTEL_EXPORTER_OTLP_HEADERS}" \
      | tr ',' '\n' \
      | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' \
      | grep -v '^$' \
      | jq -Rs 'split("\n") | map(select(length > 0) | split("=") | {(.[0]): (.[1:] | join("="))}) | add // {}')
  fi
  local protocol="${OTEL_EXPORTER_OTLP_PROTOCOL:-http/protobuf}"
  local service_name="${OTEL_SERVICE_NAME:-openclaw-agent}"
  jq -n \
    --arg endpoint "${OTEL_EXPORTER_OTLP_ENDPOINT}" \
    --arg protocol "${protocol}" \
    --arg service_name "${service_name}" \
    --argjson headers "${headers_json}" \
    --argjson sample_rate "${OPENCLAW_OTEL_SAMPLE_RATE:-1.0}" \
    --argjson flush_interval_ms "${OPENCLAW_OTEL_FLUSH_INTERVAL_MS:-5000}" '
    {
      enabled: true,
      endpoint: $endpoint,
      protocol: $protocol,
      serviceName: $service_name,
      traces: true,
      metrics: true,
      logs: true,
      sampleRate: $sample_rate,
      flushIntervalMs: $flush_interval_ms
    }
    + (if $headers != null and ($headers | length) > 0 then { headers: $headers } else {} end)
  '
}

OTEL_JSON=$(otel_json_fragment)

# MCP server list. Orchestrator emits OPENCLAW_MCP_SERVERS_JSON when the
# agent template declared mcpServers. Shape matches openclaw.json's
# mcp.servers block exactly (object keyed by server name, each value a
# server config). Empty / unset → omit the mcp block so no servers load.
if [[ -n "${OPENCLAW_MCP_SERVERS_JSON:-}" ]]; then
  # Validate the JSON up front — a malformed blob silently skipping
  # would be worse than crashing; the orchestrator promised these servers.
  if ! echo "${OPENCLAW_MCP_SERVERS_JSON}" | jq -e 'type == "object"' >/dev/null 2>&1; then
    echo "[entrypoint] ERROR: OPENCLAW_MCP_SERVERS_JSON is not a JSON object" >&2
    exit 1
  fi
  MCP_JSON="${OPENCLAW_MCP_SERVERS_JSON}"
else
  MCP_JSON='null'
fi

# Assemble the base config with jq (no string-escaping footguns). The
# models.providers.<plugin-id> block that Category B providers need (moonshot,
# deepseek, qwen, etc.) is populated by apply-provider-config.mjs after this
# block writes, using the bundled openclaw extension's catalog builder as the
# source of truth. This eliminates the previous hand-mirror that hardcoded
# moonshot's model catalog + zero prices and made the runtime drift from
# upstream on every openclaw release.
#
# Things that matter beyond the obvious:
#
#   1. The provider plugin entry is keyed dynamically off OPENCLAW_PLUGIN so
#      the runtime image stays provider-agnostic. Every OpenClaw provider
#      plugin that reads its API key from an env var will Just Work.
#
#   2. `agents.defaults.models.<model-id>: {}` declares the model as the
#      agent-level default. Without this block the gateway logs "Unknown
#      model" during runtime resolution even when the plugin is loaded.
#
#   3. `models.providers.<plugin-id>: {...}` is required for Category B
#      providers that do not auto-register their catalog at plugin-load
#      time. Populated by apply-provider-config.mjs below.
#
#   4. `gateway.controlUi.dangerouslyDisableDeviceAuth: true` lets the
#      orchestrator's WebSocket client (Item 7) connect as
#      client.id="openclaw-control-ui" with token auth only, skipping the
#      Ed25519 device-signing handshake. Safe here because the gateway is
#      bound to the openclaw-net Docker bridge and the only client that
#      ever reaches it is the orchestrator we control.
jq -n \
  --arg agent_id       "${OPENCLAW_AGENT_ID}" \
  --arg model          "${OPENCLAW_MODEL}" \
  --arg instructions   "${OPENCLAW_INSTRUCTIONS}" \
  --arg plugin         "${OPENCLAW_PLUGIN}" \
  --arg confirm_tools  "${OPENCLAW_CONFIRM_TOOLS:-}" \
  --argjson port       "${OPENCLAW_GATEWAY_PORT}" \
  --argjson tools      "${TOOLS_JSON}" \
  --argjson denied     "${DENIED_TOOLS_JSON}" \
  --argjson otel       "${OTEL_JSON}" \
  --argjson mcp        "${MCP_JSON}" \
'
{
  gateway: {
    port: $port,
    mode: "local",
    bind: "lan",
    http: {
      endpoints: {
        chatCompletions: { enabled: true }
      }
    },
    controlUi: {
      dangerouslyDisableDeviceAuth: true
    }
  },
  agents: {
    list: [
      (
        {
          id: $agent_id,
          model: { primary: $model }
        }
        + (if ($tools.alsoAllow // null) then { tools: $tools } else {} end)
        + (if ($denied | length) > 0 then { tools: ((.tools // {}) + { deny: $denied }) } else {} end)
        + (if $instructions != "" then { systemPromptOverride: $instructions } else {} end)
      )
    ],
    defaults: {
      model: { primary: $model },
      models: ({ ($model): {} })
    }
  },
  plugins: {
    entries: (
      { ($plugin): { enabled: true } }
      + (if $confirm_tools != "" then { "confirm-tools": { enabled: true } } else {} end)
    )
  }
}
+ (if $otel != null then { diagnostics: { otel: $otel } } else {} end)
+ (if $mcp != null then { mcp: { servers: $mcp } } else {} end)
' > "${CONFIG_PATH}"

# Populate models.providers.<id> for Category B providers from the bundled
# openclaw extension's catalog builder. No-op for Category A providers — they
# auto-register their catalog at plugin load. Prints a status line on success,
# fails loudly on error (we'd rather surface a clear startup failure than
# silently produce a config with no provider block).
if [ -f /opt/openclaw-plugins/apply-provider-config.mjs ]; then
  echo "[entrypoint] applying ${OPENCLAW_PLUGIN} catalog via bundled openclaw extension"
  node /opt/openclaw-plugins/apply-provider-config.mjs "${CONFIG_PATH}" "${OPENCLAW_PLUGIN}"
fi

echo "[entrypoint] wrote config to ${CONFIG_PATH}:"
cat "${CONFIG_PATH}"

# OpenClaw CLI honors OPENCLAW_CONFIG_PATH to locate openclaw.json.
export OPENCLAW_CONFIG_PATH="${CONFIG_PATH}"
export OPENCLAW_STATE_DIR="${STATE_DIR}"

# Item 19: copy the confirm-tools plugin into the workspace extensions dir.
# OpenClaw discovers plugins from $OPENCLAW_STATE_DIR/extensions/ (resolveConfigDir
# returns OPENCLAW_STATE_DIR when set). The plugin files are staged at build
# time under /opt/openclaw-plugins/ and copied here at startup so they land
# inside the bind-mounted workspace.
if [ -n "${OPENCLAW_CONFIRM_TOOLS:-}" ] && [ -d /opt/openclaw-plugins/confirm-tools ]; then
  echo "[entrypoint] installing confirm-tools plugin to ${STATE_DIR}/extensions/"
  mkdir -p "${STATE_DIR}/extensions/confirm-tools"
  cp -r /opt/openclaw-plugins/confirm-tools/* "${STATE_DIR}/extensions/confirm-tools/"
fi

# Item 15: install environment packages if OPENCLAW_PACKAGES_JSON is set.
# The JSON has optional keys: pip, apt, npm (each an array of package specs).
# Runs BEFORE the gateway boots so packages are available when the agent starts.
if [ -n "${OPENCLAW_PACKAGES_JSON:-}" ]; then
  echo "[entrypoint] installing environment packages: ${OPENCLAW_PACKAGES_JSON}"
  APT_PKGS=$(echo "${OPENCLAW_PACKAGES_JSON}" | jq -r '.apt // [] | join(" ")')
  PIP_PKGS=$(echo "${OPENCLAW_PACKAGES_JSON}" | jq -r '.pip // [] | join(" ")')
  NPM_PKGS=$(echo "${OPENCLAW_PACKAGES_JSON}" | jq -r '.npm // [] | join(" ")')
  if [ -n "${APT_PKGS}" ] && command -v apt-get >/dev/null 2>&1; then
    echo "[entrypoint] apt-get install: ${APT_PKGS}"
    (apt-get update -qq && apt-get install -y -qq ${APT_PKGS}) 2>&1 | tail -5 || echo "[entrypoint] WARNING: apt-get install failed (non-fatal)"
  elif [ -n "${APT_PKGS}" ]; then
    echo "[entrypoint] WARNING: apt-get not available, skipping: ${APT_PKGS}"
  fi
  if [ -n "${PIP_PKGS}" ] && command -v pip >/dev/null 2>&1; then
    echo "[entrypoint] pip install: ${PIP_PKGS}"
    pip install --quiet ${PIP_PKGS} 2>&1 | tail -5 || echo "[entrypoint] WARNING: pip install failed (non-fatal)"
  elif [ -n "${PIP_PKGS}" ]; then
    echo "[entrypoint] WARNING: pip not available, skipping: ${PIP_PKGS}"
  fi
  if [ -n "${NPM_PKGS}" ] && command -v npm >/dev/null 2>&1; then
    echo "[entrypoint] npm install: ${NPM_PKGS}"
    npm install --prefix /tmp/openclaw-env-packages ${NPM_PKGS} 2>&1 | tail -5 || echo "[entrypoint] WARNING: npm install failed (non-fatal)"
    export PATH="/tmp/openclaw-env-packages/node_modules/.bin:${PATH}"
    export NODE_PATH="/tmp/openclaw-env-packages/node_modules:${NODE_PATH:-}"
  elif [ -n "${NPM_PKGS}" ]; then
    echo "[entrypoint] WARNING: npm not available, skipping: ${NPM_PKGS}"
  fi
  echo "[entrypoint] environment packages installed"
fi

echo "[entrypoint] starting gateway on port ${OPENCLAW_GATEWAY_PORT} (bind=lan, auth=token)"
exec openclaw gateway run \
  --port "${OPENCLAW_GATEWAY_PORT}" \
  --bind lan \
  --allow-unconfigured
