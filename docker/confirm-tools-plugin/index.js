// OpenClaw plugin — tool confirmation via before_tool_call hook.
//
// When enabled, reads OPENCLAW_CONFIRM_TOOLS (comma-separated tool names or
// "__ALL__") and returns `requireApproval` for matching tools. The gateway
// broadcasts `plugin.approval.requested` to WS clients; the orchestrator
// surfaces it as an SSE event and resolves via `plugin.approval.resolve`
// when the client responds with `user.tool_confirmation`.
//
// This plugin is installed by the Dockerfile at build time and conditionally
// enabled by the entrypoint when the agent template has `always_ask` policy.

import { definePluginEntry } from "openclaw/plugin-sdk";

const raw = (process.env.OPENCLAW_CONFIRM_TOOLS || "").trim();
const confirmAll = raw === "__ALL__";
const confirmTools = confirmAll
  ? []
  : raw.split(",").map((t) => t.trim()).filter(Boolean);

export default definePluginEntry({
  id: "confirm-tools",
  name: "Tool Confirmation",
  description: "Requires client confirmation before executing specified tools",

  register(api) {
    // No tools to confirm — plugin is enabled but has nothing to do.
    if (!confirmAll && confirmTools.length === 0) return;

    api.on(
      "before_tool_call",
      (event) => {
        const toolName = event?.toolName ?? "";
        if (!confirmAll && !confirmTools.includes(toolName)) return;

        return {
          requireApproval: {
            title: `Tool requires confirmation: ${toolName}`,
            description: `The agent wants to execute "${toolName}". Allow or deny?`,
            severity: "warning",
            timeoutMs: 300_000,
            timeoutBehavior: "deny",
            pluginId: "confirm-tools",
          },
        };
      },
      { priority: 100 },
    );
  },
});
