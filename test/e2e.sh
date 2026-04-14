#!/usr/bin/env bash
#
# End-to-end verification for OpenClaw Managed Runtime (session-centric API).
#
# Flow:
#   1. Create an agent template.
#   2. Create a long-lived Session bound to that agent.
#   3. Turn 1: post a user.message event teaching the agent a fact.
#              Poll the session until status flips back to "idle", then read
#              the latest agent.message from the event log.
#   4. Turn 2: post a second user.message event asking the agent to recall
#              the fact. Poll. Read. Verify the recall.
#   5. Smoke the backwards-compat POST /v1/agents/:id/run adapter so we know
#              the thin wrapper on top of the session-centric primitives still
#              returns an OpenAI-style shape for legacy callers.
#
# Prerequisites:
#   - docker compose up -d (orchestrator on localhost:8080)
#   - Provider API key (e.g. MOONSHOT_API_KEY) exported in the host shell so
#     docker-compose forwards it into the orchestrator, which forwards it
#     into each spawned agent container.
#
# Override model:
#   OPENCLAW_TEST_MODEL=openai/gpt-5.4 ./test/e2e.sh
#   OPENCLAW_TEST_MODEL=anthropic/claude-sonnet-4-6 ./test/e2e.sh
#   OPENCLAW_TEST_MODEL=bedrock/anthropic.claude-sonnet-4-6 ./test/e2e.sh
#
# Exits 0 on success, non-zero on failure.

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8080}"
MODEL="${OPENCLAW_TEST_MODEL:-moonshot/kimi-k2.5}"
POLL_INTERVAL_SEC=2
MAX_POLL_SEC=300

echo "[e2e] checking orchestrator health at ${BASE_URL}/healthz"
curl --silent --fail "${BASE_URL}/healthz" >/dev/null || {
  echo "[e2e] orchestrator is not healthy — is docker compose up?"
  exit 1
}

echo "[e2e] creating research agent with model ${MODEL}"
# MVP e2e asks purely-textual questions — no tool allowlist needed.
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

echo "[e2e] creating session bound to agent ${AGENT_ID}"
SESSION_RESPONSE=$(curl --silent --fail \
  -X POST "${BASE_URL}/v1/sessions" \
  -H 'Content-Type: application/json' \
  -d "{\"agentId\": \"${AGENT_ID}\"}")
SESSION_ID=$(echo "${SESSION_RESPONSE}" | jq -r '.session_id')
if [[ -z "${SESSION_ID}" || "${SESSION_ID}" == "null" ]]; then
  echo "[e2e] failed to create session: ${SESSION_RESPONSE}"
  exit 1
fi
echo "[e2e] created session: ${SESSION_ID}"

# poll_session: loop GET /v1/sessions/:id until status flips away from
# "running". Success = status is "idle" (most recent run finished cleanly).
# Failure = status is "failed". Status lines go to stderr so the final JSON
# blob is the only thing on stdout when the caller captures $(poll_session ...).
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
    echo "[e2e] ${label} t=${elapsed}s status=${status}" >&2
    case "${status}" in
      idle)
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

post_event() {
  local session_id="$1"
  local content="$2"
  curl --silent --fail \
    -X POST "${BASE_URL}/v1/sessions/${session_id}/events" \
    -H 'Content-Type: application/json' \
    -d "$(jq -n --arg c "${content}" '{type: "user.message", content: $c}')"
}

latest_agent_message() {
  local session_id="$1"
  curl --silent --fail "${BASE_URL}/v1/sessions/${session_id}/events" \
    | jq -r '[.events[] | select(.type=="agent.message")] | last | .content // ""'
}

# ---- Turn 1: teach the agent a fact -----------------------------------------

echo "[e2e] turn 1: posting user.message (remember dragonfruit)"
TURN1_EVENT=$(post_event "${SESSION_ID}" \
  "Remember this for later: my favorite fruit is dragonfruit. Reply with exactly the single word: noted")
TURN1_EVENT_ID=$(echo "${TURN1_EVENT}" | jq -r '.event_id')
echo "[e2e] turn 1 user event: ${TURN1_EVENT_ID}"

poll_session "${SESSION_ID}" "turn1" >/dev/null || exit 1
TURN1_OUTPUT=$(latest_agent_message "${SESSION_ID}")
echo "[e2e] turn 1 output: ${TURN1_OUTPUT}"

# ---- Turn 2: ask the agent to recall the fact on the SAME session -----------

echo "[e2e] turn 2: posting user.message (what is my favorite fruit)"
TURN2_EVENT=$(post_event "${SESSION_ID}" \
  "What is my favorite fruit? Reply with only the single word, no punctuation.")
TURN2_EVENT_ID=$(echo "${TURN2_EVENT}" | jq -r '.event_id')
echo "[e2e] turn 2 user event: ${TURN2_EVENT_ID}"

poll_session "${SESSION_ID}" "turn2" >/dev/null || exit 1
TURN2_OUTPUT=$(latest_agent_message "${SESSION_ID}")
echo "[e2e] turn 2 output: ${TURN2_OUTPUT}"

# ---- Verify resume --------------------------------------------------------

if echo "${TURN2_OUTPUT}" | grep -qi "dragonfruit"; then
  echo "[e2e] SUCCESS: session-centric resume — turn 2 recalled the fact from turn 1"
else
  echo "[e2e] FAIL: session resume broken — turn 2 did not recall 'dragonfruit'"
  echo "  turn 1 output: ${TURN1_OUTPUT}"
  echo "  turn 2 output: ${TURN2_OUTPUT}"
  exit 1
fi

# ---- Persistence: orchestrator restart must not lose the session -----------
# The whole point of Item 3 is that the SQLite-backed store survives a
# process restart. Verify: restart the orchestrator, re-read the session
# and its events, then post a third turn and confirm the agent still
# remembers dragonfruit.

wait_for_healthz() {
  local elapsed=0
  while [[ ${elapsed} -lt 60 ]]; do
    if curl --silent --fail "${BASE_URL}/healthz" >/dev/null 2>&1; then
      echo "[e2e] orchestrator healthy again (t=${elapsed}s)"
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  echo "[e2e] orchestrator did not come back after restart within 60s"
  return 1
}

echo "[e2e] restarting orchestrator to verify persistence"
(
  cd "$(dirname "${BASH_SOURCE[0]}")/.." && \
  docker compose restart orchestrator
) >/dev/null
wait_for_healthz || exit 1

echo "[e2e] post-restart: GET /v1/sessions/${SESSION_ID}"
RESTORED_SESSION=$(curl --silent --fail "${BASE_URL}/v1/sessions/${SESSION_ID}")
RESTORED_STATUS=$(echo "${RESTORED_SESSION}" | jq -r '.status')
RESTORED_OUTPUT=$(echo "${RESTORED_SESSION}" | jq -r '.output')
RESTORED_AGENT_ID=$(echo "${RESTORED_SESSION}" | jq -r '.agent_id')
if [[ "${RESTORED_STATUS}" != "idle" ]]; then
  echo "[e2e] FAIL: session status after restart = ${RESTORED_STATUS}, expected idle"
  echo "${RESTORED_SESSION}" | jq .
  exit 1
fi
if [[ "${RESTORED_AGENT_ID}" != "${AGENT_ID}" ]]; then
  echo "[e2e] FAIL: restored session agent_id = ${RESTORED_AGENT_ID}, expected ${AGENT_ID}"
  exit 1
fi
if ! echo "${RESTORED_OUTPUT}" | grep -qi "dragonfruit"; then
  echo "[e2e] FAIL: restored session.output lost dragonfruit"
  echo "  output was: ${RESTORED_OUTPUT}"
  exit 1
fi
echo "[e2e] post-restart session OK (status=${RESTORED_STATUS}, output contains dragonfruit)"

echo "[e2e] post-restart: GET /v1/sessions/${SESSION_ID}/events"
RESTORED_EVENTS=$(curl --silent --fail "${BASE_URL}/v1/sessions/${SESSION_ID}/events")
RESTORED_EVENT_COUNT=$(echo "${RESTORED_EVENTS}" | jq -r '.count')
if [[ "${RESTORED_EVENT_COUNT}" != "4" ]]; then
  echo "[e2e] FAIL: expected 4 events post-restart (2 user + 2 agent.message), got ${RESTORED_EVENT_COUNT}"
  echo "${RESTORED_EVENTS}" | jq '.events | map({type, content: (.content | .[0:60])})'
  exit 1
fi
echo "[e2e] post-restart events OK (count=${RESTORED_EVENT_COUNT})"

echo "[e2e] post-restart: GET /v1/agents/${AGENT_ID}"
RESTORED_AGENT=$(curl --silent --fail "${BASE_URL}/v1/agents/${AGENT_ID}")
if [[ "$(echo "${RESTORED_AGENT}" | jq -r '.agent_id')" != "${AGENT_ID}" ]]; then
  echo "[e2e] FAIL: agent template lost across restart"
  exit 1
fi
echo "[e2e] post-restart agent template OK"

echo "[e2e] turn 3 (post-restart): posting user.message (recall dragonfruit again)"
TURN3_EVENT=$(post_event "${SESSION_ID}" \
  "Remind me one more time — what is my favorite fruit? Single word only.")
TURN3_EVENT_ID=$(echo "${TURN3_EVENT}" | jq -r '.event_id')
echo "[e2e] turn 3 user event: ${TURN3_EVENT_ID}"
poll_session "${SESSION_ID}" "turn3" >/dev/null || exit 1
TURN3_OUTPUT=$(latest_agent_message "${SESSION_ID}")
echo "[e2e] turn 3 output: ${TURN3_OUTPUT}"
if echo "${TURN3_OUTPUT}" | grep -qi "dragonfruit"; then
  echo "[e2e] SUCCESS: post-restart turn 3 still recalls dragonfruit"
else
  echo "[e2e] FAIL: post-restart turn 3 lost dragonfruit"
  echo "  turn 3 output: ${TURN3_OUTPUT}"
  exit 1
fi

# ---- Backwards-compat: one-shot smoke of the /run adapter -------------------
# Proves that the thin wrapper on top of createSession + runEvent still
# returns an OpenAI-style { session_id, status: "running" } for legacy callers.

echo "[e2e] backwards-compat: POST /v1/agents/${AGENT_ID}/run"
ADAPTER_RUN=$(curl --silent --fail \
  -X POST "${BASE_URL}/v1/agents/${AGENT_ID}/run" \
  -H 'Content-Type: application/json' \
  -d '{"task": "Reply with exactly one word: ready"}')
ADAPTER_SESSION_ID=$(echo "${ADAPTER_RUN}" | jq -r '.session_id')
if [[ -z "${ADAPTER_SESSION_ID}" || "${ADAPTER_SESSION_ID}" == "null" ]]; then
  echo "[e2e] backwards-compat FAIL: /run adapter did not return a session_id"
  echo "${ADAPTER_RUN}" | jq .
  exit 1
fi
echo "[e2e] backwards-compat adapter session: ${ADAPTER_SESSION_ID}"
poll_session "${ADAPTER_SESSION_ID}" "adapter-run" >/dev/null || exit 1
echo "[e2e] backwards-compat /run adapter still works"

echo "[e2e] ALL CHECKS PASSED"
exit 0
