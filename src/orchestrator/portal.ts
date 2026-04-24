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
    transition: transform 0.12s ease-out, box-shadow 0.12s ease-out;
  }
  .timeline .bead:hover {
    border-color: var(--text-dim);
    transform: translateY(-1px);
  }
  .timeline .bead.active { outline: 2px solid var(--accent); }
  /* The most recent step on a running session gets a pulsing glow so
     the reader's eye tracks the agent's current action. Removed as
     soon as the session flips back to idle (the next render doesn't
     add the class). */
  .timeline .bead.current {
    box-shadow: 0 0 0 0 rgba(47, 129, 247, 0.6);
    animation: beadPulse 1.2s ease-in-out infinite;
  }
  @keyframes beadPulse {
    0%, 100% { box-shadow: 0 0 0 0 rgba(47, 129, 247, 0.55); }
    50%      { box-shadow: 0 0 0 6px rgba(47, 129, 247, 0); }
  }
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
    /* Match ev-simple-header padding exactly so the [chip] starts at
       the same left X coordinate regardless of whether the row is a
       user bubble, agent bubble, or tool row. */
    padding: 8px 12px;
    cursor: pointer;
    user-select: none;
  }
  .event.tool .ev-header:hover { background: var(--border-muted); }
  .event .chevron {
    width: 10px;
    height: 10px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: transform 0.15s ease-out;
    opacity: 0.75;
  }
  /* Filled triangle via CSS borders — crisp at any zoom level and
     independent of the host font's unicode support. Replaces the
     earlier unicode triangle which rendered as a dot in small sizes. */
  .event .chevron::before {
    content: "";
    width: 0;
    height: 0;
    border-left: 6px solid currentColor;
    border-top: 4px solid transparent;
    border-bottom: 4px solid transparent;
    color: var(--text-muted);
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
  /* Tool chip: default amber (shell / process / catch-all). Category
     overrides below tint to match the tool's broad type so a reader
     can scan the trace by color — file ops one color, web ops another,
     so nothing requires reading each label to identify the step. */
  .event .chip.role-tool { background: #4a3410; color: #f5cf7a; }
  .event .chip.role-tool.error { background: #5a1d1d; color: #ffb3b3; }
  .event .chip.role-tool.cat-file  { background: #15305b; color: #a9cbff; }
  .event .chip.role-tool.cat-web   { background: #3a1e52; color: #d1b0ff; }
  .event .chip.role-tool.cat-media { background: #143d21; color: #7ed58b; }
  .event .chip.role-tool.cat-shell { background: #4a3410; color: #f5cf7a; }

  /* Chips default to Title Case so labels read like prose. */
  .event .chip { text-transform: capitalize; }
  .event .chip code, .event .chip:first-letter { }

  /* Fresh-row entrance animation — applied only to rows that weren't
     in the previous render. Subtle fade + downward slide so a long
     stream of tool calls plays visibly without distracting from
     existing content. */
  @keyframes stepIn {
    from { opacity: 0; transform: translateY(-4px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  .event.fresh { animation: stepIn 0.25s ease-out; }
  .timeline .bead.fresh { animation: stepIn 0.22s ease-out; }
  .event .ev-summary {
    flex: 1;
    min-width: 0;
    font-size: 13px;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .event .ev-meta {
    font-size: 11px;
    color: var(--text-dim);
    font-family: ui-monospace, monospace;
    flex-shrink: 0;
    /* Always float timing to the far right regardless of row type,
       so "Ns · 0:SS" lines up in a single column across every row. */
    margin-left: auto;
  }
  .event .ev-meta.pending-failed {
    color: var(--danger);
    cursor: pointer;
    padding: 2px 6px;
    border-radius: 4px;
    transition: background 0.12s ease-out;
  }
  .event .ev-meta.pending-failed:hover { background: color-mix(in srgb, var(--danger) 14%, transparent); }
  .event .ev-body {
    /* Same left indent as the simple-content body (12px) so tool row
       bodies line up with user/agent bubble contents. The earlier 30px
       indent was to clear the chevron — chevron is gone, indent with it. */
    padding: 0 12px 10px 12px;
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
  /* Simple-row layout: for user / agent / thinking / error events. A
     tight header with chip + meta on one line, then the full content
     below wrapping naturally. No overflow ellipsis, no expand/collapse
     — simple rows ARE the content, so there's nothing to hide. */
  .event .ev-simple-header {
    display: flex;
    align-items: center;
    gap: 10px;
    /* Match ev-header so chip + timing line up across row types. */
    padding: 8px 12px 2px;
  }
  .event .ev-simple-content {
    padding: 2px 12px 8px;
    font-size: 13px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
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

  .error-banner {
    margin: 0;
    padding: 12px 16px;
    background: #2a1416;
    border-top: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
    border-left: 3px solid var(--danger);
    flex-shrink: 0;
  }
  .error-banner .eb-title {
    font-size: 13px;
    font-weight: 600;
    color: #ffb3b3;
    margin-bottom: 4px;
  }
  .error-banner .eb-body {
    font-size: 12px;
    color: var(--text);
    line-height: 1.5;
  }
  .error-banner .eb-body code {
    background: rgba(0,0,0,0.3);
    padding: 1px 5px;
    border-radius: 3px;
    font-size: 11px;
  }
  .error-banner .eb-raw-toggle {
    margin-top: 8px;
    font-size: 11px;
    color: var(--text-muted);
    background: transparent;
    border: none;
    cursor: pointer;
    padding: 0;
    font-family: inherit;
    text-decoration: underline;
  }
  .error-banner .eb-raw {
    margin-top: 6px;
    font-family: ui-monospace, monospace;
    font-size: 11px;
    color: var(--text-dim);
    background: rgba(0,0,0,0.3);
    padding: 8px 10px;
    border-radius: 4px;
    white-space: pre-wrap;
    word-break: break-all;
  }
  .error-banner .eb-raw.hidden { display: none; }

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
          <div class="hint">Examples: <code>anthropic/claude-sonnet-4-6</code>, <code>openai/gpt-5.4</code>, <code>deepseek/deepseek-v4-pro</code>, <code>google/gemini-2.5-pro</code>, <code>moonshot/kimi-k2.5</code>. If <code>ZENMUX_API_KEY</code> is set, the runtime routes all models through ZenMux; otherwise it forwards the matching provider API key from the host env.</div>
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
        <div class="field">
          <label>Channels <span class="muted">— which adapters route to this agent</span></label>
          <label style="display: flex; align-items: center; gap: 8px; font-size: 12px; padding: 6px 0;">
            <input type="checkbox" id="fld-channel-telegram" style="margin: 0;" />
            <span>Enable Telegram <span class="muted">(pairs with the telegram-adapter container + <code>TELEGRAM_BOT_TOKEN</code> in .env)</span></span>
          </label>
          <div class="hint">Declarative binding. The adapter container with a bot token validates this flag at startup and refuses to route messages to agents that haven't opted in.</div>
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
  // Optimistic in-flight user messages, keyed by sessionId. Each
  // entry is { content, tempId, status: "sending" | "failed" }.
  // Injected into the trace view so the user sees their input
  // immediately — matters because when a turn fails BEFORE the
  // container can persist the user.message (e.g., credential refresh
  // failure), the message would otherwise vanish without a trace.
  // Cleared when the server-side events catch up (real user.message
  // arrives) OR the session has been idle for a poll cycle.
  pendingBySession: {},
  // Tracks which row ids were present in the last render per session —
  // lets us apply the fresh animation class only to rows that just
  // arrived, instead of re-animating everything on every poll.
  prevRowIdsBySession: {},
};

// Human-readable labels for tool chips. Keyed by tool_name. Anything
// not in this map falls back to a Title-cased version of the raw id.
const TOOL_LABELS = {
  exec: "Exec",
  bash: "Bash",
  read: "Read",
  write: "Write",
  edit: "Edit",
  apply_patch: "Patch",
  glob: "Glob",
  grep: "Grep",
  web_fetch: "Web fetch",
  web_search: "Web search",
  x_search: "X search",
  browser: "Browser",
  memory_search: "Memory search",
  memory_get: "Memory",
  image: "Image",
  image_generate: "Image gen",
  music_generate: "Music gen",
  video_generate: "Video gen",
  tts: "TTS",
  sessions_list: "Subagents",
  sessions_send: "Subagent send",
  sessions_spawn: "Spawn agent",
  sessions_yield: "Yield",
  subagents: "Subagents",
  code_execution: "Code exec",
  process: "Process",
};

// Tool chip color category. Keeps a trace scannable by color.
const TOOL_CATEGORY = {
  exec: "shell", bash: "shell", process: "shell", code_execution: "shell",
  read: "file", write: "file", edit: "file", apply_patch: "file",
  glob: "file", grep: "file",
  web_fetch: "web", web_search: "web", x_search: "web", browser: "web",
  image: "media", image_generate: "media", music_generate: "media",
  video_generate: "media", tts: "media",
};

function toolLabel(name) {
  if (!name) return "tool";
  return TOOL_LABELS[name] ?? name.charAt(0).toUpperCase() + name.slice(1).replace(/_/g, " ");
}
function toolCategory(name) {
  return TOOL_CATEGORY[name] ?? "shell";
}

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
    const telegramBadge = a.channels?.telegram?.enabled
      ? '<span class="chip" title="This agent answers on Telegram">telegram</span>'
      : "";
    el.innerHTML = \`
      <div class="primary">\${a.agent_id}</div>
      <div class="secondary">
        <span class="chip">\${a.model}</span>
        <span>v\${a.version}</span>
        \${telegramBadge}
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
  // Fire-and-forget warm-up. Starts spawning a container for this
  // agent NOW so that by the time the user types their first
  // message and clicks Send (typically 5-30s later), the pool has
  // a ready container to claim. Hides ~20s of cold-spawn latency.
  // The endpoint is idempotent — clicking back and forth between
  // agents doesn't rack up spawns.
  fetch(\`/v1/agents/\${agentId}/warm\`, { method: "POST" })
    .catch(() => { /* best-effort, never blocks UI */ });
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
  const rows = buildEventRows(events, session);
  // Splice in optimistic user messages that haven't landed in the
  // server event stream yet (the container hasn't persisted them).
  // Clear entries whose content already appears as a user.message
  // event — server caught up; pending tracking served its purpose.
  const pendingList = (S.pendingBySession[session.session_id] ?? []).slice();
  const realUserMessages = new Set(
    events.filter(e => e.type === "user.message").map(e => {
      const c = e.content;
      return typeof c === "string" ? c : "";
    }),
  );
  // Drop pending entries whose content is now in the real event
  // stream. Critical side-effect: transfer postedAt (client-side
  // click time) onto the matching real user.message event as
  // _clientPostedAt. This lets the user-row timing continue from
  // client wall clock across the pending→real transition — no
  // "sudden drop of 20s" when the real event arrives and we
  // otherwise would've switched anchor from client clock to server
  // clock (which starts after the container cold-spawn finishes).
  for (const p of pendingList) {
    const match = events.find(
      e => e.type === "user.message" && (typeof e.content === "string" ? e.content : "") === p.content,
    );
    if (match && p.postedAt != null) {
      match._clientPostedAt = p.postedAt;
    }
  }
  S.pendingBySession[session.session_id] = pendingList.filter(
    p => !realUserMessages.has(p.content),
  );
  // If the session transitioned to "failed", any pending bubble
  // corresponds to a message that never got processed. Flip it so
  // the red "failed · retry" affordance appears.
  if (session.status === "failed") {
    for (const p of S.pendingBySession[session.session_id]) {
      if (p.status === "sending") p.status = "failed";
    }
  }
  // NOTE: no time-based watchdog here. Agent runs routinely take
  // longer than any reasonable wall-clock limit (10-60s for a
  // multi-tool turn), and a watchdog fires during normal runs,
  // flashing a fake "failed" state. The POST error handler in
  // sendMessage() already handles network-level failures; the
  // session.status === "failed" branch above handles server-side
  // spawn/run failures. Everything else is legitimately "in flight"
  // and the bubble should stay as the regular user bubble until the
  // real message lands in the event stream and the filter above
  // removes it.
  // Pending user bubbles get their timing from postedAt so the "Ns ·
  // 0:00" pill shows up the instant the bubble renders, without
  // waiting for the real server event to land. Offset is 0 by
  // convention (pending user = start of its own turn); duration
  // ticks up on every poll.
  const nowForPending = Date.now();
  for (const p of S.pendingBySession[session.session_id]) {
    const durMs = p.postedAt ? Math.max(0, nowForPending - p.postedAt) : 0;
    rows.push({
      kind: "user",
      e: { content: p.content, _pending: p.status },
      offsetMs: 0,
      durationMs: durMs,
    });
  }
  const totalDuration = events.length
    ? (events[events.length - 1].created_at - events[0].created_at)
    : 0;
  const toolCount = rows.filter(r => r.kind === "tool").length;
  const tab = S.activeTab || "trace";

  // Compute the set of row ids that were already rendered on the
  // previous poll tick — used to apply the fresh animation class
  // ONLY to newly-arrived rows. Otherwise every re-render would play
  // the animation for all rows and look like a strobe.
  const sid = session.session_id;
  const prevIds = S.prevRowIdsBySession[sid] ?? new Set();
  const rowIdFor = (r, i) => r.e?.event_id ?? r.e?.tempId ?? ("idx:" + i);
  const currentIds = new Set(rows.map((r, i) => rowIdFor(r, i)));
  S.prevRowIdsBySession[sid] = currentIds;
  const freshIds = new Set([...currentIds].filter(id => !prevIds.has(id)));

  const tabBody = tab === "trace"
    ? renderTraceTab(rows, isRunning, { freshIds, rowIdFor })
    : tab === "logs"
      ? \`<div class="logs-view" id="logs-view"><div class="muted">Loading…</div></div>\`
      : \`<div class="files-view" id="files-view"><div class="muted">Loading…</div></div>\`;

  const errBanner = session.status === "failed" && session.error
    ? renderErrorBanner(session.error)
    : "";

  // Capture the user's current scroll position BEFORE we blow away
  // the DOM via innerHTML. We only auto-scroll-to-bottom if the user
  // was ALREADY at (or near) the bottom — otherwise we restore their
  // manual scroll position so polling doesn't fight their reading.
  // "Near bottom" = within 80px of the bottom, which covers small
  // paddings/visual gaps. No previous state (first render / tab
  // switch) → treat as at-bottom so the newest content is visible.
  const prevEv = document.getElementById("detail-events");
  const prevScrollTop = prevEv?.scrollTop ?? null;
  const wasAtBottom = prevEv == null
    ? true
    : (prevEv.scrollTop + prevEv.clientHeight >= prevEv.scrollHeight - 80);

  pane.innerHTML = \`
    <div class="detail">
      <div class="detail-meta">
        <span class="label">Session</span><span class="value">\${session.session_id}</span>
        <span class="label">Agent</span><span class="value">\${session.agent_id}</span>
        <span class="label">Status</span><span class="value \${statusCls}">\${isRunning ? '<span class="spinner"></span>' : ""}\${session.status}</span>
        <span class="label">Duration</span><span class="value">\${totalDuration ? fmtDuration(totalDuration) : "—"}</span>
        <span class="label">Tokens</span><span class="value">\${session.tokens?.input || 0} in / \${session.tokens?.output || 0} out</span>
        <span class="label">Cost</span><span class="value" title="Cost comes from the provider plugin's price catalog in the container. Moonshot and DeepSeek direct-provider v4 models currently rely on docker/provider-prices.json patches layered onto the bundled catalog; Anthropic / OpenAI / Google / xAI / Mistral / Bedrock report real cost automatically, and ZenMux-routed models use ZenMux's live catalog.">\${fmtCost(session.cost_usd || 0)}\${(session.cost_usd || 0) === 0 && (session.tokens?.input || 0) > 0 ? ' <span class="muted" style="font-size: 10px;">(catalog $0)</span>' : ""}</span>
        <span class="label">Tool calls</span><span class="value">\${toolCount}</span>
        <span class="label">Last event</span><span class="value">\${fmtMs(session.last_event_at)}</span>
      </div>
      \${errBanner}
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

  // Raw-error toggle inside the failure banner.
  const rawToggle = pane.querySelector(".eb-raw-toggle");
  if (rawToggle) {
    rawToggle.addEventListener("click", () => {
      const raw = pane.querySelector(".eb-raw");
      if (!raw) return;
      const isHidden = raw.classList.toggle("hidden");
      rawToggle.textContent = isHidden ? "Show raw error" : "Hide raw error";
    });
  }

  if (tab === "trace") {
    // Apply the scroll decision we captured above. This runs BEFORE
    // wireTraceInteractions (which previously unconditionally
    // scrolled to bottom — that behavior moved here with the
    // at-bottom check so manual scrolls survive the 1.5s poll).
    const newEv = document.getElementById("detail-events");
    if (newEv) {
      if (wasAtBottom) {
        newEv.scrollTop = newEv.scrollHeight;
      } else if (prevScrollTop != null) {
        newEv.scrollTop = prevScrollTop;
      }
    }
    wireTraceInteractions(pane, isRunning);
  } else if (tab === "logs") {
    refreshLogs();
  } else if (tab === "files") {
    refreshFiles();
  }
}

/**
 * Pattern-match known session error shapes into a friendly banner.
 * Preserves the raw error behind a toggle so developers debugging the
 * exact cause still have the original string. The matching is
 * deliberately shallow — matches the substrings the orchestrator
 * throws from RouterError constructors. If none match, fall back to
 * a generic "run failed" banner with the raw error visible.
 */
function renderErrorBanner(rawError) {
  const raw = String(rawError);
  let title = "Run failed";
  let body = "The run failed before the agent could produce a reply. Check the raw error below or open the Container logs tab for upstream details.";
  let autoShowRaw = true;

  if (/mcp_oauth credential .* refresh failed/i.test(raw)) {
    title = "OAuth credential couldn't refresh";
    const credMatch = raw.match(/credential (crd_[a-z0-9]+)/i);
    const credId = credMatch ? credMatch[1] : "the bound credential";
    body = \`The vault credential <code>\${escapeHtml(credId)}</code> is past its access-token expiry and the token endpoint refused the refresh (wrong client_id / wrong refresh_token / revoked app / network error). The developer's app needs to re-run OAuth for this end-user and rotate the credential: <br><br><code>DELETE /v1/vaults/:vaultId/credentials/\${escapeHtml(credId)}</code> then <code>POST /v1/vaults/:vaultId/credentials</code> with fresh <code>accessToken</code> + <code>refreshToken</code>.\`;
    autoShowRaw = false;
  } else if (/quota_exceeded/i.test(raw)) {
    title = "Quota exceeded";
    body = "This session hit the budget limit declared on its agent (cost, tokens, or wall duration). New events on this session will keep returning 429 until you raise the quota via <code>PATCH /v1/agents/:id</code> or create a new session.";
    autoShowRaw = false;
  } else if (/upstream model call failed|Incorrect API key|401/i.test(raw)) {
    title = "Upstream model call failed";
    body = "The provider rejected the request — usually a bad / expired API key in the orchestrator's env, or a rate-limit at the provider. Check <code>docker logs openclaw-orchestrator</code> and the provider's dashboard.";
    autoShowRaw = false;
  } else if (/container .* did not become ready|TypeError: fetch failed/i.test(raw)) {
    title = "Container failed to start";
    body = "The agent container booted but never answered <code>/readyz</code> within the timeout. Usually means the container crashed during init — open the Container logs tab to see the entrypoint output.";
    autoShowRaw = false;
  } else if (/credential_expired/i.test(raw)) {
    title = "Credential expired";
    body = "A credential bound to this session is no longer valid. Rotate it in the vault.";
    autoShowRaw = false;
  }

  return \`
    <div class="error-banner">
      <div class="eb-title">\${escapeHtml(title)}</div>
      <div class="eb-body">\${body}</div>
      <button class="eb-raw-toggle">\${autoShowRaw ? "Hide raw error" : "Show raw error"}</button>
      <div class="eb-raw \${autoShowRaw ? "" : "hidden"}">\${escapeHtml(raw)}</div>
    </div>
  \`;
}

function renderTraceTab(rows, isRunning, opts = {}) {
  const freshIds = opts.freshIds ?? new Set();
  const rowIdFor = opts.rowIdFor ?? ((r, i) => r.e?.event_id ?? ("idx:" + i));
  const lastIdx = rows.length - 1;
  const eventsHtml = rows.length
    ? rows.map((r, i) => {
        const isFresh = freshIds.has(rowIdFor(r, i));
        return renderRow(r, i, { fresh: isFresh });
      }).join("")
    : '<div class="muted" style="padding: 20px; text-align: center;">No events yet. Send a message below.</div>';
  const timelineHtml = rows.length
    ? rows.map((r, i) => {
        const cls = r.kind === "tool" && r.isError ? "tool-error" : r.kind;
        const title = r.kind === "tool"
          ? toolLabel(r.toolName) + (r.duration != null ? \` · \${fmtDuration(r.duration)}\` : "")
          : r.kind + (r.summary ? ": " + r.summary.slice(0, 60) : "");
        const classes = ["bead", cls];
        if (freshIds.has(rowIdFor(r, i))) classes.push("fresh");
        // Emphasize the last step while the session is live — reader's
        // eye follows the pulsing marker to the agent's current action.
        if (isRunning && i === lastIdx) classes.push("current");
        return \`<div class="\${classes.join(" ")}" data-idx="\${i}" title="\${escapeAttr(title)}"></div>\`;
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
  // Scroll positioning is handled in renderDetail — it knows whether
  // to auto-scroll (user was at the bottom) or preserve the user's
  // manual position. Nothing to do here.
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
  // Retry handler for bubbles whose POST failed (server bounced
  // mid-request, network hiccup, etc.). Click the red "failed ·
  // retry" badge to re-POST the original content.
  pane.querySelectorAll(".pending-failed").forEach((el) => {
    el.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const content = el.dataset.retry;
      if (!content || !S.selectedSessionId) return;
      retrySend(S.selectedSessionId, content);
    });
  });
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
function buildEventRows(events, session = null) {
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
  // Second pass: attach each row's offset + duration.
  //
  // OFFSET anchors to the MOST RECENT user.message. Each new user
  // turn resets the clock — so "0:05" on a tool row means 5s since
  // the user sent THIS turn's prompt, not 5s since the session was
  // first created. For rows that appear before any user.message
  // (session.model_change at session-init), offset falls back to the
  // first row's ts, but those are system rows that render without
  // timing anyway so the fallback is cosmetic.
  //
  // DURATION = time until the next row, except for tool rows which
  // already carry the real tool_use→tool_result delta (preferred —
  // measures the tool itself, not the gap to the next step).
  // Anchor: if the current user row has a _clientPostedAt (set by
  // renderDetail when a pending bubble's content matches this real
  // event), use THAT as the anchor ts. That's the client's actual
  // click time — anchoring here makes every offset in the turn
  // reflect wall-clock-since-click, including the orchestrator
  // cold-spawn window that's otherwise invisible in server
  // timestamps (container's JSONL clock only starts after cold
  // spawn finishes). For turns loaded from server with no pending
  // history (e.g., page refresh mid-session), fall back to the
  // server event ts — offsets then reflect only the post-cold-spawn
  // timeline, but there's no client reference to recover from.
  let anchorTs = rows.length > 0 ? (rows[0].e?.created_at ?? 0) : 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const ts = r.e?.created_at;
    if (typeof ts !== "number") continue;
    if (r.kind === "user") {
      anchorTs = r.e._clientPostedAt ?? ts;
    }
    r.offsetMs = Math.max(0, ts - anchorTs);
    if (r.kind === "tool" && typeof r.duration === "number") continue;
    const nextTs = rows[i + 1]?.e?.created_at;
    if (typeof nextTs === "number") r.durationMs = Math.max(0, nextTs - ts);
  }
  // Third pass — override user-row duration to reflect the WHOLE
  // TURN duration (user message → end of that turn), not the 2.5s
  // gap to the agent's first reaction. This matches how a human
  // reads "how long did this message take" — the full round-trip.
  //
  //   - Next user.message exists → turn ended when the user spoke
  //     again; duration = next_user.ts - this_user.ts.
  //   - No next user.message, session still running → turn
  //     in-progress; duration = now - this_user.ts (updates live
  //     via the 1.5s poll).
  //   - No next user.message, session idle/failed → turn finished
  //     at the last recorded event; duration = last.ts - this_user.ts.
  const now = Date.now();
  const lastTs = rows.length > 0 ? (rows[rows.length - 1]?.e?.created_at) : undefined;
  const running = session?.status === "running";
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.kind !== "user") continue;
    const thisTs = r.e?.created_at;
    if (typeof thisTs !== "number") continue;
    // Prefer client-side _clientPostedAt (actual click time) over
    // the server event ts (which starts AFTER the cold spawn). This
    // eliminates the "40s ticks down to 20s when exec appears"
    // discontinuity when a pending bubble is replaced by its real
    // event — both now use the same client click as the anchor.
    const startTs = r.e?._clientPostedAt ?? thisTs;
    let endTs;
    for (let j = i + 1; j < rows.length; j++) {
      if (rows[j].kind === "user") {
        const cand = rows[j].e?._clientPostedAt ?? rows[j].e?.created_at;
        if (typeof cand === "number") { endTs = cand; break; }
      }
    }
    if (endTs == null) {
      if (running) endTs = now;
      else if (typeof lastTs === "number" && lastTs >= thisTs) endTs = lastTs;
    }
    if (typeof endTs === "number") r.durationMs = Math.max(0, endTs - startTs);
  }
  // Intentionally NO dedup pass here. Moonshot/Kimi emits text+tool
  // intermediates during an agentic loop, and it's tempting to hide
  // the non-final agent.messages to avoid "duplicate-looking"
  // summaries. That created two worse bugs: (a) intermediates
  // flickered — shown at poll N, removed at poll N+1 when a newer
  // one arrived, reappearing as a different row; (b) by turn end,
  // all the agent's in-progress narration was gone and only the
  // final summary rendered, giving no sense of the model's
  // progression. Showing every agent.message in chronological order
  // with the tool calls interleaved matches what actually happened
  // in the turn — which is what the trace is for.
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

function renderRow(r, idx, opts = {}) {
  const rowId = "row-" + idx;
  const fresh = opts.fresh ? " fresh" : "";
  if (r.kind === "tool") return renderToolRow(r, rowId, fresh);
  if (r.kind === "user") return renderSimpleRow(r, rowId, "user", "user", { fresh });
  if (r.kind === "agent") return renderSimpleRow(r, rowId, "agent", "agent", { fresh });
  if (r.kind === "thinking") return renderSimpleRow(r, rowId, "thinking", "thinking", { italic: true, fresh });
  if (r.kind === "error") return renderSimpleRow(r, rowId, "error", "error", { fresh });
  // system
  return \`<div class="event system\${fresh}" id="\${rowId}"><div class="ev-body"><span class="chip">\${escapeHtml(r.summary)}</span></div></div>\`;
}

/**
 * Simple rows (user / agent / thinking / error) render as one natural
 * block: a small chip header with meta, then the full content beneath
 * that wraps normally. No preview-then-body split — that was fine for
 * tool rows (where the body is a big JSON blob worth collapsing) but
 * wrong for conversational text, because short messages ended up
 * shown twice (preview == full) and long messages got truncated to
 * one line with an ellipsis.
 *
 * Tool rows still use the expand/collapse ev-header/ev-body pattern
 * via renderToolRow — see there.
 */
function renderSimpleRow(r, rowId, cssCls, chip, opts = {}) {
  const content = asText(r.e.content);
  // Only timing per-row. Cost + tokens live in the session header
  // (top-right stat block) — showing them again on every row is
  // redundant and visually noisy.
  const timing = fmtStepTiming(r.durationMs, r.offsetMs);
  const pendingTag = r.e?._pending === "failed"
    ? \`<span class="ev-meta pending-failed" data-retry="\${escapeAttr(content)}" title="Click to retry">failed · retry ↻</span>\`
    : "";
  const contentStyle = opts.italic ? ' style="font-style: italic; color: var(--text-muted);"' : "";
  const freshCls = opts.fresh || "";
  return \`
    <div class="event \${cssCls}\${freshCls}" id="\${rowId}">
      <div class="ev-simple-header">
        <span class="chip role-\${chip}">\${chip}</span>
        \${timing ? \`<span class="ev-meta">\${timing}</span>\` : ""}
        \${pendingTag}
      </div>
      <div class="ev-simple-content"\${contentStyle}>\${escapeHtml(content)}</div>
    </div>
  \`;
}

function renderToolRow(r, rowId, fresh = "") {
  const pending = !r.toolResult && r.startedAt;
  const argsJson = r.toolArgs ? JSON.stringify(r.toolArgs, null, 2) : null;
  // For tool rows we prefer the REAL tool duration (tool_use →
  // tool_result delta) over the generic between-rows delta. Offset
  // still comes from the second pass in buildEventRows.
  const toolDuration = r.duration != null ? r.duration : r.durationMs;
  const timing = fmtStepTiming(toolDuration, r.offsetMs);
  const errCls = r.isError ? " error" : "";
  const category = toolCategory(r.toolName);
  const label = toolLabel(r.toolName);
  return \`
    <div class="event tool\${errCls}\${fresh}" id="\${rowId}">
      <div class="ev-header">
        <span class="chip role-tool cat-\${category}\${errCls}">\${escapeHtml(label)}</span>
        <span class="ev-summary">\${escapeHtml(r.summary || "")}</span>
        \${timing || pending ? \`<span class="ev-meta">\${pending ? '<span class="spinner"></span>' : ""}\${timing || "running…"}</span>\` : ""}
      </div>
      <div class="ev-body hidden">
        \${argsJson ? \`<div class="ev-section-label">Arguments</div><div class="ev-content code">\${escapeHtml(argsJson)}</div>\` : ""}
        \${r.toolResult != null ? \`<div class="ev-section-label">\${r.isError ? "Error" : "Result"}</div><div class="ev-content code">\${escapeHtml(r.toolResult)}</div>\` : (pending ? '<div class="ev-section-label">Result</div><div class="ev-content code"><span class="spinner"></span>running…</div>' : "")}
      </div>
    </div>
  \`;
}

/**
 * Format an offset-from-session-start timestamp as m:ss (or h:mm:ss).
 * Matches CMA's compact "0:05" / "1:32" style. For the first row the
 * offset is always 0:00. */
function fmtOffset(ms) {
  if (ms == null || ms < 0) return "";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad2 = (n) => (n < 10 ? "0" + n : String(n));
  return h > 0 ? \`\${h}:\${pad2(m)}:\${pad2(s)}\` : \`\${m}:\${pad2(s)}\`;
}

/**
 * Render "Ns · 0:SS" — duration of this step on the left, offset from
 * session-start on the right. Either side is optional; skipped cleanly
 * when the value isn't available (e.g., the last row of a running
 * session has no duration yet). */
function fmtStepTiming(durationMs, offsetMs) {
  const parts = [];
  if (typeof durationMs === "number") parts.push(fmtDuration(durationMs));
  if (typeof offsetMs === "number") parts.push(fmtOffset(offsetMs));
  return parts.join(" · ");
}

function fmtDuration(ms) {
  // Sub-second: keep millisecond precision (useful for tool rows
  // that complete in ~100ms — seeing "0s" would hide real detail).
  if (ms < 1000) return ms + "ms";
  // 1s+: integer seconds only. Matches CMA's "1s · 0:00" style and
  // gives a clean monotonic tick on the 1s poll — "1s → 2s → 3s"
  // reads as a smooth wall clock, which the previous "1.5s → 3.0s →
  // 4.5s" did not (users read the decimal jump as acceleration).
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  const rs = s % 60;
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
  const sessionId = S.selectedSessionId;
  // Optimistic insert: show the message immediately with a "sending…"
  // tag so the user has a visible record of their input BEFORE the
  // container has a chance to persist it to Pi's JSONL. If the spawn
  // fails (e.g., credential refresh failure), we mark the entry
  // "failed to send" — the message stays visible and the error
  // banner explains why.
  const tempId = "pending_" + Math.random().toString(36).slice(2, 10);
  // postedAt is the JS timestamp of the user's send click. Used by
  // renderDetail to compute a live "Ns · 0:00" timing pill on the
  // pending bubble BEFORE the real user.message event arrives from
  // the server, so the row has timing the instant it appears.
  const pending = { content, tempId, status: "sending", postedAt: Date.now() };
  if (!S.pendingBySession[sessionId]) S.pendingBySession[sessionId] = [];
  S.pendingBySession[sessionId].push(pending);
  refreshDetail();
  try {
    await api(\`/v1/sessions/\${sessionId}/events\`, {
      method: "POST",
      body: JSON.stringify({ type: "user.message", content }),
    });
  } catch (err) {
    pending.status = "failed";
    toast("Send failed: " + err.message, true);
  }
  refreshDetail();
}

async function retrySend(sessionId, content) {
  // Drop any failed entries matching this content from the pending
  // list, then re-run the normal send path. Same optimistic insert,
  // same watchdog — if it fails again, the user gets another
  // "failed · retry" affordance, not a permanent stuck state.
  const list = S.pendingBySession[sessionId] || [];
  S.pendingBySession[sessionId] = list.filter(
    p => !(p.status === "failed" && p.content === content),
  );
  const tempId = "pending_" + Math.random().toString(36).slice(2, 10);
  const pending = { content, tempId, status: "sending", postedAt: Date.now() };
  S.pendingBySession[sessionId].push(pending);
  refreshDetail();
  try {
    await api(\`/v1/sessions/\${sessionId}/events\`, {
      method: "POST",
      body: JSON.stringify({ type: "user.message", content }),
    });
  } catch (err) {
    pending.status = "failed";
    toast("Retry failed: " + err.message, true);
  }
  refreshDetail();
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
    const telegramEnabled = document.getElementById("fld-channel-telegram").checked;
    if (!model) { toast("Model is required", true); return; }
    try {
      const body = {
        model,
        instructions,
        tools: [],
        permissionPolicy: { type: policy },
        thinkingLevel,
        channels: { telegram: { enabled: telegramEnabled } },
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
  // 1s cadence so the live duration counter on the current user
  // bubble advances by exactly 1 second each tick — integer-second
  // math and integer-second display line up, eliminating the "timer
  // going too fast" perception that 1500ms + .toFixed(1) created.
  S.detailPollTimer = setInterval(async () => {
    if (!S.selectedSessionId) return;
    try {
      const s = await api("/v1/sessions/" + S.selectedSessionId);
      if (s.status === "running" || s.status !== (S._lastDetailStatus || null)) {
        S._lastDetailStatus = s.status;
        await refreshDetail();
      }
    } catch { /* ignore transient */ }
  }, 1_000);
}

// ---------- Bootstrap ----------
document.getElementById("btn-new-agent").onclick = openNewAgent;
document.getElementById("btn-new-session").onclick = newSession;
loadAgents();
startPolling();
</script>
</body>
</html>`;
