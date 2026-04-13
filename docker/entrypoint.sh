#!/usr/bin/env bash
#
# OpenClaw Managed Runtime — container entrypoint
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
#   OPENCLAW_SESSION_ID    - session identifier for resume (optional)
#   OPENCLAW_STATE_DIR     - persistent volume mount (default: /workspace)
#   OPENCLAW_GATEWAY_PORT  - HTTP port (default: 18789)
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
: "${OPENCLAW_SESSION_ID:=}"

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

# Some OpenClaw provider plugins auto-register their static catalog at plugin
# load time (e.g. anthropic, openai, google). Others use
# `defineSingleProviderPluginEntry` and only materialize their catalog into
# `models.providers.<id>` through an interactive `openclaw models auth login`
# flow (e.g. moonshot). For the second class, we have to emit that block
# ourselves so the runtime model registry knows about the model. The content
# below mirrors what `applyMoonshotConfig` / `applyMoonshotConfigCn` in
# extensions/moonshot/onboard.ts produces. Extend PROVIDER_BLOCK_JSON below as
# we add more providers that require this pattern.
PROVIDER_BLOCK_JSON='{}'
case "${OPENCLAW_PLUGIN}" in
  moonshot)
    PROVIDER_BLOCK_JSON='{
      "moonshot": {
        "baseUrl": "https://api.moonshot.ai/v1",
        "api": "openai-completions",
        "models": [
          {
            "id": "kimi-k2.5",
            "name": "Kimi K2.5",
            "input": ["text", "image"],
            "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
            "contextWindow": 262144,
            "maxTokens": 262144
          },
          {
            "id": "kimi-k2-thinking",
            "name": "Kimi K2 Thinking",
            "input": ["text"],
            "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
            "contextWindow": 262144,
            "maxTokens": 262144
          }
        ]
      }
    }'
    ;;
esac

# Assemble the full config with jq to avoid any string-escaping footguns.
#
# Three things matter beyond the obvious:
#
#   1. The provider plugin entry is keyed dynamically off OPENCLAW_PLUGIN so
#      the runtime image stays provider-agnostic. Every OpenClaw provider
#      plugin that reads its API key from an env var will Just Work.
#
#   2. `agents.defaults.models.<model-id>: {}` declares the model as the
#      agent-level default. Without this block the gateway logs "Unknown
#      model" during runtime resolution even when the plugin is loaded.
#
#   3. `models.providers.<plugin-id>: {...}` is required for providers that
#      do not auto-register their catalog. Populated above via
#      PROVIDER_BLOCK_JSON.
jq -n \
  --arg agent_id       "${OPENCLAW_AGENT_ID}" \
  --arg model          "${OPENCLAW_MODEL}" \
  --arg instructions   "${OPENCLAW_INSTRUCTIONS}" \
  --arg plugin         "${OPENCLAW_PLUGIN}" \
  --argjson port       "${OPENCLAW_GATEWAY_PORT}" \
  --argjson tools      "${TOOLS_JSON}" \
  --argjson providers  "${PROVIDER_BLOCK_JSON}" \
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
        + (if $instructions != "" then { systemPromptOverride: $instructions } else {} end)
      )
    ],
    defaults: {
      model: { primary: $model },
      models: ({ ($model): {} })
    }
  }
}
+ (if ($providers | length) > 0 then { models: { mode: "merge", providers: $providers } } else {} end)
+ {
  plugins: {
    entries: (
      { ($plugin): { enabled: true } }
    )
  }
}
' > "${CONFIG_PATH}"

echo "[entrypoint] wrote config to ${CONFIG_PATH}:"
cat "${CONFIG_PATH}"

# OpenClaw CLI honors OPENCLAW_CONFIG_PATH to locate openclaw.json.
export OPENCLAW_CONFIG_PATH="${CONFIG_PATH}"
export OPENCLAW_STATE_DIR="${STATE_DIR}"

# If resuming a session, stash the session ID where the orchestrator's health
# check or post-start logic can pick it up. The OpenClaw SessionManager loads
# sessions by ID from the workspace directory automatically when the agent is
# addressed with that session key.
if [[ -n "${OPENCLAW_SESSION_ID}" ]]; then
  echo "[entrypoint] session resume requested: ${OPENCLAW_SESSION_ID}"
fi

echo "[entrypoint] starting gateway on port ${OPENCLAW_GATEWAY_PORT} (bind=lan, auth=none)"
exec openclaw gateway run \
  --port "${OPENCLAW_GATEWAY_PORT}" \
  --bind lan \
  --allow-unconfigured
