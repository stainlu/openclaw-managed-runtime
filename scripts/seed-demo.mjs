#!/usr/bin/env node
// Seed a running orchestrator with demo-grade data: 3 environments,
// 4 vaults (with credentials), 4 agents, 2 idle sessions.
//
// Usage:
//   OPENCLAW_HOST=http://178.104.149.25:8080 node scripts/seed-demo.mjs
//   OPENCLAW_HOST=http://localhost:8080      node scripts/seed-demo.mjs
//
// Idempotency: the orchestrator mints new ids on every POST. Re-running
// this script duplicates everything. For a clean slate either point it
// at a fresh VM, or DELETE the existing records first. Kept simple by
// design — this is a demo seeder, not a migration tool.
//
// Honesty: credentials are DEMO secrets ("demo_notion_access" etc.) not
// real OAuth tokens. They satisfy the schema (min-length strings) so
// the portal can render the credential shape, but none of them would
// resolve against a real upstream. Replace via the vault UI if you
// need a live OAuth flow.

const HOST = process.env.OPENCLAW_HOST || "http://localhost:8080";
const TOKEN = process.env.OPENCLAW_API_TOKEN || "";

async function api(method, path, body) {
  const headers = { "content-type": "application/json" };
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
  const res = await fetch(HOST + path, {
    method,
    headers,
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status} ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

const hrAgo = (h) => Math.floor(Date.now() / 1000) + h * 3600;

async function main() {
  console.log(`seeding ${HOST}`);

  // --- Environments ---------------------------------------------------
  console.log("\n== environments ==");
  const envDefault = await api("POST", "/v1/environments", {
    name: "default",
    networking: { type: "unrestricted" },
  });
  console.log("  ✓", envDefault.environment_id, envDefault.name);

  const envPy = await api("POST", "/v1/environments", {
    name: "py-stdlib",
    packages: { pip: ["requests", "httpx", "beautifulsoup4"] },
    networking: { type: "unrestricted" },
  });
  console.log("  ✓", envPy.environment_id, envPy.name);

  const envLocked = await api("POST", "/v1/environments", {
    name: "locked-anthropic",
    packages: { pip: ["anthropic"] },
    networking: { type: "limited", allowedHosts: ["api.anthropic.com"] },
  });
  console.log("  ✓", envLocked.environment_id, envLocked.name, "(limited · api.anthropic.com)");

  // --- Vaults ---------------------------------------------------------
  // Each vault is created with POST /v1/vaults, then credentials are
  // added with POST /v1/vaults/:id/credentials. The demo tokens are
  // obviously fake — they pass schema validation so the UI can render
  // them, but upstream auth would fail. See file header.
  console.log("\n== vaults ==");
  const v1 = await api("POST", "/v1/vaults", {
    userId: "eu_linh.p@acme.io",
    name: "linh · notion + slack + openai",
  });
  console.log("  ✓", v1.vault_id, v1.name);
  await api("POST", `/v1/vaults/${v1.vault_id}/credentials`, {
    type: "mcp_oauth",
    name: "notion",
    matchUrl: "https://api.notion.com",
    accessToken: "demo_notion_access_token",
    refreshToken: "demo_notion_refresh_token",
    expiresAt: hrAgo(1),                         // expires in 1h → "fresh"
    tokenEndpoint: "https://api.notion.com/v1/oauth/token",
    clientId: "demo_notion_client",
    clientSecret: "demo_notion_client_secret",
    scopes: ["read_content", "update_blocks", "read_comments"],
  });
  await api("POST", `/v1/vaults/${v1.vault_id}/credentials`, {
    type: "mcp_oauth",
    name: "slack",
    matchUrl: "https://slack.com",
    accessToken: "demo_slack_access_token",
    refreshToken: "demo_slack_refresh_token",
    expiresAt: hrAgo(2),
    tokenEndpoint: "https://slack.com/api/oauth.v2.access",
    clientId: "demo_slack_client",
    clientSecret: "demo_slack_client_secret",
    scopes: ["channels:read", "chat:write", "im:history"],
  });
  await api("POST", `/v1/vaults/${v1.vault_id}/credentials`, {
    type: "static_bearer",
    name: "openai-compat",
    matchUrl: "https://api.openai.com",
    token: "sk-demo-openai-static-bearer-value",
  });

  const v2 = await api("POST", "/v1/vaults", {
    userId: "eu_marcus.h@acme.io",
    name: "marcus · github + linear",
  });
  console.log("  ✓", v2.vault_id, v2.name);
  await api("POST", `/v1/vaults/${v2.vault_id}/credentials`, {
    type: "mcp_oauth",
    name: "github",
    matchUrl: "https://api.github.com",
    accessToken: "demo_github_access_token",
    refreshToken: "demo_github_refresh_token",
    expiresAt: hrAgo(48),
    tokenEndpoint: "https://github.com/login/oauth/access_token",
    clientId: "demo_github_client",
    clientSecret: "demo_github_client_secret",
    scopes: ["repo", "read:user", "workflow"],
  });
  await api("POST", `/v1/vaults/${v2.vault_id}/credentials`, {
    type: "mcp_oauth",
    name: "linear",
    matchUrl: "https://api.linear.app",
    accessToken: "demo_linear_access_token",
    refreshToken: "demo_linear_refresh_token",
    expiresAt: hrAgo(12),
    tokenEndpoint: "https://api.linear.app/oauth/token",
    clientId: "demo_linear_client",
    clientSecret: "demo_linear_client_secret",
    scopes: ["read:issues", "write:issues"],
  });

  const v3 = await api("POST", "/v1/vaults", {
    userId: "svc_reporting",
    name: "reporting service · read-only db",
  });
  console.log("  ✓", v3.vault_id, v3.name);
  await api("POST", `/v1/vaults/${v3.vault_id}/credentials`, {
    type: "static_bearer",
    name: "pg-reporter",
    matchUrl: "https://reporting.internal",
    token: "demo_pg_reporter_static_bearer",
  });

  const v4 = await api("POST", "/v1/vaults", {
    userId: "eu_dana.r@acme.io",
    name: "dana · empty bundle",
  });
  console.log("  ✓", v4.vault_id, v4.name, "(no credentials)");

  // --- Agents ---------------------------------------------------------
  // Real openclaw tool names only: exec, read, write, edit, apply_patch,
  // web_search. MCP servers use verified hosted endpoints (Linear SSE,
  // Notion /mcp). Agent templates demonstrate a policy spread:
  // always_ask, always_allow, deny-list, ask-list.
  console.log("\n== agents ==");
  const a1 = await api("POST", "/v1/agents", {
    name: "research-assistant",
    model: "moonshot/kimi-k2.5",
    tools: ["read", "write", "web_search"],
    instructions: "You are a research assistant. Find primary sources, cite them, and save summaries to the workspace.",
    permissionPolicy: { type: "always_ask" },
    mcpServers: {
      linear: { url: "https://mcp.linear.app/sse" },
      notion: { url: "https://mcp.notion.com/mcp" },
    },
    quota: {
      maxCostUsdPerSession: 1.0,
      maxTokensPerSession: 50_000,
      maxWallDurationMs: 1_800_000,
    },
  });
  console.log("  ✓", a1.agent_id, a1.name);

  const a2 = await api("POST", "/v1/agents", {
    name: "code-reviewer",
    model: "moonshot/kimi-k2.5",
    tools: ["read", "edit", "apply_patch", "exec"],
    instructions: "You review code diffs for correctness, security, and style. Suggest edits via apply_patch.",
    permissionPolicy: { type: "always_allow" },
    quota: {
      maxCostUsdPerSession: 0.5,
      maxTokensPerSession: 30_000,
    },
  });
  console.log("  ✓", a2.agent_id, a2.name);

  const a3 = await api("POST", "/v1/agents", {
    name: "inbox-triage",
    model: "moonshot/kimi-k2.5",
    tools: ["read", "write"],
    instructions: "You triage incoming messages, label them, and draft replies. Never execute arbitrary code.",
    permissionPolicy: { type: "deny", tools: ["exec", "apply_patch"] },
  });
  console.log("  ✓", a3.agent_id, a3.name);

  const a4 = await api("POST", "/v1/agents", {
    name: "repo-scan",
    model: "moonshot/kimi-k2.5",
    tools: ["read", "exec", "web_search"],
    instructions: "You scan a repository for a security report. Read files, run read-only commands, search docs.",
    permissionPolicy: { type: "always_ask", tools: ["exec"] },
    quota: {
      maxCostUsdPerSession: 0.25,
      maxWallDurationMs: 600_000,
    },
  });
  console.log("  ✓", a4.agent_id, a4.name);

  // --- Sessions -------------------------------------------------------
  // Just the shell (POST /v1/sessions with no initial event). Sessions
  // appear as "idle" until someone fires an event on them — this gives
  // the sessions list something to render without burning provider
  // tokens on demo seeding. Link one to the py-stdlib env + linh vault
  // so the right-pane inspector shows real wiring.
  console.log("\n== sessions ==");
  const s1 = await api("POST", "/v1/sessions", {
    agentId: a1.agent_id,
    environmentId: envPy.environment_id,
    vaultId: v1.vault_id,
  });
  console.log("  ✓", s1.session_id, "(research-assistant / py-stdlib / linh)");

  const s2 = await api("POST", "/v1/sessions", {
    agentId: a2.agent_id,
    environmentId: envDefault.environment_id,
  });
  console.log("  ✓", s2.session_id, "(code-reviewer / default)");

  console.log("\nseed complete");
}

main().catch((err) => {
  console.error("seed failed:", err.message || err);
  process.exit(1);
});
