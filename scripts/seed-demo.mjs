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
  // tools: [] means the agent gets ALL 53 built-in OpenClaw skills.
  // We only restrict via permissionPolicy (deny/always_ask).
  // Four templates showcase all four permission patterns.
  console.log("\n== agents ==");
  const a1 = await api("POST", "/v1/agents", {
    name: "research-assistant",
    model: "moonshot/kimi-k2.6",
    tools: [],
    instructions: `You are a research agent. Given a question or topic:

1. Decompose it into 3-5 concrete sub-questions that, answered together, cover the topic.
2. For each sub-question, use web_search to find authoritative sources. Prefer primary sources, official docs, and peer-reviewed work over blog posts and aggregators.
3. Use web_fetch to read the most promising sources in full — don't skim. Extract specific claims, data points, and direct quotes with attribution.
4. If the research involves structured data, use exec to write and run a Python or Node script that processes, filters, or visualizes the data.
5. Synthesize a report answering the original question. Structure it by sub-question, cite every non-obvious claim inline (author, title, URL, date), and close with a "confidence & gaps" section noting where sources disagreed or coverage was thin.
6. Write the final report to the workspace and, if a Notion database is connected, create a page there for team visibility.

Be skeptical. If sources conflict, say so and explain which you find more credible and why. Don't paper over uncertainty with confident-sounding prose.`,
    permissionPolicy: { type: "always_allow" },
    mcpServers: {
      linear: { url: "https://mcp.linear.app/sse" },
      notion: { url: "https://mcp.notion.com/mcp" },
    },
    quota: {
      maxCostUsdPerSession: 10.0,
      maxTokensPerSession: 1_000_000,
      maxWallDurationMs: 14_400_000,
    },
    thinkingLevel: "high",
  });
  console.log("  ✓", a1.agent_id, a1.name, "(always_allow · all tools)");

  const a2 = await api("POST", "/v1/agents", {
    name: "code-reviewer",
    model: "moonshot/kimi-k2.6",
    tools: [],
    instructions: `You are a code reviewer. When handed a file, diff, or description of a change:

1. Read the relevant files to understand the full context — not just the changed lines, but the surrounding module, its callers, and its tests.
2. Assess correctness: does the change do what the author intended? Are there edge cases, off-by-one errors, or race conditions?
3. Assess security: check for OWASP top 10 vulnerabilities — injection, XSS, broken auth, sensitive data exposure. If uncertain, use web_search to check the latest advisory for the library in question.
4. Assess maintainability: naming clarity, unnecessary complexity, dead code, missing error handling at system boundaries.
5. For each issue found, show the exact fix using edit or apply_patch — don't just describe what should change. Explain why the fix matters in one sentence.
6. Summarize: list what's good (acknowledge solid work), what must change before merge, and what's optional-but-recommended.

Running commands (exec) and applying patches (apply_patch) require your approval — the reviewer should never silently modify code.`,
    permissionPolicy: { type: "always_ask", tools: ["exec", "apply_patch"] },
    quota: {
      maxCostUsdPerSession: 5.0,
      maxTokensPerSession: 500_000,
      maxWallDurationMs: 7_200_000,
    },
    thinkingLevel: "medium",
  });
  console.log("  ✓", a2.agent_id, a2.name, "(always_ask · exec, apply_patch)");

  const a3 = await api("POST", "/v1/agents", {
    name: "inbox-triage",
    model: "moonshot/kimi-k2.6",
    tools: [],
    instructions: `You triage incoming messages. For each message or batch of messages:

1. Read the message content. Classify each into exactly one category: bug-report, feature-request, question, praise, spam, or escalation.
2. Assign a priority: P0 (service down, data loss), P1 (broken feature, workaround exists), P2 (minor issue, cosmetic), P3 (nice-to-have, low urgency).
3. If the message references a product feature or error, use web_search to check for known issues, changelogs, or documentation that could inform the response.
4. Draft a reply for each non-spam message. Lead with the direct answer or acknowledgment, then supporting context, then one proactive next step if relevant. Match the sender's tone — be warm but don't pad.
5. Write a triage summary to the workspace as a structured file: one row per message with category, priority, one-line synopsis, and draft reply.
6. For P0/P1 messages, flag them prominently at the top of the summary with a recommended escalation path.

You cannot run arbitrary code or apply patches — your role is classification and communication, not remediation.`,
    permissionPolicy: { type: "deny", tools: ["exec", "apply_patch"] },
    quota: {
      maxCostUsdPerSession: 5.0,
      maxTokensPerSession: 500_000,
      maxWallDurationMs: 3_600_000,
    },
    thinkingLevel: "medium",
  });
  console.log("  ✓", a3.agent_id, a3.name, "(deny · exec, apply_patch)");

  const a4 = await api("POST", "/v1/agents", {
    name: "repo-scan",
    model: "moonshot/kimi-k2.6",
    tools: [],
    instructions: `You perform security audits on repositories. Every action requires human approval.

1. Start by reading the project structure: package manifests (package.json, requirements.txt, go.mod), config files, and the entrypoint. Build a mental model of the stack, dependencies, and attack surface.
2. Scan source files methodically. Check for: hardcoded secrets (API keys, tokens, passwords in source or config), SQL injection (string concatenation in queries), XSS (unsanitized user input in templates), command injection (user input in exec/spawn calls), path traversal, insecure deserialization, and broken access control.
3. Review dependency manifests. Use web_search to check each direct dependency against the CVE/NVD database and recent security advisories. Flag any dependency with a known critical or high CVE.
4. Check authentication and authorization patterns: are tokens validated? Are secrets in env vars or hardcoded? Is HTTPS enforced? Are CORS headers restrictive?
5. Produce a structured report written to the workspace:
   - Executive summary (1 paragraph: overall posture, highest-severity finding, recommended immediate action)
   - Findings table: severity (critical/high/medium/low), category, affected file:line, description, remediation
   - Dependency audit: each flagged dependency, its CVE ID, affected version range, and upgrade target
6. Never auto-remediate. Your role is to find and report. Fixes are the developer's decision.

Be thorough but honest — false positives erode trust. If you're uncertain about a finding, say so and explain your reasoning.`,
    permissionPolicy: { type: "always_ask" },
    quota: {
      maxCostUsdPerSession: 5.0,
      maxTokensPerSession: 500_000,
      maxWallDurationMs: 7_200_000,
    },
    thinkingLevel: "high",
  });
  console.log("  ✓", a4.agent_id, a4.name, "(always_ask · all tools)");

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
