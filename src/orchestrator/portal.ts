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
    grid-template-columns: auto 1fr auto 1fr;
    gap: 6px 14px;
    font-size: 12px;
    background: var(--bg-elev);
    flex-shrink: 0;
  }
  .detail-meta .label { color: var(--text-muted); }
  .detail-meta .value { font-family: ui-monospace, monospace; word-break: break-all; }
  .detail-meta .value.wide { grid-column: 2 / 5; }

  .timeline {
    display: flex;
    gap: 2px;
    padding: 8px 16px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-elev);
    flex-shrink: 0;
    overflow-x: auto;
  }
  .timeline .bead {
    height: 22px;
    min-width: 14px;
    flex: 0 0 auto;
    border-radius: 3px;
    background: var(--border);
    cursor: pointer;
    border: 1px solid transparent;
  }
  .timeline .bead:hover { border-color: var(--text-dim); }
  .timeline .bead.active { outline: 2px solid var(--accent); }
  .bead.user { background: #4c8bf5; }
  .bead.agent { background: #3fb950; }
  .bead.thinking { background: #a371f7; }
  .bead.tool { background: #d29922; }
  .bead.tool-error { background: var(--danger); }
  .bead.system { background: var(--text-dim); }

  .detail-events {
    flex: 1;
    overflow-y: auto;
    padding: 10px 14px;
    min-height: 0;
  }
  .tabbar {
    display: flex;
    gap: 0;
    background: var(--bg-elev);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .tabbar .tab {
    padding: 8px 16px;
    font-size: 12px;
    color: var(--text-muted);
    cursor: pointer;
    border-bottom: 2px solid transparent;
    font-family: inherit;
    background: transparent;
    border-top: none;
    border-left: none;
    border-right: none;
  }
  .tabbar .tab:hover { color: var(--text); background: var(--border-muted); }
  .tabbar .tab.active { color: var(--text); border-bottom-color: var(--accent); }
  .tabbar .spacer { flex: 1; }
  .tabbar .tab-action {
    align-self: center;
    margin-right: 10px;
    padding: 4px 10px;
    font-size: 11px;
    background: var(--border);
    color: var(--text);
    border: none;
    border-radius: 4px;
    cursor: pointer;
  }
  .tabbar .tab-action:hover { background: var(--border-muted); }
  .tabbar .tab-action:disabled { opacity: 0.5; cursor: not-allowed; }

  .logs-view, .files-view {
    flex: 1;
    overflow-y: auto;
    padding: 12px 14px;
    min-height: 0;
  }
  .logs-view pre {
    font-family: ui-monospace, monospace;
    font-size: 11px;
    line-height: 1.4;
    color: var(--text-muted);
    white-space: pre-wrap;
    word-break: break-all;
    margin: 0;
  }
  .files-view .crumb {
    padding: 4px 10px;
    font-size: 12px;
    color: var(--text-muted);
    font-family: ui-monospace, monospace;
    margin-bottom: 6px;
  }
  .files-view .crumb a { color: var(--accent); cursor: pointer; }
  .files-view .entry {
    display: grid;
    grid-template-columns: 20px 1fr 80px 100px;
    gap: 8px;
    padding: 4px 8px;
    cursor: pointer;
    border-radius: 3px;
    font-size: 12px;
  }
  .files-view .entry:hover { background: var(--border-muted); }
  .files-view .entry .icon { color: var(--text-dim); font-family: ui-monospace, monospace; }
  .files-view .entry .name { font-family: ui-monospace, monospace; color: var(--text); }
  .files-view .entry .size, .files-view .entry .mtime { text-align: right; color: var(--text-dim); font-family: ui-monospace, monospace; }
  .files-view .entry.dir .name { color: var(--accent); }
  .files-view .file-content {
    margin-top: 10px;
    padding: 10px;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: 4px;
    font-family: ui-monospace, monospace;
    font-size: 11px;
    line-height: 1.4;
    white-space: pre-wrap;
    word-break: break-all;
    max-height: 400px;
    overflow: auto;
  }
  .event {
    margin-bottom: 8px;
    padding: 8px 12px;
    border-radius: 4px;
    background: var(--bg-elev);
    border-left: 3px solid var(--border);
  }
  .event.user { border-left-color: #4c8bf5; }
  .event.agent { border-left-color: var(--success); }
  .event.thinking { border-left-color: #a371f7; background: var(--bg-input); }
  .event.tool { border-left-color: var(--warn); padding: 0; overflow: hidden; }
  .event.tool.error { border-left-color: var(--danger); }
  .event.system { border-left-color: var(--text-dim); background: var(--bg-input); font-size: 11px; }
  .event.error { border-left-color: var(--danger); }

  .event .ev-header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 12px;
    cursor: pointer;
    user-select: none;
  }
  .event.tool .ev-header { cursor: pointer; }
  .event.tool .ev-header:hover { background: var(--border-muted); }
  .event .chevron {
    font-size: 10px;
    color: var(--text-dim);
    width: 10px;
    display: inline-block;
    transition: transform 0.1s;
  }
  .event .chevron.open { transform: rotate(90deg); }
  .event .chip {
    padding: 1px 7px;
    border-radius: 3px;
    font-family: ui-monospace, monospace;
    font-size: 11px;
    text-transform: lowercase;
    background: var(--code-bg);
    color: var(--text-muted);
  }
  .event .chip.role-user { background: #1b3a6b; color: #b3cafb; }
  .event .chip.role-agent { background: #143d21; color: #7ed58b; }
  .event .chip.role-thinking { background: #3a1e52; color: #d1b0ff; }
  .event .chip.role-tool { background: #4a3410; color: #f5cf7a; }
  .event .chip.role-tool.error { background: #5a1d1d; color: #ffb3b3; }
  .event .ev-summary {
    flex: 1;
    min-width: 0;
    font-size: 13px;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .event .ev-meta { font-size: 11px; color: var(--text-dim); font-family: ui-monospace, monospace; flex-shrink: 0; }
  .event .ev-body {
    padding: 0 12px 10px 30px;
    font-size: 13px;
    line-height: 1.5;
  }
  .event.agent .ev-body,
  .event.user .ev-body,
  .event.thinking .ev-body {
    padding: 0 12px 8px 12px;
  }
  .event .ev-body.hidden { display: none; }
  .event .ev-content {
    white-space: pre-wrap;
    word-break: break-word;
  }
  .event .ev-content.code {
    font-family: ui-monospace, monospace;
    font-size: 12px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 8px 10px;
    max-height: 320px;
    overflow: auto;
  }
  .event .ev-section-label {
    font-size: 11px;
    color: var(--text-muted);
    margin: 8px 0 3px 0;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

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
        <div class="field">
          <label>Thinking level <span class="muted">— Pi extended-thinking budget</span></label>
          <select id="fld-thinking">
            <option value="off">off (default; no thinking)</option>
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
            <option value="xhigh">xhigh</option>
          </select>
          <div class="hint">Only affects reasoning-capable models (e.g. <code>moonshot/kimi-k2-thinking</code>, <code>anthropic/claude-*</code>). Non-reasoning models silently ignore this.</div>
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
  activeTab: "trace",   // "trace" | "logs" | "files"
  filesPath: "",         // current directory in the files tab
  filesContent: null,    // { path, text } when a file is open for preview
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

  // Combine agent.tool_use + agent.tool_result pairs into a single row,
  // matched by tool_call_id. Orphan tool_use (result pending) shows a
  // spinner. Session-level metadata events are hidden by default.
  const rows = buildEventRows(events);
  const totalDuration = events.length
    ? (events[events.length - 1].created_at - events[0].created_at)
    : 0;
  const toolCount = rows.filter(r => r.kind === "tool").length;
  const tab = S.activeTab || "trace";

  const tabBody = tab === "trace"
    ? renderTraceTab(rows, isRunning)
    : tab === "logs"
      ? \`<div class="logs-view" id="logs-view"><div class="muted">Loading…</div></div>\`
      : \`<div class="files-view" id="files-view"><div class="muted">Loading…</div></div>\`;

  pane.innerHTML = \`
    <div class="detail">
      <div class="detail-meta">
        <span class="label">Session</span><span class="value">\${session.session_id}</span>
        <span class="label">Agent</span><span class="value">\${session.agent_id}</span>
        <span class="label">Status</span><span class="value \${statusCls}">\${isRunning ? '<span class="spinner"></span>' : ""}\${session.status}\${session.error ? " — " + escapeHtml(session.error) : ""}</span>
        <span class="label">Duration</span><span class="value">\${totalDuration ? fmtDuration(totalDuration) : "—"}</span>
        <span class="label">Tokens</span><span class="value">\${session.tokens?.input || 0} in / \${session.tokens?.output || 0} out</span>
        <span class="label">Cost</span><span class="value">\${fmtCost(session.cost_usd || 0)}</span>
        <span class="label">Tool calls</span><span class="value">\${toolCount}</span>
        <span class="label">Last event</span><span class="value">\${fmtMs(session.last_event_at)}</span>
      </div>
      <div class="tabbar">
        <button class="tab \${tab === "trace" ? "active" : ""}" data-tab="trace">Trace</button>
        <button class="tab \${tab === "logs" ? "active" : ""}" data-tab="logs">Container logs</button>
        <button class="tab \${tab === "files" ? "active" : ""}" data-tab="files">Workspace files</button>
        <span class="spacer"></span>
        <button class="tab-action" id="btn-compact" \${isRunning ? "disabled" : ""} title="Ask openclaw to summarize this session's history to free context">Compact</button>
      </div>
      \${tabBody}
    </div>
  \`;

  // Tab switching
  pane.querySelectorAll(".tabbar .tab").forEach((el) => {
    el.addEventListener("click", () => {
      S.activeTab = el.dataset.tab;
      renderDetail(session, events);
      if (S.activeTab === "logs") refreshLogs();
      if (S.activeTab === "files") refreshFiles();
    });
  });

  const compactBtn = document.getElementById("btn-compact");
  if (compactBtn) compactBtn.onclick = compactSession;

  if (tab === "trace") {
    wireTraceInteractions(pane, isRunning);
  } else if (tab === "logs") {
    refreshLogs();
  } else if (tab === "files") {
    refreshFiles();
  }
}

function renderTraceTab(rows, isRunning) {
  const eventsHtml = rows.length
    ? rows.map((r, i) => renderRow(r, i)).join("")
    : '<div class="muted" style="padding: 20px; text-align: center;">No events yet. Send a message below.</div>';
  const timelineHtml = rows.length
    ? rows.map((r, i) => {
        const cls = r.kind === "tool" && r.isError ? "tool-error" : r.kind;
        const title = r.kind === "tool"
          ? r.toolName + (r.duration != null ? \` · \${fmtDuration(r.duration)}\` : "")
          : r.kind + (r.summary ? ": " + r.summary.slice(0, 60) : "");
        return \`<div class="bead \${cls}" data-idx="\${i}" title="\${escapeAttr(title)}"></div>\`;
      }).join("")
    : "";
  return \`
    \${timelineHtml ? \`<div class="timeline">\${timelineHtml}</div>\` : ""}
    <div class="detail-events" id="detail-events">\${eventsHtml}</div>
    <div class="composer">
      <textarea id="composer-text" placeholder="Type a message and press Enter (Shift+Enter for newline)" \${isRunning ? "disabled" : ""}></textarea>
      <div class="compose-actions">
        <button id="btn-send" \${isRunning ? "disabled" : ""}>\${isRunning ? "Running…" : "Send"}</button>
        \${isRunning ? '<button id="btn-cancel" class="danger">Cancel</button>' : ''}
      </div>
    </div>
  \`;
}

function wireTraceInteractions(pane, _isRunning) {
  pane.querySelectorAll(".event .ev-header").forEach((h) => {
    h.addEventListener("click", () => {
      const body = h.parentElement.querySelector(".ev-body");
      const chev = h.querySelector(".chevron");
      if (!body) return;
      body.classList.toggle("hidden");
      if (chev) chev.classList.toggle("open");
    });
  });
  pane.querySelectorAll(".timeline .bead").forEach((b) => {
    b.addEventListener("click", () => {
      const idx = b.dataset.idx;
      const row = document.getElementById("row-" + idx);
      if (row) {
        row.scrollIntoView({ behavior: "smooth", block: "center" });
        row.style.outline = "2px solid var(--accent)";
        setTimeout(() => { row.style.outline = ""; }, 1200);
      }
    });
  });
  const ev = document.getElementById("detail-events");
  if (ev) ev.scrollTop = ev.scrollHeight;

  const sendBtn = document.getElementById("btn-send");
  if (sendBtn) sendBtn.onclick = sendMessage;
  const ta = document.getElementById("composer-text");
  if (ta) {
    ta.onkeydown = (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    };
    ta.focus();
  }
  const cancelBtn = document.getElementById("btn-cancel");
  if (cancelBtn) cancelBtn.onclick = cancelSession;
}

async function refreshLogs() {
  if (S.activeTab !== "logs" || !S.selectedSessionId) return;
  const el = document.getElementById("logs-view");
  if (!el) return;
  try {
    const res = await fetch(\`/v1/sessions/\${S.selectedSessionId}/logs?tail=500\`);
    if (!res.ok) {
      const body = await res.text();
      el.innerHTML = \`<div class="muted" style="color: var(--warn);">Logs unavailable: \${escapeHtml(body)}</div>\`;
      return;
    }
    const text = await res.text();
    el.innerHTML = \`<pre>\${escapeHtml(text)}</pre>\`;
    // Auto-scroll to bottom so the latest activity is visible.
    el.scrollTop = el.scrollHeight;
  } catch (err) {
    el.innerHTML = \`<div class="muted" style="color: var(--danger);">Error: \${escapeHtml(String(err.message || err))}</div>\`;
  }
}

async function refreshFiles() {
  if (S.activeTab !== "files" || !S.selectedAgentId) return;
  const el = document.getElementById("files-view");
  if (!el) return;
  const path = S.filesPath || "";
  const crumbs = ["<a data-path=\\"\\">/</a>"];
  if (path) {
    const parts = path.split("/");
    let acc = "";
    for (const p of parts) {
      acc = acc ? \`\${acc}/\${p}\` : p;
      crumbs.push(\` <a data-path="\${escapeAttr(acc)}">\${escapeHtml(p)}</a> /\`);
    }
  }
  const contentHtml = S.filesContent
    ? \`<div class="ev-section-label" style="margin-top: 12px;">\${escapeHtml(S.filesContent.path)}</div><div class="file-content">\${escapeHtml(S.filesContent.text)}</div>\`
    : "";
  try {
    const res = await fetch(\`/v1/agents/\${S.selectedAgentId}/files?path=\${encodeURIComponent(path)}\`);
    if (!res.ok) {
      const body = await res.text();
      el.innerHTML = \`<div class="muted" style="color: var(--warn);">\${escapeHtml(body)}</div>\`;
      return;
    }
    const data = await res.json();
    const rows = (data.entries || []).map(e => \`
      <div class="entry \${e.type}" data-name="\${escapeAttr(e.name)}" data-type="\${e.type}" data-path="\${escapeAttr(e.path)}">
        <span class="icon">\${e.type === "dir" ? "▸" : "·"}</span>
        <span class="name">\${escapeHtml(e.name)}</span>
        <span class="size">\${e.type === "dir" ? "—" : fmtBytes(e.size)}</span>
        <span class="mtime">\${fmtMs(e.mtime)}</span>
      </div>
    \`).join("");
    el.innerHTML = \`
      <div class="crumb">\${crumbs.join("")}</div>
      \${rows || '<div class="muted">Empty directory.</div>'}
      \${contentHtml}
    \`;
    el.querySelectorAll(".crumb a").forEach((a) => {
      a.addEventListener("click", () => {
        S.filesPath = a.dataset.path;
        S.filesContent = null;
        refreshFiles();
      });
    });
    el.querySelectorAll(".entry").forEach((row) => {
      row.addEventListener("click", async () => {
        const p = row.dataset.path;
        if (row.dataset.type === "dir") {
          S.filesPath = p;
          S.filesContent = null;
          refreshFiles();
          return;
        }
        try {
          const r = await fetch(\`/v1/agents/\${S.selectedAgentId}/files/\${p.split("/").map(encodeURIComponent).join("/")}\`);
          if (!r.ok) {
            toast("Read failed: " + r.status, true);
            return;
          }
          const buf = await r.arrayBuffer();
          const text = new TextDecoder("utf-8", { fatal: false }).decode(buf).slice(0, 200_000);
          S.filesContent = { path: p, text };
          refreshFiles();
        } catch (err) {
          toast("Read error: " + err.message, true);
        }
      });
    });
  } catch (err) {
    el.innerHTML = \`<div class="muted" style="color: var(--danger);">Error: \${escapeHtml(String(err.message || err))}</div>\`;
  }
}

async function compactSession() {
  if (!S.selectedSessionId) return;
  try {
    const res = await fetch(\`/v1/sessions/\${S.selectedSessionId}/compact\`, { method: "POST" });
    if (!res.ok) {
      const body = await res.text();
      toast("Compact: " + body, true);
      return;
    }
    toast("Compaction summary generated");
    refreshDetail();
  } catch (err) {
    toast("Compact error: " + err.message, true);
  }
}

function fmtBytes(n) {
  if (!n && n !== 0) return "—";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + " MB";
  return (n / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

/**
 * Fold the raw event stream into display rows:
 *   - user / agent / thinking / session.* → one row each
 *   - agent.tool_use → start a pending tool row
 *   - agent.tool_result → attach to the matching tool_use by tool_call_id
 *   - unmatched tool_result → standalone row
 */
function buildEventRows(events) {
  const pending = new Map(); // tool_call_id -> row ref
  const rows = [];
  for (const e of events) {
    const t = e.type;
    if (t === "user.message") {
      rows.push({ kind: "user", e, summary: asText(e.content) });
    } else if (t === "agent.message") {
      rows.push({
        kind: "agent", e,
        summary: asText(e.content),
        tokensIn: e.tokens_in, tokensOut: e.tokens_out, cost: e.cost_usd,
      });
    } else if (t === "agent.thinking") {
      rows.push({ kind: "thinking", e, summary: asText(e.content) });
    } else if (t === "agent.tool_use") {
      const row = {
        kind: "tool", e,
        toolName: e.tool_name || "(tool)",
        toolCallId: e.tool_call_id,
        toolArgs: e.tool_arguments,
        toolResult: null,
        isError: false,
        startedAt: e.created_at,
        finishedAt: null,
        duration: null,
        summary: buildToolSummary(e.tool_name, e.tool_arguments),
      };
      rows.push(row);
      if (e.tool_call_id) pending.set(e.tool_call_id, row);
    } else if (t === "agent.tool_result") {
      const match = e.tool_call_id ? pending.get(e.tool_call_id) : null;
      if (match) {
        match.toolResult = asText(e.content);
        match.isError = !!e.is_error;
        match.finishedAt = e.created_at;
        match.duration = e.created_at - match.startedAt;
        pending.delete(e.tool_call_id);
      } else {
        // Orphan result (shouldn't happen, but don't drop it)
        rows.push({
          kind: "tool", e,
          toolName: e.tool_name || "(result)",
          toolResult: asText(e.content),
          isError: !!e.is_error,
          summary: "(orphan result)",
        });
      }
    } else if (t === "session.model_change" || t === "session.thinking_level_change" || t === "session.compaction") {
      rows.push({ kind: "system", e, summary: \`\${t.replace("session.", "")}: \${asText(e.content)}\` });
    } else if (t === "agent.error" || t === "session.error") {
      rows.push({ kind: "error", e, summary: asText(e.content) });
    } else {
      rows.push({ kind: "system", e, summary: t + ": " + asText(e.content) });
    }
  }
  return rows;
}

function buildToolSummary(name, args) {
  if (!args || typeof args !== "object") return name;
  // Heuristic one-line summary for common tools.
  if (args.command) return args.command;
  if (args.path) return args.path;
  if (args.file_path) return args.file_path;
  if (args.pattern) return args.pattern;
  if (args.url) return args.url;
  if (args.query) return args.query;
  // Fallback: the first string value.
  const firstStr = Object.values(args).find(v => typeof v === "string");
  return firstStr || name;
}

function asText(v) {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(p => typeof p === "string" ? p : (p?.text || JSON.stringify(p))).join("");
  if (v != null) return JSON.stringify(v);
  return "";
}

function renderRow(r, idx) {
  const rowId = "row-" + idx;
  if (r.kind === "tool") return renderToolRow(r, rowId);
  if (r.kind === "user") return renderSimpleRow(r, rowId, "user", "user");
  if (r.kind === "agent") return renderSimpleRow(r, rowId, "agent", "agent");
  if (r.kind === "thinking") return renderSimpleRow(r, rowId, "thinking", "thinking", { italic: true });
  if (r.kind === "error") return renderSimpleRow(r, rowId, "error", "error");
  // system
  return \`<div class="event system" id="\${rowId}"><div class="ev-body"><span class="chip">\${escapeHtml(r.summary)}</span></div></div>\`;
}

function renderSimpleRow(r, rowId, cssCls, chip, opts = {}) {
  const content = asText(r.e.content);
  const short = content.length > 160;
  const meta = [];
  if (r.tokensIn || r.tokensOut) meta.push(\`\${r.tokensIn || 0}in/\${r.tokensOut || 0}out\`);
  if (r.cost) meta.push(fmtCost(r.cost));
  return \`
    <div class="event \${cssCls}" id="\${rowId}">
      <div class="ev-header">
        <span class="chevron \${short ? "" : "open"}">▸</span>
        <span class="chip role-\${chip}">\${chip}</span>
        <span class="ev-summary"\${opts.italic ? ' style="font-style: italic; color: var(--text-muted);"' : ""}>\${escapeHtml(content.slice(0, 160))}\${short ? "…" : ""}</span>
        \${meta.length ? \`<span class="ev-meta">\${meta.join(" · ")}</span>\` : ""}
      </div>
      <div class="ev-body \${short ? "hidden" : ""}">
        <div class="ev-content"\${opts.italic ? ' style="font-style: italic; color: var(--text-muted);"' : ""}>\${escapeHtml(content)}</div>
      </div>
    </div>
  \`;
}

function renderToolRow(r, rowId) {
  const pending = !r.toolResult && r.startedAt;
  const resultShort = r.toolResult ? r.toolResult.slice(0, 200) : (pending ? "running…" : "");
  const argsJson = r.toolArgs ? JSON.stringify(r.toolArgs, null, 2) : null;
  const durationTxt = r.duration != null ? fmtDuration(r.duration) : (pending ? "…" : "");
  const errCls = r.isError ? " error" : "";
  return \`
    <div class="event tool\${errCls}" id="\${rowId}">
      <div class="ev-header">
        <span class="chevron">▸</span>
        <span class="chip role-tool\${errCls}">\${escapeHtml(r.toolName)}</span>
        <span class="ev-summary">\${escapeHtml(r.summary || "")}</span>
        \${durationTxt ? \`<span class="ev-meta">\${pending ? '<span class="spinner"></span>' : ""}\${durationTxt}</span>\` : ""}
      </div>
      <div class="ev-body hidden">
        \${argsJson ? \`<div class="ev-section-label">Arguments</div><div class="ev-content code">\${escapeHtml(argsJson)}</div>\` : ""}
        \${r.toolResult != null ? \`<div class="ev-section-label">\${r.isError ? "Error" : "Result"}</div><div class="ev-content code">\${escapeHtml(r.toolResult)}</div>\` : (pending ? '<div class="ev-section-label">Result</div><div class="ev-content code"><span class="spinner"></span>running…</div>' : "")}
      </div>
    </div>
  \`;
}

function fmtDuration(ms) {
  if (ms < 1000) return ms + "ms";
  const s = ms / 1000;
  if (s < 60) return s.toFixed(s < 10 ? 1 : 0) + "s";
  const m = Math.floor(s / 60);
  const rs = Math.round(s % 60);
  return m + "m " + rs + "s";
}

function escapeAttr(s) { return escapeHtml(String(s)).replace(/"/g, "&quot;"); }

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
    const thinkingLevel = document.getElementById("fld-thinking").value;
    if (!model) { toast("Model is required", true); return; }
    try {
      const body = {
        model,
        instructions,
        tools: [],
        permissionPolicy: { type: policy },
        thinkingLevel,
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
