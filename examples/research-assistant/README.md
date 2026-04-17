# Research Assistant — example app

A ~200-line Python script showing what it looks like to build with OpenClaw Managed Agents: create an agent, open a session, send questions, stream events in real time with a compact human-readable format. Multi-turn. Colored terminal output for different event types (thinking, tool calls, tool results, final message).

This is a starting point you fork, not a library you import.

## What you'll see

```
$ python research_assistant.py
connected to http://localhost:8080
model: moonshot/kimi-k2.5
auth:  disabled
agent: agt_9k2nvxbb5p1q
session: ses_a3rpxq82fm9w
type /quit to exit, /usage for cumulative token + cost

> In 3 bullets, what are the main architectural differences between Pi agent and Claude Code?
you: In 3 bullets, what are the main architectural differences between Pi agent and Claude Code?
  … thinking: Let me compare Pi and Claude Code along three axes: process model, extension surface, and session model…
  → tool web_fetch(url='https://mariozechner.at/posts/…')
  ← tool_out Pi is built around a single long-running AgentSession… [118 more lines]

assistant:
- **Process model.** Pi runs a single in-process AgentSession with an
  explicit event bus; Claude Code spawns a fresh session per task and
  hides subagent transcripts behind opaque tool results.
- **Extension surface.** Pi ships four tools (read, write, edit, bash)
  and expects users to write their own extensions; Claude Code ships
  a curated 8-tool set plus a proprietary toolset spec.
- **Session model.** Pi's SessionManager is append-only JSONL with a
  tree of branches; Claude Code sessions are opaque cloud objects with
  a versioned event log.
  [turn usage: 1247 in / 312 out, $0.0008]

>
```

## Prerequisites

1. **Running orchestrator.** From the repo root:
   ```bash
   export MOONSHOT_API_KEY=sk-...     # or any provider key
   docker compose up -d
   ```
2. **Python 3.9+.** This example uses only stdlib + the SDK.

## Run it

```bash
cd examples/research-assistant
pip install -r requirements.txt     # installs openclaw-managed-agents>=0.2.0
python research_assistant.py
```

Type questions. `/usage` prints cumulative tokens + cost. `/quit` exits.

## Configuration

Environment variables (all optional):

| Variable | Default | Purpose |
|---|---|---|
| `OPENCLAW_ORCHESTRATOR_URL` | `http://localhost:8080` | Where the orchestrator is |
| `OPENCLAW_API_TOKEN` | *(unset)* | Bearer token — set this to match the orchestrator's `OPENCLAW_API_TOKEN` when auth is enabled |
| `OPENCLAW_MODEL` | `moonshot/kimi-k2.5` | Any `<provider>/<model-id>` the runtime supports |

## What to modify

The script is deliberately one file and < 250 lines. Places to look if you're adapting it:

- **`RESEARCH_INSTRUCTIONS`** — the agent's system prompt. Swap to whatever your use case is.
- **`print_event`** — how each streamed event type renders. The full event catalog is documented in [`docs/architecture.md`](../../docs/architecture.md#live-event-streaming-get-v1sessionsidevents-streamtrue).
- **`run_turn`** — the streaming loop. Currently breaks as soon as the first new `agent.message` lands, which is the right call for chat-style UX; for longer analyses you might want to let the stream drain fully. Or plug in a different policy around tool calls (wait for them to complete, retry on error, etc.).

## Swap to a different provider

```bash
export ANTHROPIC_API_KEY=sk-...
export OPENCLAW_MODEL=anthropic/claude-sonnet-4-6
python research_assistant.py
```

No code change needed — the runtime forwards whichever provider API key it sees.

## What this example is NOT

- **Not production-ready.** No retries, no structured error handling, no conversation history export. Real products wrap `OpenClawClient` behind their own interface.
- **Not the full SDK surface.** Doesn't exercise `environments`, `cancel`, `confirm_tool`, agent versioning, or delegated subagents. Look at [`sdk/python/README.md`](../../sdk/python/README.md) for the full resource list.
