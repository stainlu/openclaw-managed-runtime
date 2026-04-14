#!/usr/bin/env node

// openclaw-call-agent — in-container CLI for delegating to another agent.
//
// Installed into agent runtime images at /usr/local/bin/openclaw-call-agent.
// Reads OPENCLAW_ORCHESTRATOR_URL and OPENCLAW_ORCHESTRATOR_TOKEN from the
// container env (injected at spawn time by the orchestrator).
//
// This is Mario Zechner's recommended pattern from his MCP critique
// (mariozechner.at/posts/2025-11-02-what-if-you-dont-need-mcp): ship tools
// as CLI binaries the agent invokes via its existing `exec`/`bash` tool,
// with a README for progressive disclosure. No Pi-extension or OpenClaw-
// plugin integration is needed; the tool is a regular subprocess.
//
// The subagent spawned via this tool IS a first-class Session in the
// orchestrator's store. The orchestrator enforces the parent agent
// template's `callableAgents` allowlist and `maxSubagentDepth` cap via
// the X-OpenClaw-Parent-Token header verified by its own minter.
//
// Usage:
//   openclaw-call-agent --target <agent_id> --task "<prompt>"
//
// Output on success (stdout, JSON, single line):
//   {"subagent_session_id":"ses_xxx","content":"...","events_url":"..."}
//
// Output on failure (stderr + non-zero exit code):
//   openclaw-call-agent: <error message>

function die(msg, code = 1) {
  process.stderr.write(`openclaw-call-agent: ${msg}\n`);
  process.exit(code);
}

function printHelp() {
  process.stdout.write(
    [
      "openclaw-call-agent — delegate to another agent in this managed runtime",
      "",
      "Usage:",
      '  openclaw-call-agent --target <agent_id> --task "<prompt>"',
      "",
      "Required arguments:",
      "  --target <agent_id>  Target agent template id. Must be in the parent",
      "                       agent template's callableAgents allowlist.",
      '  --task "<prompt>"    Initial user.message content for the subagent.',
      "",
      "Environment (injected by the orchestrator at container spawn):",
      "  OPENCLAW_ORCHESTRATOR_URL     Base URL for the orchestrator HTTP API",
      "                                (typically http://openclaw-orchestrator:8080)",
      "  OPENCLAW_ORCHESTRATOR_TOKEN   Signed parent token authorizing subagent",
      "                                spawns under the parent's allowlist + depth",
      "",
      "Behavior:",
      "  1. POST /v1/sessions { agentId: target } with X-OpenClaw-Parent-Token",
      "     → returns the new subagent session id",
      "  2. POST /v1/sessions/<id>/events { content: task } → kicks off the run",
      "  3. Polls GET /v1/sessions/<id> every 2s until status != 'running'",
      "     (hard cap of 10 minutes)",
      "  4. Fetches GET /v1/sessions/<id>/events, extracts the last agent.message",
      "  5. Prints {subagent_session_id, content, events_url} as JSON to stdout",
      "",
      "Observability:",
      "  The subagent session is a first-class HTTP resource. While it runs,",
      "  anyone with orchestrator access can watch it live via:",
      "    GET <OPENCLAW_ORCHESTRATOR_URL>/v1/sessions/<subagent_session_id>/events?stream=true",
      "",
      "Errors:",
      "  403  parent token missing the target agent in its allowlist, or",
      "       parent token has no remaining subagent depth",
      "  404  target agent does not exist on the orchestrator",
      "  4xx/5xx other HTTP errors printed to stderr with the response body",
      "",
    ].join("\n"),
  );
}

function parseArgs() {
  const args = process.argv.slice(2);
  let target = null;
  let task = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--target") {
      target = args[++i];
    } else if (a === "--task") {
      task = args[++i];
    } else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else {
      die(`unknown argument: ${a}`, 2);
    }
  }
  if (!target) die("--target is required", 2);
  if (!task) die("--task is required", 2);
  return { target, task };
}

async function httpJson(method, url, headers, body) {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${method} ${url} returned ${res.status}: ${text.slice(0, 500)}`);
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch (err) {
    throw new Error(`${method} ${url} returned invalid JSON: ${text.slice(0, 500)}`);
  }
}

async function httpGet(url, headers) {
  return httpJson("GET", url, headers ?? {});
}

async function main() {
  const { target, task } = parseArgs();
  const url = process.env.OPENCLAW_ORCHESTRATOR_URL;
  const token = process.env.OPENCLAW_ORCHESTRATOR_TOKEN;
  if (!url) die("OPENCLAW_ORCHESTRATOR_URL is not set in the container env");
  if (!token) die("OPENCLAW_ORCHESTRATOR_TOKEN is not set in the container env");

  // 1. Create the subagent session. The orchestrator verifies the parent
  // token, checks the allowlist, and rejects with 403 if the target is
  // not permitted or depth is exhausted.
  let createdSession;
  try {
    createdSession = await httpJson(
      "POST",
      `${url}/v1/sessions`,
      { "x-openclaw-parent-token": token },
      { agentId: target },
    );
  } catch (err) {
    die(`failed to create subagent session: ${err.message}`);
  }
  const subagentSessionId = createdSession.session_id;
  if (!subagentSessionId) {
    die("orchestrator create-session response missing session_id");
  }

  // 2. Post the task as the first user.message event.
  try {
    await httpJson(
      "POST",
      `${url}/v1/sessions/${encodeURIComponent(subagentSessionId)}/events`,
      {},
      { content: task },
    );
  } catch (err) {
    die(`failed to post event to subagent ${subagentSessionId}: ${err.message}`);
  }

  // 3. Poll for completion. 10-minute hard cap matches the orchestrator's
  // runTimeoutMs default; if the run genuinely takes longer the parent
  // agent will see a timeout error and can retry.
  const started = Date.now();
  const TIMEOUT_MS = 10 * 60_000;
  const POLL_MS = 2000;
  let finalStatus = "running";
  let finalError = null;
  while (Date.now() - started < TIMEOUT_MS) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    let s;
    try {
      s = await httpGet(`${url}/v1/sessions/${encodeURIComponent(subagentSessionId)}`);
    } catch (err) {
      die(`failed to poll subagent ${subagentSessionId}: ${err.message}`);
    }
    if (s.status !== "running") {
      finalStatus = s.status;
      finalError = s.error || null;
      break;
    }
  }
  if (finalStatus === "running") {
    die(
      `subagent ${subagentSessionId} did not complete within ${TIMEOUT_MS}ms`,
    );
  }
  if (finalStatus === "failed") {
    die(`subagent ${subagentSessionId} failed: ${finalError || "unknown error"}`);
  }

  // 4. Fetch the events and extract the last agent.message content.
  let events;
  try {
    events = await httpGet(
      `${url}/v1/sessions/${encodeURIComponent(subagentSessionId)}/events`,
    );
  } catch (err) {
    die(`failed to fetch subagent ${subagentSessionId} events: ${err.message}`);
  }
  const list = Array.isArray(events.events) ? events.events : [];
  const agentMessages = list.filter((e) => e && e.type === "agent.message");
  const last = agentMessages[agentMessages.length - 1];
  const content = last && typeof last.content === "string" ? last.content : "";

  // 5. Emit a single-line JSON result. The parent agent sees this via its
  // exec/bash tool's stdout capture and can use the content directly.
  const result = {
    subagent_session_id: subagentSessionId,
    content,
    events_url: `${url}/v1/sessions/${subagentSessionId}/events`,
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((err) => {
  die(err && err.stack ? err.stack : String(err));
});
