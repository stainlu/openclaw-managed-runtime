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
#   OPENCLAW_MODEL         - model reference, e.g. "bedrock/claude-sonnet-4-6" (required)
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

set -euo pipefail

: "${OPENCLAW_AGENT_ID:?OPENCLAW_AGENT_ID is required}"
: "${OPENCLAW_MODEL:?OPENCLAW_MODEL is required}"
: "${OPENCLAW_STATE_DIR:=/workspace}"
: "${OPENCLAW_GATEWAY_PORT:=18789}"
: "${OPENCLAW_TOOLS:=}"
: "${OPENCLAW_INSTRUCTIONS:=}"
: "${OPENCLAW_SESSION_ID:=}"

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

# Assemble the full config with jq to avoid any string-escaping footguns.
jq -n \
  --arg agent_id       "${OPENCLAW_AGENT_ID}" \
  --arg model          "${OPENCLAW_MODEL}" \
  --arg instructions   "${OPENCLAW_INSTRUCTIONS}" \
  --argjson port       "${OPENCLAW_GATEWAY_PORT}" \
  --argjson tools      "${TOOLS_JSON}" \
'
{
  gateway: {
    port: $port,
    mode: "local",
    bind: "lan",
    allowInsecureAuth: true,
    auth: { mode: "none" },
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
    ]
  },
  plugins: {
    entries: {
      "amazon-bedrock": {
        enabled: true,
        config: {
          discovery: { enabled: true }
        }
      }
    }
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
