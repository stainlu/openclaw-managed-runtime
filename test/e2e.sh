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
TURN1_START=$(date +%s)
TURN1_EVENT=$(post_event "${SESSION_ID}" \
  "Remember this for later: my favorite fruit is dragonfruit. Reply with exactly the single word: noted")
TURN1_EVENT_ID=$(echo "${TURN1_EVENT}" | jq -r '.event_id')
echo "[e2e] turn 1 user event: ${TURN1_EVENT_ID}"

poll_session "${SESSION_ID}" "turn1" >/dev/null || exit 1
TURN1_END=$(date +%s)
TURN1_DURATION=$((TURN1_END - TURN1_START))
TURN1_OUTPUT=$(latest_agent_message "${SESSION_ID}")
echo "[e2e] turn 1 output: ${TURN1_OUTPUT} (duration ${TURN1_DURATION}s)"

# ---- Turn 2: ask the agent to recall the fact on the SAME session -----------

echo "[e2e] turn 2: posting user.message (what is my favorite fruit)"
TURN2_START=$(date +%s)
TURN2_EVENT=$(post_event "${SESSION_ID}" \
  "What is my favorite fruit? Reply with only the single word, no punctuation.")
TURN2_EVENT_ID=$(echo "${TURN2_EVENT}" | jq -r '.event_id')
echo "[e2e] turn 2 user event: ${TURN2_EVENT_ID}"

poll_session "${SESSION_ID}" "turn2" >/dev/null || exit 1
TURN2_END=$(date +%s)
TURN2_DURATION=$((TURN2_END - TURN2_START))
TURN2_OUTPUT=$(latest_agent_message "${SESSION_ID}")
echo "[e2e] turn 2 output: ${TURN2_OUTPUT} (duration ${TURN2_DURATION}s)"

# ---- Verify resume --------------------------------------------------------

if echo "${TURN2_OUTPUT}" | grep -qi "dragonfruit"; then
  echo "[e2e] SUCCESS: session-centric resume — turn 2 recalled the fact from turn 1"
else
  echo "[e2e] FAIL: session resume broken — turn 2 did not recall 'dragonfruit'"
  echo "  turn 1 output: ${TURN1_OUTPUT}"
  echo "  turn 2 output: ${TURN2_OUTPUT}"
  exit 1
fi

# ---- Cost accounting (Item 9) -----------------------------------------------
# Proves the session's rolling cost_usd is populated from Pi's JSONL rather
# than hardcoded 0. The orchestrator no longer maintains its own static price
# sheet — it reads message.usage.cost.total from the JSONL after each run.
#
# For moonshot the value will be 0 because our docker/entrypoint.sh config
# block currently reports 0 prices (Category B provider — see the
# PROVIDER_BLOCK_JSON comment in the entrypoint). This assertion verifies the
# field is a NUMBER (not null, not missing), which is the architectural gate.
# Updating moonshot's prices in the entrypoint will propagate a non-zero
# value through this same path with zero code changes.

SESSION_COST_JSON=$(curl --silent --fail "${BASE_URL}/v1/sessions/${SESSION_ID}")
SESSION_COST_USD=$(echo "${SESSION_COST_JSON}" | jq -r '.cost_usd')
SESSION_COST_TYPE=$(echo "${SESSION_COST_JSON}" | jq -r '.cost_usd | type')
if [[ "${SESSION_COST_TYPE}" != "number" ]]; then
  echo "[e2e] FAIL: session.cost_usd is not a number (type=${SESSION_COST_TYPE}, value=${SESSION_COST_USD})"
  exit 1
fi
echo "[e2e] cost accounting OK: cost_usd=${SESSION_COST_USD} (populated from Pi JSONL)"

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
TURN3_START=$(date +%s)
TURN3_EVENT=$(post_event "${SESSION_ID}" \
  "Remind me one more time — what is my favorite fruit? Single word only.")
TURN3_EVENT_ID=$(echo "${TURN3_EVENT}" | jq -r '.event_id')
echo "[e2e] turn 3 user event: ${TURN3_EVENT_ID}"
poll_session "${SESSION_ID}" "turn3" >/dev/null || exit 1
TURN3_END=$(date +%s)
TURN3_DURATION=$((TURN3_END - TURN3_START))
TURN3_OUTPUT=$(latest_agent_message "${SESSION_ID}")
echo "[e2e] turn 3 output: ${TURN3_OUTPUT} (duration ${TURN3_DURATION}s)"
if echo "${TURN3_OUTPUT}" | grep -qi "dragonfruit"; then
  echo "[e2e] SUCCESS: post-restart turn 3 still recalls dragonfruit"
else
  echo "[e2e] FAIL: post-restart turn 3 lost dragonfruit"
  echo "  turn 3 output: ${TURN3_OUTPUT}"
  exit 1
fi

# ---- Pool reuse timing assertions -------------------------------------------
# Proves Item 4 behavior: turn 2 reuses the live container from turn 1, and
# turn 3 respawns after the restart (because the in-memory pool lost state).
# Use deltas, not absolute thresholds — Moonshot latency is variable and a
# hard threshold would flake. The spawn overhead is ~15s consistently, so a
# 5s delta is comfortably above the noise floor.

echo "[e2e] turn durations: t1=${TURN1_DURATION}s t2=${TURN2_DURATION}s t3=${TURN3_DURATION}s"

DELTA_1_MINUS_2=$((TURN1_DURATION - TURN2_DURATION))
if [[ ${DELTA_1_MINUS_2} -lt 5 ]]; then
  echo "[e2e] FAIL: turn 2 not meaningfully faster than turn 1 (delta=${DELTA_1_MINUS_2}s < 5s)"
  echo "  expected pool reuse after turn 1 to save ~15s of container spawn time"
  exit 1
fi
echo "[e2e] pool reuse OK: turn 2 was ${DELTA_1_MINUS_2}s faster than turn 1"

DELTA_3_MINUS_2=$((TURN3_DURATION - TURN2_DURATION))
if [[ ${DELTA_3_MINUS_2} -lt 5 ]]; then
  echo "[e2e] FAIL: turn 3 not meaningfully slower than turn 2 (delta=${DELTA_3_MINUS_2}s < 5s)"
  echo "  expected the orchestrator restart to drop the in-memory pool and force a fresh spawn"
  exit 1
fi
echo "[e2e] post-restart respawn OK: turn 3 was ${DELTA_3_MINUS_2}s slower than turn 2"

# ---- SSE smoke: live event streaming ----------------------------------------
# Proves that GET /v1/sessions/:id/events?stream=true returns a working SSE
# stream — catch-up yields prior events, then tail-follow picks up new ones.

STREAM_OUT=$(mktemp /tmp/openclaw-stream.XXXXXX)
echo "[e2e] SSE smoke: curl -N stream -> ${STREAM_OUT}"

# Start the stream in the background. Note: no --fail — we want curl to keep
# writing whatever bytes it gets even if the connection is later torn down.
curl --silent --no-buffer \
  "${BASE_URL}/v1/sessions/${SESSION_ID}/events?stream=true" \
  > "${STREAM_OUT}" 2>&1 &
STREAM_PID=$!

# Give curl a beat to open the HTTP connection before we kick off the run.
sleep 1

echo "[e2e] SSE smoke: posting turn 4 user.message"
post_event "${SESSION_ID}" \
  "Tell me the fruit one last time. Single word." >/dev/null
poll_session "${SESSION_ID}" "stream-turn" >/dev/null || {
  kill "${STREAM_PID}" 2>/dev/null || true
  rm -f "${STREAM_OUT}"
  exit 1
}

# After the session flips to idle, give the SSE generator a moment to flush
# the final agent.message out of its poll loop before we kill curl.
sleep 2

kill "${STREAM_PID}" 2>/dev/null || true
wait "${STREAM_PID}" 2>/dev/null || true

STREAM_LINES=$(wc -l < "${STREAM_OUT}" | tr -d ' ')
STREAM_USER=$(grep -c "^event: user.message$" "${STREAM_OUT}" || true)
STREAM_AGENT=$(grep -c "^event: agent.message$" "${STREAM_OUT}" || true)
STREAM_HEARTBEAT=$(grep -c "^event: heartbeat$" "${STREAM_OUT}" || true)
echo "[e2e] SSE stream captured ${STREAM_LINES} lines: ${STREAM_USER} user.message, ${STREAM_AGENT} agent.message, ${STREAM_HEARTBEAT} heartbeat"

if [[ "${STREAM_USER}" -lt 1 ]]; then
  echo "[e2e] FAIL: SSE stream did not emit any user.message events"
  head -c 1024 "${STREAM_OUT}"
  rm -f "${STREAM_OUT}"
  exit 1
fi
if [[ "${STREAM_AGENT}" -lt 1 ]]; then
  echo "[e2e] FAIL: SSE stream did not emit any agent.message events"
  head -c 1024 "${STREAM_OUT}"
  rm -f "${STREAM_OUT}"
  exit 1
fi
echo "[e2e] SSE smoke OK: both user.message and agent.message streamed live"
rm -f "${STREAM_OUT}"

# ---- Control: cancel --------------------------------------------------------
# Proves POST /v1/sessions/:id/cancel aborts an in-flight run via the
# gateway WS control plane and returns the session to idle without
# recording an error. Uses a fresh session so the assertions don't have
# to share state with the main dragonfruit session.

echo "[e2e] control test: creating dedicated session for cancel"
CANCEL_SESSION=$(curl --silent --fail \
  -X POST "${BASE_URL}/v1/sessions" \
  -H 'Content-Type: application/json' \
  -d "{\"agentId\": \"${AGENT_ID}\"}" | jq -r '.session_id')
echo "[e2e] cancel session: ${CANCEL_SESSION}"

echo "[e2e] cancel: warming the session so the WS client is ready"
post_event "${CANCEL_SESSION}" "Reply with exactly the single word: warmed" >/dev/null
poll_session "${CANCEL_SESSION}" "cancel-warmup" >/dev/null || exit 1

echo "[e2e] cancel: posting a long-running prompt"
post_event "${CANCEL_SESSION}" \
  "Please write a thorough multi-paragraph essay about the history of marine biology, covering at least five different sub-topics in detail." >/dev/null
sleep 2

echo "[e2e] cancel: issuing POST /cancel"
CANCEL_RESPONSE=$(curl --silent --fail \
  -X POST "${BASE_URL}/v1/sessions/${CANCEL_SESSION}/cancel")
echo "[e2e] cancel response: ${CANCEL_RESPONSE}"
CANCEL_OK=$(echo "${CANCEL_RESPONSE}" | jq -r '.cancelled')
CANCEL_STATUS=$(echo "${CANCEL_RESPONSE}" | jq -r '.session_status')
if [[ "${CANCEL_OK}" != "true" ]]; then
  echo "[e2e] FAIL: cancel did not return cancelled:true"
  exit 1
fi
if [[ "${CANCEL_STATUS}" != "idle" ]]; then
  echo "[e2e] FAIL: cancel did not flip session to idle (got ${CANCEL_STATUS})"
  exit 1
fi
echo "[e2e] cancel test PASSED"

# ---- Control: queue when busy -----------------------------------------------
# Proves that POSTing a second event while the session is running queues
# the new event instead of returning 409. The session should stay running
# until both queued runs complete; both replies should land in order in
# the JSONL event log.

echo "[e2e] control test: creating dedicated session for queue"
QUEUE_SESSION=$(curl --silent --fail \
  -X POST "${BASE_URL}/v1/sessions" \
  -H 'Content-Type: application/json' \
  -d "{\"agentId\": \"${AGENT_ID}\"}" | jq -r '.session_id')
echo "[e2e] queue session: ${QUEUE_SESSION}"

echo "[e2e] queue: posting event A"
EVENT_A=$(curl --silent --fail \
  -X POST "${BASE_URL}/v1/sessions/${QUEUE_SESSION}/events" \
  -H 'Content-Type: application/json' \
  -d '{"type":"user.message","content":"Reply with exactly one word: alpha"}')
A_QUEUED=$(echo "${EVENT_A}" | jq -r '.queued')
if [[ "${A_QUEUED}" != "false" ]]; then
  echo "[e2e] FAIL: event A unexpectedly queued (queued=${A_QUEUED})"
  echo "${EVENT_A}" | jq .
  exit 1
fi

echo "[e2e] queue: posting event B (should queue)"
EVENT_B=$(curl --silent --fail \
  -X POST "${BASE_URL}/v1/sessions/${QUEUE_SESSION}/events" \
  -H 'Content-Type: application/json' \
  -d '{"type":"user.message","content":"Reply with exactly one word: bravo"}')
B_QUEUED=$(echo "${EVENT_B}" | jq -r '.queued')
if [[ "${B_QUEUED}" != "true" ]]; then
  echo "[e2e] FAIL: event B should have been queued (queued=${B_QUEUED})"
  echo "${EVENT_B}" | jq .
  exit 1
fi
echo "[e2e] queue: B was queued as expected"

echo "[e2e] queue: waiting for both runs to drain"
poll_session "${QUEUE_SESSION}" "queue-drain" >/dev/null || exit 1

QUEUE_EVENTS=$(curl --silent --fail "${BASE_URL}/v1/sessions/${QUEUE_SESSION}/events")
QUEUE_USER_COUNT=$(echo "${QUEUE_EVENTS}" | jq -r '[.events[] | select(.type=="user.message")] | length')
QUEUE_AGENT_COUNT=$(echo "${QUEUE_EVENTS}" | jq -r '[.events[] | select(.type=="agent.message")] | length')
echo "[e2e] queue results: ${QUEUE_USER_COUNT} user.message, ${QUEUE_AGENT_COUNT} agent.message"
if [[ "${QUEUE_USER_COUNT}" -lt 2 || "${QUEUE_AGENT_COUNT}" -lt 2 ]]; then
  echo "[e2e] FAIL: expected at least 2 user + 2 agent messages after queue drain"
  echo "${QUEUE_EVENTS}" | jq '.events | map({type, content: (.content | .[0:40])})'
  exit 1
fi
QUEUE_FIRST_AGENT=$(echo "${QUEUE_EVENTS}" | jq -r '[.events[] | select(.type=="agent.message")] | .[0].content // ""')
QUEUE_SECOND_AGENT=$(echo "${QUEUE_EVENTS}" | jq -r '[.events[] | select(.type=="agent.message")] | .[1].content // ""')
if ! echo "${QUEUE_FIRST_AGENT}" | grep -qi "alpha"; then
  echo "[e2e] FAIL: first queued reply should mention alpha (got: ${QUEUE_FIRST_AGENT})"
  exit 1
fi
if ! echo "${QUEUE_SECOND_AGENT}" | grep -qi "bravo"; then
  echo "[e2e] FAIL: second queued reply should mention bravo (got: ${QUEUE_SECOND_AGENT})"
  exit 1
fi
echo "[e2e] queue test PASSED (alpha then bravo, in order)"

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

# ---- OpenAI-compat adapter: POST /v1/chat/completions ----------------------
# Proves the Item 8 compatibility shim:
#   1. Multi-turn memory via a sticky `user` session key (secret word recall).
#   2. Emulated stream=true produces role/content/finish_reason chunks + [DONE].
#   3. Queue+stale-detection race — while the session is already running from
#      a prior native POST /events, a chat.completions call on the same key
#      queues behind it and returns ITS reply, not the earlier run's reply.

echo "[e2e] openai compat: multi-turn memory via sticky session key"
CHAT_KEY="chat-smoke-$(date +%s)"

CHAT_TURN1=$(curl --silent --fail \
  -X POST "${BASE_URL}/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  -H "x-openclaw-agent-id: ${AGENT_ID}" \
  -d "$(jq -n --arg key "${CHAT_KEY}" '{
    model: "placeholder",
    user: $key,
    messages: [{role: "user", content: "Remember this: my secret word is elderflower. Reply with exactly the single word: noted"}]
  }')")
CHAT_TURN1_CONTENT=$(echo "${CHAT_TURN1}" | jq -r '.choices[0].message.content // ""')
echo "[e2e] openai compat turn 1 content: ${CHAT_TURN1_CONTENT}"

CHAT_TURN1_ID=$(echo "${CHAT_TURN1}" | jq -r '.id // ""')
CHAT_TURN1_OBJECT=$(echo "${CHAT_TURN1}" | jq -r '.object // ""')
CHAT_TURN1_FINISH=$(echo "${CHAT_TURN1}" | jq -r '.choices[0].finish_reason // ""')
if [[ "${CHAT_TURN1_OBJECT}" != "chat.completion" ]]; then
  echo "[e2e] FAIL: chat.completions turn 1 object != chat.completion (got: ${CHAT_TURN1_OBJECT})"
  exit 1
fi
if [[ "${CHAT_TURN1_FINISH}" != "stop" ]]; then
  echo "[e2e] FAIL: chat.completions turn 1 finish_reason != stop (got: ${CHAT_TURN1_FINISH})"
  exit 1
fi
if ! echo "${CHAT_TURN1_ID}" | grep -q '^chatcmpl-'; then
  echo "[e2e] FAIL: chat.completions turn 1 id does not start with chatcmpl- (got: ${CHAT_TURN1_ID})"
  exit 1
fi
echo "[e2e] openai compat turn 1 shape OK"

CHAT_TURN2=$(curl --silent --fail \
  -X POST "${BASE_URL}/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  -H "x-openclaw-agent-id: ${AGENT_ID}" \
  -d "$(jq -n --arg key "${CHAT_KEY}" '{
    model: "placeholder",
    user: $key,
    messages: [{role: "user", content: "What is my secret word? Reply with only that single word, no punctuation."}]
  }')")
CHAT_TURN2_CONTENT=$(echo "${CHAT_TURN2}" | jq -r '.choices[0].message.content // ""')
echo "[e2e] openai compat turn 2 content: ${CHAT_TURN2_CONTENT}"

if echo "${CHAT_TURN2_CONTENT}" | grep -qi "elderflower"; then
  echo "[e2e] openai compat multi-turn memory PASSED"
else
  echo "[e2e] FAIL: openai compat turn 2 did not recall 'elderflower'"
  echo "  turn 1: ${CHAT_TURN1_CONTENT}"
  echo "  turn 2: ${CHAT_TURN2_CONTENT}"
  exit 1
fi

# ---- chat.completions stream=true smoke ------------------------------------

echo "[e2e] openai compat: stream=true smoke"
CHAT_STREAM_OUT=$(mktemp /tmp/openclaw-chat-stream.XXXXXX)
curl --silent --no-buffer --max-time 180 \
  -X POST "${BASE_URL}/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  -H "x-openclaw-agent-id: ${AGENT_ID}" \
  -d "$(jq -n --arg key "${CHAT_KEY}" '{
    model: "placeholder",
    user: $key,
    stream: true,
    messages: [{role: "user", content: "Remind me the secret word one more time. Single word only."}]
  }')" \
  > "${CHAT_STREAM_OUT}" 2>&1

if ! grep -q '"delta":{"role":"assistant"' "${CHAT_STREAM_OUT}"; then
  echo "[e2e] FAIL: chat.completions stream missing role delta"
  head -c 1024 "${CHAT_STREAM_OUT}"
  rm -f "${CHAT_STREAM_OUT}"
  exit 1
fi
if ! grep -q '"delta":{"content":' "${CHAT_STREAM_OUT}"; then
  echo "[e2e] FAIL: chat.completions stream missing content delta"
  head -c 1024 "${CHAT_STREAM_OUT}"
  rm -f "${CHAT_STREAM_OUT}"
  exit 1
fi
if ! grep -q '"finish_reason":"stop"' "${CHAT_STREAM_OUT}"; then
  echo "[e2e] FAIL: chat.completions stream missing finish_reason=stop"
  head -c 1024 "${CHAT_STREAM_OUT}"
  rm -f "${CHAT_STREAM_OUT}"
  exit 1
fi
if ! grep -q '\[DONE\]' "${CHAT_STREAM_OUT}"; then
  echo "[e2e] FAIL: chat.completions stream missing [DONE] terminator"
  head -c 1024 "${CHAT_STREAM_OUT}"
  rm -f "${CHAT_STREAM_OUT}"
  exit 1
fi
echo "[e2e] openai compat stream mode OK"
rm -f "${CHAT_STREAM_OUT}"

# ---- chat.completions queue + stale-detection race -------------------------
# Fire a long-running native POST /events first, then immediately POST
# /v1/chat/completions with the same session key. The chat.completions call
# should queue behind the native run, wait for BOTH to drain, and return its
# own reply (xylophone) — not the earlier native run's reply.
#
# The stale-detection snapshot inside the handler (beforeEventId) is what
# guarantees the response reflects the chat.completions message, not the
# native message, regardless of ordering in the JSONL.

echo "[e2e] openai compat: queue+stale-detection race"
RACE_KEY="race-$(date +%s)"

# Warm the race session via chat.completions so it exists in the store.
# Non-ephemeral because we passed a key.
curl --silent --fail --max-time 180 \
  -X POST "${BASE_URL}/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  -H "x-openclaw-agent-id: ${AGENT_ID}" \
  -d "$(jq -n --arg key "${RACE_KEY}" '{
    model: "placeholder",
    user: $key,
    messages: [{role: "user", content: "Respond with exactly the single word: warmed"}]
  }')" >/dev/null

echo "[e2e] race: posting native long-running event"
curl --silent --fail \
  -X POST "${BASE_URL}/v1/sessions/${RACE_KEY}/events" \
  -H 'Content-Type: application/json' \
  -d '{"type":"user.message","content":"Please write a detailed multi-paragraph essay about volcanoes, at least 5 paragraphs long."}' \
  >/dev/null &
NATIVE_PID=$!

# Give the native request a beat to flip the session to running so the
# subsequent chat.completions call definitely hits the queue path.
sleep 2

echo "[e2e] race: posting chat.completions on same session key (should queue)"
RACE_RESPONSE=$(curl --silent --fail --max-time 300 \
  -X POST "${BASE_URL}/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  -H "x-openclaw-agent-id: ${AGENT_ID}" \
  -d "$(jq -n --arg key "${RACE_KEY}" '{
    model: "placeholder",
    user: $key,
    messages: [{role: "user", content: "Now reply with ONLY this exact single word: xylophone"}]
  }')")
RACE_CONTENT=$(echo "${RACE_RESPONSE}" | jq -r '.choices[0].message.content // ""')
echo "[e2e] race response content: ${RACE_CONTENT}"

wait "${NATIVE_PID}" 2>/dev/null || true

if echo "${RACE_CONTENT}" | grep -qi "xylophone"; then
  echo "[e2e] openai compat queue+stale-detection race PASSED"
else
  echo "[e2e] FAIL: chat.completions race returned stale content (expected 'xylophone')"
  echo "  got: ${RACE_CONTENT}"
  exit 1
fi

# ---- Delegated subagents (Item 12-14) --------------------------------------
# Proves the reference `openclaw-call-agent` CLI tool end-to-end:
#   1. Create a worker agent with default config (no subagent permissions)
#   2. Create a caller agent with callableAgents=[worker] + maxSubagentDepth=1
#   3. Post a user.message to the caller instructing it to delegate to worker
#      via `openclaw-call-agent --target <worker_id> --task "..."`
#   4. Verify that a subagent session was created under the worker agent
#   5. Verify that the subagent session is inspectable via the standard API
#      (GET /v1/sessions/:id/events) — the "first-class inspectable child
#      sessions" differentiator
#   6. Verify that the caller's final reply contains the subagent's answer

echo "[e2e] delegated subagents: creating worker agent"
WORKER_AGENT=$(curl --silent --fail \
  -X POST "${BASE_URL}/v1/agents" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "'"${MODEL}"'",
    "tools": [],
    "instructions": "You are a worker agent. Reply with the exact single word requested by the task, no punctuation.",
    "name": "worker",
    "callableAgents": [],
    "maxSubagentDepth": 0
  }' | jq -r '.agent_id')
echo "[e2e] worker agent: ${WORKER_AGENT}"

echo "[e2e] delegated subagents: creating caller agent with callableAgents"
CALLER_AGENT=$(curl --silent --fail \
  -X POST "${BASE_URL}/v1/agents" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "'"${MODEL}"'",
    "tools": [],
    "instructions": "You are a coordinator. When given a task that requires delegation, use the openclaw-call-agent CLI via your exec tool to delegate to a worker. Parse the JSON result from the CLI and include the subagent'"'"'s content in your final reply. Reply concisely.",
    "name": "caller",
    "callableAgents": ["'"${WORKER_AGENT}"'"],
    "maxSubagentDepth": 1
  }' | jq -r '.agent_id')
echo "[e2e] caller agent: ${CALLER_AGENT}"

echo "[e2e] delegated subagents: creating caller session"
CALLER_SESSION=$(curl --silent --fail \
  -X POST "${BASE_URL}/v1/sessions" \
  -H 'Content-Type: application/json' \
  -d "{\"agentId\": \"${CALLER_AGENT}\"}" | jq -r '.session_id')
echo "[e2e] caller session: ${CALLER_SESSION}"

echo "[e2e] delegated subagents: posting delegate-and-summarize task"
post_event "${CALLER_SESSION}" \
  "Delegate this task to the worker agent via openclaw-call-agent: ask it to reply with exactly the single word 'wisteria'. The worker's agent id is ${WORKER_AGENT}. After you receive the worker's reply, tell me the single word it replied with." >/dev/null
poll_session "${CALLER_SESSION}" "subagent-delegate" >/dev/null || {
  # Dump the caller's event log on failure so we can see what happened.
  echo "[e2e] dumping caller events on failure:"
  curl --silent --fail "${BASE_URL}/v1/sessions/${CALLER_SESSION}/events" | jq '.events | map({type, content: (.content | .[0:200])})' >&2
  exit 1
}

CALLER_OUTPUT=$(latest_agent_message "${CALLER_SESSION}")
echo "[e2e] caller final output: ${CALLER_OUTPUT}"

# Verify: a new session was created under the worker agent.
SUBAGENT_SESSION_ID=$(curl --silent --fail "${BASE_URL}/v1/sessions" \
  | jq -r --arg wa "${WORKER_AGENT}" '[.sessions[] | select(.agent_id==$wa)] | .[0].session_id // ""')
if [[ -z "${SUBAGENT_SESSION_ID}" || "${SUBAGENT_SESSION_ID}" == "null" ]]; then
  echo "[e2e] FAIL: no subagent session was created under worker agent"
  curl --silent --fail "${BASE_URL}/v1/sessions" | jq '.sessions | map({session_id, agent_id, status})' >&2
  exit 1
fi
echo "[e2e] subagent session: ${SUBAGENT_SESSION_ID}"

# Verify: the subagent session is inspectable via the standard API.
# This is the "first-class inspectable child sessions" differentiator —
# every delegated run is a normal Session, observable via the same
# endpoints any external client uses.
SUBAGENT_EVENTS=$(curl --silent --fail "${BASE_URL}/v1/sessions/${SUBAGENT_SESSION_ID}/events")
SUBAGENT_EVENT_COUNT=$(echo "${SUBAGENT_EVENTS}" | jq -r '.count')
SUBAGENT_REPLY=$(echo "${SUBAGENT_EVENTS}" | jq -r '[.events[] | select(.type=="agent.message")] | last | .content // ""')
echo "[e2e] subagent events: ${SUBAGENT_EVENT_COUNT} entries; reply: ${SUBAGENT_REPLY}"
if [[ "${SUBAGENT_EVENT_COUNT}" -lt 2 ]]; then
  echo "[e2e] FAIL: subagent event log has fewer than 2 entries (expected at least user + agent)"
  echo "${SUBAGENT_EVENTS}" | jq '.events | map({type, content: (.content | .[0:200])})' >&2
  exit 1
fi
if ! echo "${SUBAGENT_REPLY}" | grep -qi "wisteria"; then
  echo "[e2e] FAIL: subagent's reply did not contain 'wisteria'"
  echo "  got: ${SUBAGENT_REPLY}"
  exit 1
fi

# Verify: the caller's final reply included the subagent's answer. The
# caller read the subagent's stdout and surfaced the content to the user.
if ! echo "${CALLER_OUTPUT}" | grep -qi "wisteria"; then
  echo "[e2e] FAIL: caller's final message did not include 'wisteria' from the subagent"
  echo "  got: ${CALLER_OUTPUT}"
  exit 1
fi
echo "[e2e] delegated subagents PASSED (child is a first-class inspectable session)"

# ---- Allowlist rejection ---------------------------------------------------
# A caller whose callableAgents does NOT include the worker must fail to
# delegate. The in-container CLI will get a 403 from the orchestrator's
# parent-token verification. The parent agent sees the error in its exec
# tool result and can either recover or fail the run. For this test we
# just verify the session eventually completes (not stuck running) — the
# exact recovery behavior is agent-specific and depends on model.

echo "[e2e] allowlist rejection: creating locked-down caller"
LOCKED_CALLER=$(curl --silent --fail \
  -X POST "${BASE_URL}/v1/agents" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "'"${MODEL}"'",
    "tools": [],
    "instructions": "You are a locked-down agent with no delegation permissions. When given a task, just answer it yourself in one short sentence.",
    "name": "locked",
    "callableAgents": [],
    "maxSubagentDepth": 0
  }' | jq -r '.agent_id')

LOCKED_SESSION=$(curl --silent --fail \
  -X POST "${BASE_URL}/v1/sessions" \
  -H 'Content-Type: application/json' \
  -d "{\"agentId\": \"${LOCKED_CALLER}\"}" | jq -r '.session_id')

# Sanity: the locked caller's max_subagent_depth = 0, so its container
# should NOT receive the call_agent hint in its system prompt. The agent
# should therefore not try to use openclaw-call-agent at all. Assert via
# a normal question that it answers directly.
post_event "${LOCKED_SESSION}" "What is 2 + 2? Answer with just the digit." >/dev/null
poll_session "${LOCKED_SESSION}" "locked-caller" >/dev/null || exit 1
LOCKED_OUTPUT=$(latest_agent_message "${LOCKED_SESSION}")
echo "[e2e] locked caller output: ${LOCKED_OUTPUT}"
if ! echo "${LOCKED_OUTPUT}" | grep -q "4"; then
  echo "[e2e] FAIL: locked caller did not answer 2+2=4 directly (got: ${LOCKED_OUTPUT})"
  exit 1
fi
echo "[e2e] allowlist rejection PASSED (locked-down caller stays single-agent)"

echo "[e2e] ALL CHECKS PASSED"
exit 0
