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

echo "[e2e] running task"
RUN_RESPONSE=$(curl --silent --fail \
  -X POST "${BASE_URL}/v1/agents/${AGENT_ID}/run" \
  -H 'Content-Type: application/json' \
  -d '{"task": "In one paragraph, summarize what Claude Managed Agents is and why it matters."}')
SESSION_ID=$(echo "${RUN_RESPONSE}" | jq -r '.session_id')
if [[ -z "${SESSION_ID}" || "${SESSION_ID}" == "null" ]]; then
  echo "[e2e] failed to start run: ${RUN_RESPONSE}"
  exit 1
fi
echo "[e2e] started session: ${SESSION_ID}"

echo "[e2e] polling session status (timeout ${MAX_POLL_SEC}s)"
elapsed=0
while [[ ${elapsed} -lt ${MAX_POLL_SEC} ]]; do
  sleep "${POLL_INTERVAL_SEC}"
  elapsed=$((elapsed + POLL_INTERVAL_SEC))
  SESSION_JSON=$(curl --silent --fail "${BASE_URL}/v1/sessions/${SESSION_ID}")
  STATUS=$(echo "${SESSION_JSON}" | jq -r '.status')
  echo "[e2e] t=${elapsed}s status=${STATUS}"
  case "${STATUS}" in
    completed)
      echo "[e2e] SUCCESS"
      echo "${SESSION_JSON}" | jq .
      exit 0
      ;;
    failed)
      echo "[e2e] FAILED"
      echo "${SESSION_JSON}" | jq .
      exit 1
      ;;
  esac
done

echo "[e2e] TIMEOUT after ${MAX_POLL_SEC}s — last status=${STATUS}"
exit 1
