#!/usr/bin/env node
// Run multi-turn conversations against the demo agents so the sessions
// list has realistic turns / tokens / cost / mixed states instead of
// a row of empty "0 turns 0.0k tok $0.000" placeholders.
//
// Prereq: scripts/seed-demo.mjs already populated the agents
// (research-assistant, code-reviewer, inbox-triage, repo-scan) + a
// few envs/vaults on the target orchestrator.
//
// Shape:
//   - Sessions run SEQUENTIALLY because each burns provider tokens and
//     Moonshot rate-limits aggressive concurrency. With 8 sessions × 2-3
//     turns each and ~10-20 s/turn, the full run is ~4-6 minutes.
//   - After posting each user.message we poll GET /v1/sessions/:id
//     every 2 s until status != "running" OR a 60 s watchdog fires.
//     Stale-running sessions (always_ask agents paused on tool use)
//     are deliberately left that way so the "Awaits approval" row in
//     the sessions list has something to render.
//   - Provider cost is visible in the UI after this runs — expect on
//     the order of $0.10-0.30 total against moonshot/kimi-k2.5.
//
// Usage:
//   OPENCLAW_HOST=http://178.104.149.25:8080 node scripts/seed-sessions.mjs

const HOST = process.env.OPENCLAW_HOST || "http://localhost:8080";
const TOKEN = process.env.OPENCLAW_API_TOKEN || "";

const WATCHDOG_MS = 60_000;
const POLL_MS = 2_000;

async function api(method, path, body) {
  const headers = { "content-type": "application/json" };
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
  const res = await fetch(HOST + path, {
    method,
    headers,
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Wait for session status to leave "running". Returns the final status.
// Sessions that hang on tool approval stay "running" forever; the
// watchdog caps the wait so we keep moving through the seed list.
async function waitSettled(sessionId, label) {
  const start = Date.now();
  while (Date.now() - start < WATCHDOG_MS) {
    const s = await api("GET", `/v1/sessions/${sessionId}`);
    if (s.status !== "running") {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.log(`    ← ${s.status} in ${elapsed}s · ${s.tokens.input + s.tokens.output} tok · $${(s.cost_usd || 0).toFixed(4)}`);
      return s;
    }
    await sleep(POLL_MS);
  }
  console.log(`    ← running (watchdog · probably awaiting approval) · ${label}`);
  return await api("GET", `/v1/sessions/${sessionId}`);
}

async function runConversation({ agentId, envId, vaultId, label, turns }) {
  const session = await api("POST", "/v1/sessions", {
    agentId,
    environmentId: envId,
    vaultId: vaultId || undefined,
  });
  console.log(`\n[${session.session_id}] ${label}`);

  for (let i = 0; i < turns.length; i++) {
    const msg = turns[i];
    console.log(`  → turn ${i + 1}: ${msg.slice(0, 60)}${msg.length > 60 ? "…" : ""}`);
    try {
      await api("POST", `/v1/sessions/${session.session_id}/events`, {
        type: "user.message",
        content: msg,
      });
    } catch (err) {
      console.log(`    × post failed: ${err.message || err}`);
      break;
    }
    const final = await waitSettled(session.session_id, label);
    if (final.status === "running") {
      // Paused (awaits approval). Subsequent turns would just queue behind
      // the paused run — stop posting so the session stays in a clean
      // "running" state for the UI demo.
      break;
    }
    if (final.status === "failed") {
      console.log(`    ! failed: ${final.error || "(no error field)"}`);
      break;
    }
  }
}

async function main() {
  console.log(`running conversations against ${HOST}`);

  // Resolve the seeded resources by name. Bail loudly if any are missing —
  // seed-demo must have been run first.
  const [{ agents }, { environments }, { vaults }] = await Promise.all([
    api("GET", "/v1/agents"),
    api("GET", "/v1/environments"),
    api("GET", "/v1/vaults"),
  ]);
  const agentByName = Object.fromEntries(agents.map((a) => [a.name, a]));
  const envByName = Object.fromEntries(environments.map((e) => [e.name, e]));
  const vaultByUser = Object.fromEntries(vaults.map((v) => [v.user_id, v]));

  function need(map, key, kind) {
    const v = map[key];
    if (!v) throw new Error(`missing ${kind}: ${key} — run scripts/seed-demo.mjs first`);
    return v;
  }
  const aResearch = need(agentByName, "research-assistant", "agent");
  const aReview = need(agentByName, "code-reviewer", "agent");
  const aTriage = need(agentByName, "inbox-triage", "agent");
  const aScan = need(agentByName, "repo-scan", "agent");
  const envDefault = need(envByName, "default", "env");
  const envPy = need(envByName, "py-stdlib", "env");
  const envLocked = need(envByName, "locked-anthropic", "env");
  const vLinh = need(vaultByUser, "eu_linh.p@acme.io", "vault");
  const vMarcus = need(vaultByUser, "eu_marcus.h@acme.io", "vault");

  // A spread of conversations that exercise different agent policies
  // and env shapes. Short prompts keep provider cost bounded; the
  // UI cares about the SHAPE (turns, tokens, cost, status) more than
  // the exact content.
  const plan = [
    {
      agentId: aReview.agent_id,
      envId: envDefault.environment_id,
      label: "code-reviewer · 3 quick Qs",
      turns: [
        "In one sentence, what's the purpose of a feature flag?",
        "Name two common pitfalls of long-lived feature flags.",
        "Any rule of thumb for when to remove one?",
      ],
    },
    {
      agentId: aReview.agent_id,
      envId: envDefault.environment_id,
      label: "code-reviewer · SQL injection",
      turns: [
        "Explain SQL injection in two sentences.",
        "Show a parameterized query example in Python.",
      ],
    },
    {
      agentId: aTriage.agent_id,
      envId: envDefault.environment_id,
      label: "inbox-triage · draft decline email",
      turns: [
        "Draft a polite decline for a meeting invite. Two sentences.",
        "Make the tone slightly firmer.",
      ],
    },
    {
      agentId: aTriage.agent_id,
      envId: envDefault.environment_id,
      label: "inbox-triage · quick label advice",
      turns: [
        "What's a reasonable 3-label taxonomy for a personal inbox?",
      ],
    },
    {
      agentId: aResearch.agent_id,
      envId: envPy.environment_id,
      vaultId: vLinh.vault_id,
      label: "research-assistant · python 3.14 (likely awaits)",
      // This prompt will likely trigger web_search, which is always_ask →
      // the session will hang in "running" on approval. That's desired:
      // it populates the "Awaits approval" row in the UI.
      turns: [
        "Look up three new features in Python 3.14 and summarize each in one sentence.",
      ],
    },
    {
      agentId: aResearch.agent_id,
      envId: envPy.environment_id,
      vaultId: vLinh.vault_id,
      label: "research-assistant · plain Q (no tool)",
      turns: [
        "What's the difference between a monorepo and a polyrepo, in two sentences?",
      ],
    },
    {
      agentId: aScan.agent_id,
      envId: envDefault.environment_id,
      vaultId: vMarcus.vault_id,
      label: "repo-scan · quick analysis (may await on exec)",
      turns: [
        "Assume a hypothetical Node.js project. Name three security pitfalls you'd look for in a code review.",
      ],
    },
    {
      agentId: aReview.agent_id,
      envId: envLocked.environment_id,
      label: "code-reviewer · confined env",
      turns: [
        "What's one operational benefit of running agent containers on a network-restricted egress policy?",
      ],
    },
  ];

  for (const conv of plan) {
    try {
      await runConversation(conv);
    } catch (err) {
      console.log(`  ! conversation failed: ${err.message || err}`);
    }
  }

  // Final summary
  console.log("\n== final counts ==");
  const { sessions } = await api("GET", "/v1/sessions");
  console.log(`  total: ${sessions.length}`);
  const byStatus = sessions.reduce((acc, s) => {
    acc[s.status] = (acc[s.status] || 0) + 1;
    return acc;
  }, {});
  for (const [k, v] of Object.entries(byStatus)) console.log(`    ${k}: ${v}`);
  const totalTokens = sessions.reduce((t, s) => t + (s.tokens?.input || 0) + (s.tokens?.output || 0), 0);
  const totalCost = sessions.reduce((t, s) => t + (s.cost_usd || 0), 0);
  console.log(`  tokens: ${totalTokens}`);
  console.log(`  cost:   $${totalCost.toFixed(4)}`);
}

main().catch((err) => {
  console.error("seed-sessions failed:", err.message || err);
  process.exit(1);
});
