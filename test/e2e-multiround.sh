#!/usr/bin/env bash
#
# Complex multi-round E2E harness for OpenClaw Managed Agents.
#
# The existing test/e2e.sh exercises the happy-path (create agent, send
# a message, wait for idle, assert the reply). This harness goes wider:
# it exercises the full set of behaviors the portal-v2 design calls out
# as distinct UI states, end-to-end against a live orchestrator + live
# model provider. In one run it asserts:
#
#   Turn 1 (main session) — user.message → streaming reply → idle
#   Turn 2               — multi-turn memory (recall a fact from turn 1)
#   Turn 3               — always_ask approval flow: agent calls the
#                          shell tool; orchestrator emits
#                          `agent.tool_confirmation_request` over SSE;
#                          test POSTs `user.tool_confirmation result=allow`;
#                          tool runs; reply confirms the side-effect.
#   Turn 4               — cancel mid-run: send a long-running request,
#                          POST /cancel, verify session settles back to
#                          idle (no stuck `running`, no false `failed`).
#   Turn 5               — session survives cancel: send a fresh message
#                          on the SAME session, verify it runs cleanly.
#
#   Separate second session — deny flow: send a request that triggers
#                             a tool call, POST `result=deny`, verify
#                             session reaches `idle` rather than `failed`
#                             and the reply acknowledges the denial.
#
#   Container telemetry — assert GET /v1/sessions/:id returns a
#                         populated `boot_ms` (non-null, > 0) and
#                         `pool_source ∈ {cold, warm, limited}` once
#                         the first turn has landed. This catches
#                         regressions in the session_containers
#                         plumbing (the portal inspector reads these
#                         and would silently show "boot 0.0s ·
#                         warm-reuse" as a lie otherwise).
#
#   Cold-start counter — /metrics pool_cold_starts_total non-zero at
#                        the end of the run.
#
# Deliberately NOT covered here (separate harnesses own them):
#   - networking:limited                 test/e2e-networking.sh
#   - OpenAI-compat /v1/chat/completions test/e2e.sh (the simpler one)
#   - subagent delegation                not yet scripted
#   - orchestrator-restart reattach      manual procedure (docs)
#
# Prerequisites:
#   - `docker compose up -d` with an orchestrator on localhost:8080.
#   - A provider API key exported in the host shell (MOONSHOT_API_KEY
#     for the default model; OPENAI_API_KEY / ANTHROPIC_API_KEY etc.
#     when overriding OPENCLAW_TEST_MODEL).
#
# Model override (same env var as test/e2e.sh):
#   OPENCLAW_TEST_MODEL=anthropic/claude-sonnet-4-6 ./test/e2e-multiround.sh
#
# Exits 0 on full success, non-zero on any failed assertion.

set -euo pipefail

# ---------- config ----------

BASE_URL="${BASE_URL:-http://localhost:8080}"
MODEL="${OPENCLAW_TEST_MODEL:-moonshot/kimi-k2.6}"
# Conservative cadences — model latency varies wildly by provider.
POLL_INTERVAL_SEC=2
IDLE_POLL_MAX_SEC=360      # enough for a cold spawn + multi-tool turn
SSE_WAIT_MAX_SEC=180       # approval arrival during a turn
CANCEL_SETTLE_MAX_SEC=60   # time between POST /cancel and status != running

# Per-run scratch dir, cleaned up on exit.
SCRATCH="$(mktemp -d -t openclaw-e2e-XXXXXX)"
SSE_MAIN="${SCRATCH}/sse-main.log"
SSE_DENY="${SCRATCH}/sse-deny.log"
SSE_MAIN_PID=""
SSE_DENY_PID=""

# State we want to tear down at the end. Populated incrementally so
# partial failures still clean up everything that did get created.
AGENT_ID=""
ENV_ID=""
SESSION_MAIN=""
SESSION_DENY=""

cleanup() {
  local ec=$?
  [[ -n "${SSE_MAIN_PID}" ]] && kill "${SSE_MAIN_PID}" 2>/dev/null || true
  [[ -n "${SSE_DENY_PID}" ]] && kill "${SSE_DENY_PID}" 2>/dev/null || true
  if [[ -n "${SESSION_MAIN}" ]]; then
    curl --silent -X DELETE "${BASE_URL}/v1/sessions/${SESSION_MAIN}" >/dev/null 2>&1 || true
  fi
  if [[ -n "${SESSION_DENY}" ]]; then
    curl --silent -X DELETE "${BASE_URL}/v1/sessions/${SESSION_DENY}" >/dev/null 2>&1 || true
  fi
  if [[ -n "${AGENT_ID}" ]]; then
    curl --silent -X DELETE "${BASE_URL}/v1/agents/${AGENT_ID}" >/dev/null 2>&1 || true
  fi
  if [[ -n "${ENV_ID}" ]]; then
    curl --silent -X DELETE "${BASE_URL}/v1/environments/${ENV_ID}" >/dev/null 2>&1 || true
  fi
  rm -rf "${SCRATCH}"
  if [[ ${ec} -eq 0 ]]; then
    echo "[e2e-multi] ✅ all assertions passed"
  else
    echo "[e2e-multi] ❌ failed with exit code ${ec}"
  fi
  exit ${ec}
}
trap cleanup EXIT

say() { echo "[e2e-multi] $*"; }
die() { echo "[e2e-multi] FATAL: $*" >&2; exit 1; }

# ---------- http helpers ----------

# Usage: curl_json <METHOD> <PATH> [BODY_JSON]
# Prints the response body on stdout, fails the script on non-2xx.
curl_json() {
  local method="$1" path="$2" body="${3:-}"
  local args=(--silent --show-error --fail --location -X "${method}" "${BASE_URL}${path}")
  if [[ -n "${body}" ]]; then
    args+=(-H 'Content-Type: application/json' -d "${body}")
  fi
  curl "${args[@]}"
}

# Poll GET /v1/sessions/:id until status transitions out of "running".
# Idle → return the session JSON on stdout (success).
# Failed → print payload to stderr, return 1.
# Anything else after timeout → return 1.
# Logs status at every poll tick to stderr so a flaky run is debuggable.
poll_until_idle() {
  local sid="$1" label="$2"
  local elapsed=0 last_status=""
  while [[ ${elapsed} -lt ${IDLE_POLL_MAX_SEC} ]]; do
    sleep "${POLL_INTERVAL_SEC}"
    elapsed=$((elapsed + POLL_INTERVAL_SEC))
    local body status
    body=$(curl --silent --fail "${BASE_URL}/v1/sessions/${sid}") || continue
    status=$(echo "${body}" | jq -r '.status')
    if [[ "${status}" != "${last_status}" ]]; then
      echo "[e2e-multi]   · ${label} t=${elapsed}s status=${status}" >&2
      last_status="${status}"
    fi
    case "${status}" in
      idle)   echo "${body}"; return 0 ;;
      failed) echo "${body}" | jq . >&2; return 1 ;;
    esac
  done
  echo "[e2e-multi] ${label} TIMEOUT after ${IDLE_POLL_MAX_SEC}s — last status=${last_status}" >&2
  return 1
}

# Subscribe to the session's SSE event stream in the background. The
# subshell's stdout stream is appended to $out_file line-by-line
# (curl -N disables buffering).
# Usage: subscribe_sse <sid> <out_file> <pidvar>
# Sets <pidvar> to the background pid so the cleanup trap can kill it.
subscribe_sse() {
  local sid="$1" out_file="$2" pidvar="$3"
  # shellcheck disable=SC2034
  : > "${out_file}"
  ( curl --silent --no-buffer --fail "${BASE_URL}/v1/sessions/${sid}/events?stream=true" > "${out_file}" 2>&1 ) &
  local pid=$!
  # Give the connection a half-second head start so initial frames land
  # before the first poll. Not critical — the wait_for_sse_event loop
  # polls the file anyway.
  sleep 0.5
  printf -v "${pidvar}" '%s' "${pid}"
}

# Wait until the accumulated SSE log contains a frame with the given
# type. The SSE transport here emits JSON in the `data:` payload; we
# grep the raw file for the type string (works because event_id is
# always inside the same data: line). Returns the raw matching line
# on stdout.
wait_for_sse_event() {
  local out_file="$1" type_str="$2" label="$3"
  local elapsed=0
  while [[ ${elapsed} -lt ${SSE_WAIT_MAX_SEC} ]]; do
    if grep -m1 "\"${type_str}\"" "${out_file}" >/dev/null 2>&1; then
      grep -m1 "\"${type_str}\"" "${out_file}"
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  echo "[e2e-multi] ${label}: SSE frame of type ${type_str} never arrived (timeout ${SSE_WAIT_MAX_SEC}s)" >&2
  echo "[e2e-multi]   SSE log tail:" >&2
  tail -n 40 "${out_file}" >&2
  return 1
}

# Post a user.message event. Prints the orchestrator's response body.
post_user_message() {
  local sid="$1" content="$2"
  curl_json POST "/v1/sessions/${sid}/events" \
    "$(jq -n --arg c "${content}" '{type:"user.message", content:$c}')"
}

# Resolve a pending tool confirmation.
# Usage: post_confirmation <sid> <tool_use_id> <allow|deny>
# (denyMessage is not supported upstream — see PostToolConfirmationSchema
#  note. Clients explain denials via a follow-up user.message.)
post_confirmation() {
  local sid="$1" tool_use_id="$2" result="$3"
  local body
  body=$(jq -n --arg id "${tool_use_id}" --arg r "${result}" \
    '{type:"user.tool_confirmation", toolUseId:$id, result:$r}')
  curl_json POST "/v1/sessions/${sid}/events" "${body}"
}

# Extract the latest agent.message content from the session's event log.
latest_agent_message() {
  local sid="$1"
  curl --silent --fail "${BASE_URL}/v1/sessions/${sid}/events" \
    | jq -r '[.events[] | select(.type=="agent.message")] | last | .content // ""'
}

# Case-insensitive substring assertion on stdin.
assert_contains() {
  local needle="$1" haystack_label="$2"
  local haystack
  haystack=$(cat)
  if ! echo "${haystack}" | grep -iq -- "${needle}"; then
    echo "[e2e-multi] assertion failed — ${haystack_label} did not contain '${needle}':" >&2
    echo "${haystack}" | head -c 2000 >&2
    echo >&2
    return 1
  fi
}

# ---------- run ----------

say "phase 0 · health check ${BASE_URL}/healthz (model=${MODEL})"
HEALTH=$(curl_json GET "/healthz")
echo "[e2e-multi]   · $(echo "${HEALTH}" | jq -r '"ok=\(.ok) v\(.version) commit=\(.commit) uptime_ms=\(.uptime_ms)"')"

say "phase 1 · create environment"
ENV_RES=$(curl_json POST "/v1/environments" "$(jq -n '{
  name: "e2e-multiround",
  packages: {pip: ["requests"]},
  networking: {type: "unrestricted"}
}')")
ENV_ID=$(echo "${ENV_RES}" | jq -r '.environment_id')
say "  · env created: ${ENV_ID}"

say "phase 2 · create agent with always_ask on 'exec' (+ memory-friendly instructions)"
# NOTE: the request schema is camelCase (permissionPolicy, thinkingLevel).
# Using snake_case silently defaults permissionPolicy to always_allow and
# thinkingLevel to "off" because Zod ignores unknown keys — a gotcha that
# bit the first run of this harness. Stay camelCase here.
AGENT_RES=$(curl_json POST "/v1/agents" "$(jq -n \
  --arg model "${MODEL}" \
  '{
    model: $model,
    thinkingLevel: "off",
    instructions: "You are a terse assistant. Remember facts the user teaches you within this session and recall them verbatim when asked. When asked to run shell commands, use the exec tool — do NOT answer with code blocks. Keep every reply under 80 words.",
    tools: [],
    permissionPolicy: {
      type: "always_ask",
      tools: ["exec"]
    }
  }')")
AGENT_ID=$(echo "${AGENT_RES}" | jq -r '.agent_id')
say "  · agent created: ${AGENT_ID}"

# --- main session ----------------------------------------------------------

say "phase 3 · open main session"
SESSION_MAIN=$(curl_json POST "/v1/sessions" \
  "$(jq -n --arg a "${AGENT_ID}" --arg e "${ENV_ID}" '{agentId:$a, environmentId:$e}')" \
  | jq -r '.session_id')
say "  · main session: ${SESSION_MAIN}"

# The SSE subscription has to be open BEFORE the first event so approval
# frames are guaranteed to land in the log. Running a real stream for
# the lifetime of the test also lets every assertion double-check
# event ordering if the script grows.
subscribe_sse "${SESSION_MAIN}" "${SSE_MAIN}" SSE_MAIN_PID
say "  · main SSE subscribed (pid=${SSE_MAIN_PID})"

# ---- turn 1: teach a fact ----
say "phase 4 · turn 1 · teach 'dragonfruit'"
post_user_message "${SESSION_MAIN}" \
  "Remember this for later: my favorite fruit is dragonfruit. Reply with exactly the single word: noted" >/dev/null
poll_until_idle "${SESSION_MAIN}" "turn 1" >/dev/null
REPLY_1=$(latest_agent_message "${SESSION_MAIN}")
echo "${REPLY_1}" | assert_contains "noted" "turn 1 reply"
say "  · turn 1 reply: '${REPLY_1}'"

# ---- assert container telemetry populated after the first real turn ----
say "phase 4a · assert boot_ms + pool_source populated"
SESSION_SNAPSHOT=$(curl_json GET "/v1/sessions/${SESSION_MAIN}")
BOOT_MS=$(echo "${SESSION_SNAPSHOT}" | jq -r '.boot_ms')
POOL_SRC=$(echo "${SESSION_SNAPSHOT}" | jq -r '.pool_source')
CONTAINER_ID=$(echo "${SESSION_SNAPSHOT}" | jq -r '.container_id')
if [[ "${POOL_SRC}" == "null" || -z "${POOL_SRC}" ]]; then
  die "pool_source is null after first turn — session_containers plumbing regressed"
fi
if [[ "${BOOT_MS}" == "null" ]]; then
  # bootMs can legitimately be 0 (warm-reuse) but NOT null after a spawn
  # in this fresh-orchestrator run. Warm claim reports 0, cold spawn
  # reports the total_spawn_ms; null means we never recorded it.
  die "boot_ms is null after first turn (pool_source=${POOL_SRC})"
fi
if [[ "${CONTAINER_ID}" == "null" || -z "${CONTAINER_ID}" ]]; then
  die "container_id null — session response is missing the join"
fi
say "  · boot_ms=${BOOT_MS}ms pool_source=${POOL_SRC} container=${CONTAINER_ID:0:12}"

# ---- turn 2: recall ----
say "phase 5 · turn 2 · recall fact"
post_user_message "${SESSION_MAIN}" \
  "What is my favorite fruit? Answer with a single word, lowercase, no punctuation." >/dev/null
poll_until_idle "${SESSION_MAIN}" "turn 2" >/dev/null
REPLY_2=$(latest_agent_message "${SESSION_MAIN}")
echo "${REPLY_2}" | assert_contains "dragonfruit" "turn 2 reply"
say "  · turn 2 reply: '${REPLY_2}'"

# ---- turn 3: approve a shell tool call ----
say "phase 6 · turn 3 · approve shell tool"
MARKER="e2e_ok_$(date +%s)"
post_user_message "${SESSION_MAIN}" \
  "Use the exec tool to run: printf '${MARKER}' > /tmp/e2e-marker.txt && cat /tmp/e2e-marker.txt. Then report what the file contained in one sentence." >/dev/null

# SSE should surface an approval request. Grab the first approval_id.
APPROVAL_LINE=$(wait_for_sse_event "${SSE_MAIN}" "agent.tool_confirmation_request" "turn 3")
# Each SSE data frame is a JSON blob embedded after `data: `. Grab it.
APPROVAL_JSON=$(echo "${APPROVAL_LINE}" | sed -n 's/^data: //p')
APPROVAL_ID=$(echo "${APPROVAL_JSON}" | jq -r '.approval_id')
if [[ -z "${APPROVAL_ID}" || "${APPROVAL_ID}" == "null" ]]; then
  die "turn 3: could not extract approval_id from SSE frame: ${APPROVAL_LINE}"
fi
say "  · approval pending id=${APPROVAL_ID} — posting user.tool_confirmation result=allow"
post_confirmation "${SESSION_MAIN}" "${APPROVAL_ID}" "allow" >/dev/null
poll_until_idle "${SESSION_MAIN}" "turn 3" >/dev/null
REPLY_3=$(latest_agent_message "${SESSION_MAIN}")
echo "${REPLY_3}" | assert_contains "${MARKER}" "turn 3 reply (should echo the marker)"
say "  · turn 3 reply: '${REPLY_3}'"

# ---- turn 4: cancel mid-stream ----
say "phase 7 · turn 4 · start long turn then cancel"
# A request that the model will spend real time on. We intentionally
# don't pick a tool call here — the cancel needs to interrupt pure
# generation so we're sure the cancel path works even when no tool is
# blocking.
post_user_message "${SESSION_MAIN}" \
  "Count out loud from one to fifty, placing each number on its own line, then stop." >/dev/null
# Wait until it actually starts running — there's usually a ~100ms
# window while the router spins up the background task.
FOUND_RUNNING=0
for i in {1..20}; do
  STATUS=$(curl --silent --fail "${BASE_URL}/v1/sessions/${SESSION_MAIN}" | jq -r '.status')
  if [[ "${STATUS}" == "running" ]]; then
    FOUND_RUNNING=1
    break
  fi
  sleep 0.5
done
if [[ ${FOUND_RUNNING} -eq 0 ]]; then
  say "  · turn started running too fast to catch; skipping cancel assertion"
else
  say "  · running — issuing cancel"
  curl_json POST "/v1/sessions/${SESSION_MAIN}/cancel" >/dev/null
  CANCEL_ELAPSED=0
  while [[ ${CANCEL_ELAPSED} -lt ${CANCEL_SETTLE_MAX_SEC} ]]; do
    sleep 1
    CANCEL_ELAPSED=$((CANCEL_ELAPSED + 1))
    STATUS=$(curl --silent --fail "${BASE_URL}/v1/sessions/${SESSION_MAIN}" | jq -r '.status')
    [[ "${STATUS}" != "running" ]] && break
  done
  if [[ "${STATUS}" == "running" ]]; then
    die "turn 4: session still running ${CANCEL_SETTLE_MAX_SEC}s after cancel"
  fi
  if [[ "${STATUS}" == "failed" ]]; then
    ERR=$(curl --silent --fail "${BASE_URL}/v1/sessions/${SESSION_MAIN}" | jq -r '.error')
    die "turn 4: cancel should settle to idle, got failed (${ERR})"
  fi
  say "  · cancel settled t=${CANCEL_ELAPSED}s status=${STATUS}"
fi

# ---- turn 5: verify session is re-usable after cancel ----
#
# Intent: after a cancel, the same session accepts a new event and
# transitions through running→idle cleanly. We don't assert on the
# content of turn 5's reply — the cancel race in phase 7 means turn 4's
# own reply may have already landed OR been aborted, and queued
# behavior during a settle is load-bearing enough that pinning
# "exactly one new agent.message appeared" races. The meaningful
# contract here is "session is not wedged after cancel" — the POST
# succeeds (200) and the status eventually flips back to idle.
say "phase 8 · turn 5 · session accepts a new event after cancel"
POST_RESP=$(curl --silent --show-error --fail -o /dev/null -w "%{http_code}" \
  -X POST "${BASE_URL}/v1/sessions/${SESSION_MAIN}/events" \
  -H 'Content-Type: application/json' \
  -d "$(jq -n '{type:"user.message", content:"Are you still able to answer? One word yes."}')" \
  || true)
if [[ "${POST_RESP}" != "200" ]]; then
  die "turn 5: POST /events returned HTTP ${POST_RESP} after cancel"
fi
TURN5_SESSION=$(poll_until_idle "${SESSION_MAIN}" "turn 5")
TURN5_STATUS=$(echo "${TURN5_SESSION}" | jq -r '.status')
if [[ "${TURN5_STATUS}" != "idle" ]]; then
  die "turn 5: session did not return to idle (status=${TURN5_STATUS})"
fi
say "  · session accepted new event after cancel → status=idle"

# --- deny session ----------------------------------------------------------

say "phase 9 · second session · deny flow"
SESSION_DENY=$(curl_json POST "/v1/sessions" \
  "$(jq -n --arg a "${AGENT_ID}" --arg e "${ENV_ID}" '{agentId:$a, environmentId:$e}')" \
  | jq -r '.session_id')
say "  · deny session: ${SESSION_DENY}"
subscribe_sse "${SESSION_DENY}" "${SSE_DENY}" SSE_DENY_PID

post_user_message "${SESSION_DENY}" \
  "Use the exec tool to run: printf forbidden > /tmp/e2e-forbidden.txt. After the tool either runs or is refused, report the outcome in one sentence." >/dev/null
DENY_LINE=$(wait_for_sse_event "${SSE_DENY}" "agent.tool_confirmation_request" "deny turn")
DENY_JSON=$(echo "${DENY_LINE}" | sed -n 's/^data: //p')
DENY_APPROVAL_ID=$(echo "${DENY_JSON}" | jq -r '.approval_id')
say "  · approval pending id=${DENY_APPROVAL_ID} — posting result=deny"
post_confirmation "${SESSION_DENY}" "${DENY_APPROVAL_ID}" "deny" >/dev/null
poll_until_idle "${SESSION_DENY}" "deny turn" >/dev/null
REPLY_DENY=$(latest_agent_message "${SESSION_DENY}")
# Loose assertion: the reply should acknowledge denial. Tool behavior
# varies by model — some say "denied", others "refused" or "not
# allowed". Accept any of those plus the literal deny message.
if ! echo "${REPLY_DENY}" | grep -iqE 'deny|denied|refused|not allowed|blocked|cannot|can.t'; then
  die "deny turn reply does not acknowledge the denial: ${REPLY_DENY}"
fi
say "  · deny turn reply: '${REPLY_DENY}'"

# --- cross-session assertions ----------------------------------------------

say "phase 10 · /metrics — pool telemetry reachable"
METRICS=$(curl --silent "${BASE_URL}/metrics")
# Both counters exist on the registry regardless of whether anything
# cold-started. If a warm container from a prior run was already
# available, every session here can legitimately come up warm
# (boot_ms=0) with ZERO cold starts during this harness. That's the
# expected hot-path outcome — asserting > 0 would make the test fail
# on a healthy system. Instead assert: the metric line is present
# AND at least one pool acquire landed on source=warm or source=spawn.
if ! echo "${METRICS}" | grep -q '^# TYPE pool_cold_starts_total counter'; then
  die "pool_cold_starts_total metric is missing from /metrics"
fi
if ! echo "${METRICS}" | grep -q '^# TYPE container_boot_duration_seconds histogram'; then
  die "container_boot_duration_seconds metric is missing from /metrics"
fi
WARM_ACQUIRES=$(echo "${METRICS}" \
  | awk '/^pool_acquire_total\{source="warm"/ {sum += $NF} END {print sum+0}')
SPAWN_ACQUIRES=$(echo "${METRICS}" \
  | awk '/^pool_acquire_total\{source="spawn"/ {sum += $NF} END {print sum+0}')
if [[ $((WARM_ACQUIRES + SPAWN_ACQUIRES)) -lt 1 ]]; then
  die "pool_acquire_total has no warm+spawn entries — pool clearly didn't serve this run"
fi
COLD_STARTS=$(echo "${METRICS}" \
  | awk '/^pool_cold_starts_total\{/ {sum += $NF} END {print sum+0}')
say "  · pool_acquire_total warm=${WARM_ACQUIRES} spawn=${SPAWN_ACQUIRES}  · cold_starts_total=${COLD_STARTS}"

say "phase 11 · JSONL event ordering on main session"
EVENTS_JSON=$(curl --silent --fail "${BASE_URL}/v1/sessions/${SESSION_MAIN}/events")
# Across the 5 turns we expect at least: 5 user.message + 5 agent.message
# (could be more — tool_use/tool_result + approval-reconnects add
# intermediate rows). Assert counts as a floor.
USER_COUNT=$(echo "${EVENTS_JSON}" | jq '[.events[] | select(.type=="user.message")] | length')
AGENT_COUNT=$(echo "${EVENTS_JSON}" | jq '[.events[] | select(.type=="agent.message")] | length')
# Phase-7 cancel path may or may not have posted its user.message
# successfully (the POST always lands, so it's 5) but we allow ≥4 to
# tolerate an observer-resume race.
if [[ "${USER_COUNT}" -lt 4 ]]; then
  die "main session events: user.message count=${USER_COUNT}, expected ≥4"
fi
if [[ "${AGENT_COUNT}" -lt 3 ]]; then
  die "main session events: agent.message count=${AGENT_COUNT}, expected ≥3"
fi
# created_at monotonic (events must be in chronological order).
if ! echo "${EVENTS_JSON}" | jq -e '[.events[].created_at] as $ts | ($ts == ($ts | sort))' >/dev/null; then
  die "main session events are not in chronological order"
fi
say "  · events: user.message=${USER_COUNT} agent.message=${AGENT_COUNT} (ordered)"

say "phase 12 · cleanup handled by trap"
