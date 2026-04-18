/**
 * Minimal single-page web portal for inspecting and driving the managed
 * runtime from a browser. Served at GET / when the Accept header
 * includes text/html (browsers). Machines hitting the same route with
 * Accept: application/json still get the endpoint self-documentation
 * map.
 *
 * Deliberately vanilla — no build step, no framework, no runtime deps.
 * Everything is fetch() against the same HTTP API the SDKs use, so any
 * behavior verified here is verified against the real surface.
 */

export const portalHtml = (opts: { authRequired: boolean; version: string }): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>OpenClaw Managed Agents — Console</title>
<style>
  :root {
    --bg: #0d1117;
    --bg-elev: #161b22;
    --bg-input: #0d1117;
    --border: #30363d;
    --border-muted: #21262d;
    --text: #e6edf3;
    --text-muted: #8b949e;
    --text-dim: #6e7681;
    --accent: #2f81f7;
    --accent-hover: #1f6feb;
    --success: #3fb950;
    --warn: #d29922;
    --danger: #f85149;
    --code-bg: #1f242c;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", Arial, sans-serif;
    font-size: 13px;
    background: var(--bg);
    color: var(--text);
    height: 100vh;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  header {
    padding: 10px 16px;
    background: var(--bg-elev);
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    gap: 16px;
    flex-shrink: 0;
  }
  header h1 { font-size: 14px; font-weight: 600; margin: 0; }
  header .version { color: var(--text-dim); font-size: 12px; font-family: ui-monospace, monospace; }
  header .spacer { flex: 1; }
  header a { color: var(--text-muted); text-decoration: none; font-size: 12px; padding: 4px 8px; border-radius: 4px; }
  header a:hover { background: var(--border-muted); color: var(--text); }
  header .auth { color: var(--warn); font-size: 12px; }
  main {
    flex: 1;
    display: grid;
    grid-template-columns: 280px 320px 1fr;
    min-height: 0;
  }
  .pane {
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .pane:last-child { border-right: none; }
  .pane-header {
    padding: 10px 14px;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: space-between;
    background: var(--bg-elev);
    flex-shrink: 0;
  }
  .pane-header h2 { font-size: 12px; font-weight: 600; margin: 0; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); }
  .pane-body { flex: 1; overflow-y: auto; padding: 8px 0; min-height: 0; }
  .list-empty { padding: 16px; color: var(--text-dim); font-style: italic; text-align: center; font-size: 12px; }
  .list-item {
    padding: 8px 14px;
    cursor: pointer;
    border-left: 2px solid transparent;
  }
  .list-item:hover { background: var(--border-muted); }
  .list-item.selected { background: var(--border-muted); border-left-color: var(--accent); }
  .list-item .primary {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 12px;
    color: var(--text);
    margin-bottom: 2px;
  }
  .list-item .secondary {
    font-size: 11px;
    color: var(--text-dim);
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .list-item .secondary .chip {
    padding: 1px 6px;
    border-radius: 3px;
    background: var(--bg-input);
    font-family: ui-monospace, monospace;
  }
  .status-running { color: var(--warn); }
  .status-idle { color: var(--success); }
  .status-failed { color: var(--danger); }
  .status-cancelled { color: var(--text-dim); }
  .status-archived { color: var(--text-dim); font-style: italic; }

  button {
    background: var(--accent);
    color: white;
    border: none;
    border-radius: 4px;
    padding: 5px 10px;
    font-size: 12px;
    cursor: pointer;
    font-family: inherit;
  }
  button:hover { background: var(--accent-hover); }
  button:disabled { background: var(--border); color: var(--text-dim); cursor: not-allowed; }
  button.secondary { background: var(--border); color: var(--text); }
  button.secondary:hover { background: var(--border-muted); }
  button.danger { background: transparent; color: var(--danger); border: 1px solid var(--danger); }
  button.danger:hover { background: var(--danger); color: white; }

  /* Detail pane */
  .detail { display: flex; flex-direction: column; min-height: 0; height: 100%; }
  .detail-empty { padding: 40px; text-align: center; color: var(--text-dim); }
  .detail-meta {
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 6px 14px;
    font-size: 12px;
    background: var(--bg-elev);
    flex-shrink: 0;
  }
  .detail-meta .label { color: var(--text-muted); }
  .detail-meta .value { font-family: ui-monospace, monospace; }
  .detail-events {
    flex: 1;
    overflow-y: auto;
    padding: 12px 16px;
    min-height: 0;
  }
  .event {
    margin-bottom: 12px;
    padding: 8px 12px;
    border-radius: 4px;
    background: var(--bg-elev);
    border-left: 3px solid var(--border);
  }
  .event.user { border-left-color: var(--accent); }
  .event.agent { border-left-color: var(--success); }
  .event.system { border-left-color: var(--text-dim); }
  .event.error { border-left-color: var(--danger); }
  .event .ev-type {
    font-family: ui-monospace, monospace;
    font-size: 11px;
    color: var(--text-muted);
    margin-bottom: 4px;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }
  .event .ev-content {
    font-size: 13px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .event .ev-meta { font-size: 11px; color: var(--text-dim); margin-top: 4px; font-family: ui-monospace, monospace; }

  .composer {
    border-top: 1px solid var(--border);
    padding: 10px 16px;
    display: flex;
    gap: 8px;
    background: var(--bg-elev);
    flex-shrink: 0;
  }
  .composer textarea {
    flex: 1;
    background: var(--bg-input);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 8px 10px;
    font-family: inherit;
    font-size: 13px;
    resize: none;
    min-height: 52px;
    max-height: 160px;
  }
  .composer textarea:focus { outline: none; border-color: var(--accent); }
  .composer .compose-actions { display: flex; flex-direction: column; gap: 6px; }

  /* Modal */
  .modal-backdrop {
    position: fixed; inset: 0;
    background: rgba(0, 0, 0, 0.6);
    display: flex; align-items: center; justify-content: center;
    z-index: 100;
  }
  .modal {
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: 6px;
    min-width: 480px;
    max-width: 640px;
    max-height: 80vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .modal h3 { margin: 0; padding: 14px 16px; border-bottom: 1px solid var(--border); font-size: 14px; }
  .modal-body { padding: 16px; overflow-y: auto; }
  .modal-footer { padding: 10px 16px; border-top: 1px solid var(--border); display: flex; gap: 8px; justify-content: flex-end; }
  .field { margin-bottom: 14px; }
  .field label { display: block; font-size: 12px; color: var(--text-muted); margin-bottom: 4px; }
  .field input, .field select, .field textarea {
    width: 100%;
    background: var(--bg-input);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 6px 10px;
    font-size: 13px;
    font-family: inherit;
  }
  .field textarea { min-height: 80px; resize: vertical; font-family: ui-monospace, monospace; font-size: 12px; }
  .field input:focus, .field select:focus, .field textarea:focus { outline: none; border-color: var(--accent); }
  .field .hint { font-size: 11px; color: var(--text-dim); margin-top: 3px; }

  .toast {
    position: fixed; bottom: 16px; right: 16px;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-left: 3px solid var(--accent);
    padding: 10px 14px;
    border-radius: 4px;
    font-size: 12px;
    z-index: 200;
    max-width: 340px;
  }
  .toast.error { border-left-color: var(--danger); }

  code { font-family: ui-monospace, monospace; font-size: 12px; background: var(--code-bg); padding: 1px 5px; border-radius: 3px; }
  .muted { color: var(--text-muted); }
  .spinner {
    display: inline-block; width: 10px; height: 10px;
    border: 2px solid var(--border); border-top-color: var(--accent);
    border-radius: 50%; animation: spin 0.8s linear infinite;
    vertical-align: middle; margin-right: 6px;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
<header>
  <h1>OpenClaw Managed Agents</h1>
  <span class="version">v${opts.version}</span>
  ${opts.authRequired ? '<span class="auth">🔒 auth: bearer required</span>' : '<span class="auth" style="color: var(--text-dim);">auth: disabled (localhost only)</span>'}
  <span class="spacer"></span>
  <a href="/healthz" target="_blank">healthz</a>
  <a href="/metrics" target="_blank">metrics</a>
  <a href="https://github.com/stainlu/openclaw-managed-agents" target="_blank">github</a>
</header>

<main>
  <section class="pane" id="agents-pane">
    <div class="pane-header">
      <h2>Agents</h2>
      <button id="btn-new-agent">+ New</button>
    </div>
    <div class="pane-body" id="agents-list"></div>
  </section>

  <section class="pane" id="sessions-pane">
    <div class="pane-header">
      <h2>Sessions</h2>
      <button id="btn-new-session" disabled>+ New</button>
    </div>
    <div class="pane-body" id="sessions-list">
      <div class="list-empty">Select an agent</div>
    </div>
  </section>

  <section class="pane detail" id="detail-pane">
    <div id="detail" class="detail-empty">Select a session</div>
  </section>
</main>

<template id="modal-new-agent">
  <div class="modal-backdrop">
    <div class="modal">
      <h3>Create agent</h3>
      <div class="modal-body">
        <div class="field">
          <label>Model <span class="muted">— provider/model slug from openclaw</span></label>
          <input id="fld-model" value="moonshot/kimi-k2.5" />
          <div class="hint">Examples: <code>anthropic/claude-sonnet-4-6</code>, <code>openai/gpt-5.4</code>, <code>google/gemini-2.5-pro</code>, <code>moonshot/kimi-k2.5</code>. The orchestrator forwards only the matching provider API key from its host env.</div>
        </div>
        <div class="field">
          <label>Instructions <span class="muted">— system prompt</span></label>
          <textarea id="fld-instructions" rows="4">You are a helpful assistant.</textarea>
        </div>
        <div class="field">
          <label>Permission policy</label>
          <select id="fld-policy">
            <option value="always_allow">always_allow (default)</option>
            <option value="deny">deny all tools</option>
            <option value="always_ask">always_ask (requires client confirmation)</option>
          </select>
          <div class="hint">Tools that will run inside the container. Empty tools array = text-only (safest).</div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="secondary" data-close="1">Cancel</button>
        <button id="btn-create-agent">Create</button>
      </div>
    </div>
  </div>
</template>

<script>
const API = ""; // same-origin
const S = {
  agents: [],
  sessions: [],
  selectedAgentId: null,
  selectedSessionId: null,
  detailPollTimer: null,
  listPollTimer: null,
  sessionsPollTimer: null,
};

// ---------- fetch helpers ----------
async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  const text = await res.text();
  const data = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null;
  if (!res.ok) {
    const err = new Error(typeof data === "string" ? data : (data?.error || res.statusText));
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

// ---------- UI helpers ----------
function fmtMs(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  const now = Date.now();
  const diff = now - ts;
  if (diff < 60_000) return Math.round(diff / 1000) + "s ago";
  if (diff < 3_600_000) return Math.round(diff / 60_000) + "m ago";
  if (diff < 86_400_000) return Math.round(diff / 3_600_000) + "h ago";
  return d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
function fmtCost(usd) {
  if (!usd) return "$0.00";
  if (usd < 0.01) return "$" + usd.toFixed(6);
  return "$" + usd.toFixed(4);
}
function fmtTokens(t) {
  if (!t) return "0";
  if (t < 1000) return String(t);
  return (t / 1000).toFixed(1) + "k";
}
function toast(msg, isError = false) {
  const el = document.createElement("div");
  el.className = "toast" + (isError ? " error" : "");
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// ---------- Agents pane ----------
async function loadAgents() {
  try {
    const data = await api("/v1/agents");
    S.agents = (data.agents || []).slice().sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
    renderAgents();
  } catch (err) {
    toast("Load agents: " + err.message, true);
  }
}

function renderAgents() {
  const list = document.getElementById("agents-list");
  if (!S.agents.length) {
    list.innerHTML = '<div class="list-empty">No agents yet. Click + New to create one.</div>';
    return;
  }
  list.innerHTML = "";
  for (const a of S.agents) {
    const el = document.createElement("div");
    el.className = "list-item" + (a.agent_id === S.selectedAgentId ? " selected" : "");
    const archived = a.archived_at ? '<span class="chip status-archived">archived</span>' : "";
    el.innerHTML = \`
      <div class="primary">\${a.agent_id}</div>
      <div class="secondary">
        <span class="chip">\${a.model}</span>
        <span>v\${a.version}</span>
        \${archived}
      </div>
    \`;
    el.onclick = () => selectAgent(a.agent_id);
    list.appendChild(el);
  }
}

function selectAgent(agentId) {
  S.selectedAgentId = agentId;
  S.selectedSessionId = null;
  renderAgents();
  document.getElementById("btn-new-session").disabled = false;
  loadSessions();
  renderDetail();
}

// ---------- Sessions pane ----------
async function loadSessions() {
  if (!S.selectedAgentId) return;
  try {
    const data = await api("/v1/sessions");
    const all = (data.sessions || []);
    S.sessions = all
      .filter(s => s.agent_id === S.selectedAgentId)
      .sort((a, b) => (b.last_event_at || b.created_at || 0) - (a.last_event_at || a.created_at || 0));
    renderSessions();
  } catch (err) {
    toast("Load sessions: " + err.message, true);
  }
}

function renderSessions() {
  const list = document.getElementById("sessions-list");
  if (!S.selectedAgentId) {
    list.innerHTML = '<div class="list-empty">Select an agent</div>';
    return;
  }
  if (!S.sessions.length) {
    list.innerHTML = '<div class="list-empty">No sessions. Click + New.</div>';
    return;
  }
  list.innerHTML = "";
  for (const s of S.sessions) {
    const el = document.createElement("div");
    el.className = "list-item" + (s.session_id === S.selectedSessionId ? " selected" : "");
    const statusCls = "status-" + (s.status || "idle");
    const spinner = s.status === "running" ? '<span class="spinner"></span>' : "";
    el.innerHTML = \`
      <div class="primary">\${s.session_id}</div>
      <div class="secondary">
        <span class="\${statusCls}">\${spinner}\${s.status}</span>
        <span>\${fmtTokens((s.tokens?.input || 0) + (s.tokens?.output || 0))} tok</span>
        <span>\${fmtMs(s.last_event_at || s.created_at)}</span>
      </div>
    \`;
    el.onclick = () => selectSession(s.session_id);
    list.appendChild(el);
  }
}

function selectSession(sessionId) {
  S.selectedSessionId = sessionId;
  renderSessions();
  refreshDetail();
}

// ---------- Detail pane ----------
async function refreshDetail() {
  const pane = document.getElementById("detail-pane");
  if (!S.selectedSessionId) {
    pane.innerHTML = '<div id="detail" class="detail-empty">Select a session</div>';
    return;
  }
  try {
    const [session, events] = await Promise.all([
      api("/v1/sessions/" + S.selectedSessionId),
      api("/v1/sessions/" + S.selectedSessionId + "/events?limit=200"),
    ]);
    renderDetail(session, events.events || []);
  } catch (err) {
    pane.innerHTML = \`<div class="detail-empty" style="color: var(--danger);">Load session: \${err.message}</div>\`;
  }
}

function renderDetail(session, events) {
  const pane = document.getElementById("detail-pane");
  if (!session) return;
  const statusCls = "status-" + (session.status || "idle");
  const isRunning = session.status === "running";
  const eventsHtml = events.length
    ? events.map(e => renderEvent(e)).join("")
    : '<div class="muted" style="padding: 20px; text-align: center;">No events yet. Send a message below.</div>';

  pane.innerHTML = \`
    <div class="detail">
      <div class="detail-meta">
        <span class="label">Session</span><span class="value">\${session.session_id}</span>
        <span class="label">Agent</span><span class="value">\${session.agent_id}</span>
        <span class="label">Status</span><span class="value \${statusCls}">\${isRunning ? '<span class="spinner"></span>' : ""}\${session.status}\${session.error ? " — " + session.error : ""}</span>
        <span class="label">Tokens</span><span class="value">\${session.tokens?.input || 0} in / \${session.tokens?.output || 0} out</span>
        <span class="label">Cost</span><span class="value">\${fmtCost(session.cost_usd || 0)}</span>
        <span class="label">Last event</span><span class="value">\${fmtMs(session.last_event_at)}</span>
      </div>
      <div class="detail-events" id="detail-events">\${eventsHtml}</div>
      <div class="composer">
        <textarea id="composer-text" placeholder="Type a message and press Enter (Shift+Enter for newline)" \${isRunning ? "disabled" : ""}></textarea>
        <div class="compose-actions">
          <button id="btn-send" \${isRunning ? "disabled" : ""}>\${isRunning ? "Running…" : "Send"}</button>
          \${isRunning ? '<button id="btn-cancel" class="danger">Cancel</button>' : ''}
        </div>
      </div>
    </div>
  \`;

  const ev = document.getElementById("detail-events");
  ev.scrollTop = ev.scrollHeight;

  document.getElementById("btn-send").onclick = sendMessage;
  const ta = document.getElementById("composer-text");
  ta.onkeydown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };
  ta.focus();

  const cancelBtn = document.getElementById("btn-cancel");
  if (cancelBtn) cancelBtn.onclick = cancelSession;
}

function renderEvent(e) {
  const type = e.type || "unknown";
  const isUser = type === "user.message";
  const isAgent = type === "agent.message";
  const isError = type === "agent.error" || type === "session.error";
  const isTool = type === "agent.tool_use" || type === "agent.tool_result";
  const cls = isUser ? "user" : isAgent ? "agent" : isError ? "error" : "system";

  let content = "";
  if (typeof e.content === "string") content = e.content;
  else if (Array.isArray(e.content)) {
    content = e.content.map(p => typeof p === "string" ? p : (p.text || JSON.stringify(p))).join("");
  } else if (e.content != null) content = JSON.stringify(e.content, null, 2);

  const meta = [];
  if (e.tokens_in || e.tokens_out) meta.push(\`\${e.tokens_in || 0} in / \${e.tokens_out || 0} out tok\`);
  if (e.cost_usd) meta.push(fmtCost(e.cost_usd));
  if (isTool && e.tool_name) meta.push("tool: " + e.tool_name);

  return \`
    <div class="event \${cls}">
      <div class="ev-type">\${type}</div>
      \${content ? \`<div class="ev-content">\${escapeHtml(content)}</div>\` : ""}
      \${meta.length ? \`<div class="ev-meta">\${meta.join(" · ")}</div>\` : ""}
    </div>
  \`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ---------- Actions ----------
async function sendMessage() {
  const ta = document.getElementById("composer-text");
  const content = ta.value.trim();
  if (!content || !S.selectedSessionId) return;
  ta.value = "";
  try {
    await api(\`/v1/sessions/\${S.selectedSessionId}/events\`, {
      method: "POST",
      body: JSON.stringify({ type: "user.message", content }),
    });
    refreshDetail();
  } catch (err) {
    toast("Send failed: " + err.message, true);
    ta.value = content;
  }
}

async function cancelSession() {
  if (!S.selectedSessionId) return;
  try {
    await api(\`/v1/sessions/\${S.selectedSessionId}/cancel\`, { method: "POST" });
    toast("Cancel requested");
    refreshDetail();
  } catch (err) {
    toast("Cancel: " + err.message, true);
  }
}

// ---------- Modals ----------
function openNewAgent() {
  const tpl = document.getElementById("modal-new-agent");
  const node = tpl.content.cloneNode(true);
  document.body.appendChild(node);

  const backdrop = document.querySelector(".modal-backdrop");
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop || e.target.dataset.close) backdrop.remove();
  });
  document.getElementById("btn-create-agent").onclick = async () => {
    const model = document.getElementById("fld-model").value.trim();
    const instructions = document.getElementById("fld-instructions").value.trim();
    const policy = document.getElementById("fld-policy").value;
    if (!model) { toast("Model is required", true); return; }
    try {
      const body = {
        model,
        instructions,
        tools: [],
        permissionPolicy: { type: policy },
      };
      const res = await api("/v1/agents", { method: "POST", body: JSON.stringify(body) });
      backdrop.remove();
      toast("Created " + res.agent_id);
      await loadAgents();
      selectAgent(res.agent_id);
    } catch (err) {
      toast("Create agent: " + err.message, true);
    }
  };
}

async function newSession() {
  if (!S.selectedAgentId) return;
  try {
    const s = await api("/v1/sessions", {
      method: "POST",
      body: JSON.stringify({ agentId: S.selectedAgentId }),
    });
    toast("Created " + s.session_id);
    await loadSessions();
    selectSession(s.session_id);
  } catch (err) {
    toast("New session: " + err.message, true);
  }
}

// ---------- Polling ----------
// Cheap polling loop — 1.5s when a running session is open, 5s otherwise.
// The detail pane is the only hot path; lists tick at 10s.
function startPolling() {
  S.listPollTimer = setInterval(loadAgents, 10_000);
  S.sessionsPollTimer = setInterval(() => {
    if (S.selectedAgentId) loadSessions();
  }, 5_000);
  S.detailPollTimer = setInterval(async () => {
    if (!S.selectedSessionId) return;
    try {
      const s = await api("/v1/sessions/" + S.selectedSessionId);
      if (s.status === "running" || s.status !== (S._lastDetailStatus || null)) {
        S._lastDetailStatus = s.status;
        await refreshDetail();
      }
    } catch { /* ignore transient */ }
  }, 1_500);
}

// ---------- Bootstrap ----------
document.getElementById("btn-new-agent").onclick = openNewAgent;
document.getElementById("btn-new-session").onclick = newSession;
loadAgents();
startPolling();
</script>
</body>
</html>`;
