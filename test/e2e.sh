#!/usr/bin/env bash
#
# End-to-end verification for OpenClaw Managed Runtime.
#
# Prerequisites:
#   - docker compose up -d (orchestrator running on localhost:8080)
#   - Credentials for whichever provider the test model uses, exported in the
#     host shell so docker-compose forwards them into the orchestrator, which
#     forwards them into spawned agent containers. See docker-compose.yml for
#     the list of supported provider env vars.
#
# Exits 0 on success, non-zero on failure.

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8080}"
# OpenClaw model reference format: "<provider>/<model-id>". Default below is
# moonshot/kimi-k2.5 because it validates the runtime end-to-end from anywhere
# Moonshot supports without needing a cloud account. Override with any other
# provider/model OpenClaw supports:
#   OPENCLAW_TEST_MODEL=bedrock/anthropic.claude-sonnet-4-6 ./test/e2e.sh
#   OPENCLAW_TEST_MODEL=openai/gpt-5.4 ./test/e2e.sh
#   OPENCLAW_TEST_MODEL=google/gemini-2.5-pro ./test/e2e.sh
MODEL="${OPENCLAW_TEST_MODEL:-moonshot/kimi-k2.5}"
POLL_INTERVAL_SEC=2
MAX_POLL_SEC=300

echo "[e2e] checking orchestrator health at ${BASE_URL}/healthz"
curl --silent --fail "${BASE_URL}/healthz" >/dev/null || {
  echo "[e2e] orchestrator is not healthy — is docker compose up?"
  exit 1
}

echo "[e2e] creating research agent with model ${MODEL}"
# MVP e2e test asks a purely-textual question — no tool allowlist needed. The
# published openclaw npm package bundles 53 real skills (github, coding-agent,
# notion, slack, etc.) but NOT generic names like web-search or file-management,
# so we intentionally pass an empty tools array for the first demo.
CREATE_RESPONSE=$(curl --silent --fail \
  -X POST "${BASE_URL}/v1/agents" \
  -H 'Content-Type: application/json' \
  -d "{
    \"model\": \"${MODEL}\",
    \"tools\": [],
    \"instructions\": \"You are a research assistant. Answer concisely in one paragraph.\"
  }")
AGENT_ID=$(echo "${CREATE_RESPONSE}" | jq -r '.agent_id')
if [[ -z "${AGENT_ID}" || "${AGENT_ID}" == "null" ]]; then
  echo "[e2e] failed to create agent: ${CREATE_RESPONSE}"
  exit 1
fi
echo "[e2e] created agent: ${AGENT_ID}"

poll_session() {
  local session_id="$1"
  local label="$2"
  local elapsed=0
  while [[ ${elapsed} -lt ${MAX_POLL_SEC} ]]; do
    sleep "${POLL_INTERVAL_SEC}"
    elapsed=$((elapsed + POLL_INTERVAL_SEC))
    local session_json status
    session_json=$(curl --silent --fail "${BASE_URL}/v1/sessions/${session_id}")
    status=$(echo "${session_json}" | jq -r '.status')
    # Status lines go to stderr so the JSON blob is the only thing on stdout
    # when the caller captures this function's output via $(poll_session ...).
    echo "[e2e] ${label} t=${elapsed}s status=${status}" >&2
    case "${status}" in
      completed)
        echo "${session_json}"
        return 0
        ;;
      failed)
        echo "[e2e] ${label} FAILED" >&2
        echo "${session_json}" | jq . >&2
        return 1
        ;;
    esac
  done
  echo "[e2e] ${label} TIMEOUT after ${MAX_POLL_SEC}s — last status=${status}" >&2
  return 1
}

# ---- Turn 1: teach the agent a fact -----------------------------------------

echo "[e2e] turn 1: posting run with a fact to remember"
RUN1=$(curl --silent --fail \
  -X POST "${BASE_URL}/v1/agents/${AGENT_ID}/run" \
  -H 'Content-Type: application/json' \
  -d '{"task": "Remember this for later: my favorite fruit is dragonfruit. Reply with exactly the single word: noted"}')
SESSION1_ID=$(echo "${RUN1}" | jq -r '.session_id')
if [[ -z "${SESSION1_ID}" || "${SESSION1_ID}" == "null" ]]; then
  echo "[e2e] turn 1: failed to start run: ${RUN1}"
  exit 1
fi
echo "[e2e] turn 1 session: ${SESSION1_ID}"

SESSION1_JSON=$(poll_session "${SESSION1_ID}" "turn1") || exit 1
SESSION1_OUTPUT=$(echo "${SESSION1_JSON}" | jq -r '.output')
echo "[e2e] turn 1 output: ${SESSION1_OUTPUT}"

# ---- Turn 2: ask the agent to recall the fact on the SAME session -----------

echo "[e2e] turn 2: posting run with sessionId=${SESSION1_ID} to resume the same session"
RUN2=$(curl --silent --fail \
  -X POST "${BASE_URL}/v1/agents/${AGENT_ID}/run" \
  -H 'Content-Type: application/json' \
  -d "{\"task\": \"What is my favorite fruit? Reply with only the single word, no punctuation.\", \"sessionId\": \"${SESSION1_ID}\"}")
SESSION2_ID=$(echo "${RUN2}" | jq -r '.session_id')
echo "[e2e] turn 2 session: ${SESSION2_ID}"

SESSION2_JSON=$(poll_session "${SESSION2_ID}" "turn2") || exit 1
SESSION2_OUTPUT=$(echo "${SESSION2_JSON}" | jq -r '.output')
echo "[e2e] turn 2 output: ${SESSION2_OUTPUT}"

# ---- Verify resume --------------------------------------------------------

if echo "${SESSION2_OUTPUT}" | grep -qi "dragonfruit"; then
  echo "[e2e] SUCCESS: session resumed — turn 2 recalled the fact from turn 1"
  echo "${SESSION2_JSON}" | jq .
  exit 0
else
  echo "[e2e] FAIL: session resume broken — turn 2 did not recall 'dragonfruit'"
  echo "  turn 1 output: ${SESSION1_OUTPUT}"
  echo "  turn 2 output: ${SESSION2_OUTPUT}"
  exit 1
fi
