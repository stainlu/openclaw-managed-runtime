"""Research assistant — a copy-paste starting point for building with
OpenClaw Managed Agents from Python.

What it does:
  1. Connects to a running orchestrator (default http://localhost:8080).
  2. Creates an agent template tuned for research-flavored answers.
  3. Opens a session.
  4. Accepts questions at the terminal. For each question, posts a
     user message and streams events in real time — thinking blocks,
     tool calls, tool results, and the final agent message — with a
     compact human-readable format. Polls the session state at end of
     turn to report rolling token + cost usage.
  5. Repeats until the user types `/quit`.

Run:
  pip install openclaw-managed-agents>=0.2.0
  export MOONSHOT_API_KEY=sk-...                   # or any provider
  docker compose up -d                              # in the repo root
  python research_assistant.py

Optional env vars:
  OPENCLAW_ORCHESTRATOR_URL   default http://localhost:8080
  OPENCLAW_API_TOKEN          bearer token (match the orchestrator's)
  OPENCLAW_MODEL              default moonshot/kimi-k2.5
"""
from __future__ import annotations

import os
import sys
from typing import Optional

from openclaw_managed_agents import OpenClawClient

# ANSI colors. Plain ASCII if stdout isn't a TTY (piping to a file etc.).
_ANSI = sys.stdout.isatty()


def _color(code: str, s: str) -> str:
    return f"\x1b[{code}m{s}\x1b[0m" if _ANSI else s


DIM = lambda s: _color("2", s)  # noqa: E731
CYAN = lambda s: _color("36", s)  # noqa: E731
GREEN = lambda s: _color("32", s)  # noqa: E731
YELLOW = lambda s: _color("33", s)  # noqa: E731
MAGENTA = lambda s: _color("35", s)  # noqa: E731
RED = lambda s: _color("31", s)  # noqa: E731


RESEARCH_INSTRUCTIONS = (
    "You are a research assistant. When answering, cite sources "
    "whenever possible, label any uncertainty explicitly, and prefer "
    "structured summaries over long prose. If a question needs "
    "verification, use your tools to look it up; never fabricate."
)


def print_event(event) -> None:
    """Format a single streamed event to stdout."""
    t = event.type
    if t == "user.message":
        # Echo user messages we've posted — skipped here because we
        # already print them when the user types.
        return
    if t == "agent.thinking":
        print(DIM(f"  … thinking: {event.content}"))
        return
    if t == "agent.tool_use":
        args = event.tool_arguments or {}
        # Keep it compact — one line per tool call.
        args_preview = ", ".join(f"{k}={v!r}" for k, v in list(args.items())[:3])
        if len(args) > 3:
            args_preview += ", …"
        print(MAGENTA(f"  → tool {event.tool_name}({args_preview})"))
        return
    if t == "agent.tool_result":
        prefix = RED("  ← tool_err ") if event.is_error else CYAN("  ← tool_out ")
        snippet = event.content.strip().splitlines()[0] if event.content else "(empty)"
        if len(snippet) > 120:
            snippet = snippet[:117] + "…"
        print(f"{prefix}{snippet}")
        return
    if t == "agent.message":
        print()
        print(GREEN("assistant:"))
        print(event.content)
        # Per-turn usage surfaces here when the model reports it.
        if event.tokens or event.cost_usd is not None:
            usage_bits = []
            if event.tokens:
                usage_bits.append(
                    f"{event.tokens.get('input', 0)} in / "
                    f"{event.tokens.get('output', 0)} out"
                )
            if event.cost_usd is not None:
                usage_bits.append(f"${event.cost_usd:.4f}")
            print(DIM(f"  [turn usage: {', '.join(usage_bits)}]"))
        return
    if t == "agent.tool_confirmation_request":
        # always_ask policy — not used in this example's agent template,
        # but surface it if it shows up so the reader knows the hook exists.
        print(YELLOW(f"  ⚠ tool confirmation requested: {event.tool_name} "
                     f"(respond via client.sessions.confirm_tool(...))"))
        return
    if t == "agent.error":
        print(RED(f"  ⚠ error: {event.content}"))
        return
    # session.model_change / session.thinking_level_change / session.compaction
    if t.startswith("session."):
        print(DIM(f"  [{t}: {event.content}]"))


def run_turn(client: OpenClawClient, session_id: str, prompt: str) -> None:
    print(CYAN("you: ") + prompt)
    client.sessions.send(session_id, content=prompt)
    # stream() returns an iterator over events; it blocks on the SSE
    # connection and ends when the session goes idle for ~30 s after
    # the last event. We break out as soon as the first agent.message
    # lands for this turn — the demo-grade UX we want.
    seen_agent_msg_ids: set[str] = set()
    # Pre-populate with any agent.messages from earlier turns so we
    # don't stop on a stale one during catch-up.
    for prior in client.sessions.events(session_id):
        if prior.type == "agent.message":
            seen_agent_msg_ids.add(prior.event_id)
    for event in client.sessions.stream(session_id):
        print_event(event)
        if event.type == "agent.message" and event.event_id not in seen_agent_msg_ids:
            break


def main() -> int:
    base_url = os.environ.get("OPENCLAW_ORCHESTRATOR_URL", "http://localhost:8080")
    api_token = os.environ.get("OPENCLAW_API_TOKEN") or None
    model = os.environ.get("OPENCLAW_MODEL", "moonshot/kimi-k2.5")

    client = OpenClawClient(base_url=base_url, api_token=api_token)

    # Verify the orchestrator is reachable before creating anything.
    # Matches the deploy scripts' /healthz probe pattern.
    import httpx
    try:
        resp = httpx.get(f"{base_url}/healthz", timeout=5.0)
        resp.raise_for_status()
    except httpx.HTTPError as err:
        print(RED(f"cannot reach {base_url}/healthz: {err}"), file=sys.stderr)
        print(
            "  — is the orchestrator running? Try: docker compose up -d",
            file=sys.stderr,
        )
        return 1

    print(DIM(f"connected to {base_url}"))
    print(DIM(f"model: {model}"))
    if api_token:
        print(DIM("auth:  bearer-token (OPENCLAW_API_TOKEN set)"))
    else:
        print(DIM("auth:  disabled"))

    agent = client.agents.create(
        model=model,
        instructions=RESEARCH_INSTRUCTIONS,
        # tools defaults to [] — the agent uses whatever skills the
        # runtime image has pre-installed. Point this at specific skill
        # ids once the runtime exposes them explicitly.
    )
    print(DIM(f"agent: {agent.agent_id}"))

    session = client.sessions.create(agent_id=agent.agent_id)
    print(DIM(f"session: {session.session_id}"))
    print(DIM("type /quit to exit, /usage for cumulative token + cost"))
    print()

    try:
        while True:
            try:
                prompt = input(CYAN("> "))
            except (EOFError, KeyboardInterrupt):
                print()
                break
            prompt = prompt.strip()
            if not prompt:
                continue
            if prompt == "/quit":
                break
            if prompt == "/usage":
                current = client.sessions.get(session.session_id)
                print(
                    DIM(
                        f"cumulative: "
                        f"{current.tokens['input']} in / "
                        f"{current.tokens['output']} out, "
                        f"${current.cost_usd:.4f}"
                    )
                )
                continue
            run_turn(client, session.session_id, prompt)
            print()
    finally:
        # Leave the session alive for post-hoc inspection via
        # GET /v1/sessions/<id>/events. Uncomment to tear down.
        # client.sessions.delete(session.session_id)
        client.close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
