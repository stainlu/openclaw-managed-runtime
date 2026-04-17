"""OpenClaw Managed Agents Python SDK.

Usage::

    from openclaw_managed_agents import OpenClawClient

    client = OpenClawClient(base_url="http://localhost:8080")

    agent = client.agents.create(model="moonshot/kimi-k2.5", instructions="You are helpful.")
    session = client.sessions.create(agent_id=agent.agent_id)
    client.sessions.send(session.session_id, content="What is 2+2?")

    for event in client.sessions.stream(session.session_id):
        if event.type == "agent.message":
            print(event.content)
"""

from __future__ import annotations

import httpx

from .resources.agents import Agents
from .resources.environments import Environments
from .resources.sessions import Sessions
from .types import Agent, Environment, Event, Session

__all__ = [
    "OpenClawClient",
    "Agent",
    "Environment",
    "Session",
    "Event",
]


class OpenClawClient:
    """Client for the OpenClaw Managed Agents API.

    Args:
        base_url: Orchestrator URL (e.g. ``http://localhost:8080``).
        api_token: Bearer token matching the orchestrator's
            ``OPENCLAW_API_TOKEN`` env var. Attached as
            ``Authorization: Bearer <token>`` on every request. Leave
            unset for a local orchestrator running without auth.
        timeout: Request timeout in seconds. Default 600 (matches the
            orchestrator's chat.completions poll cap).
    """

    def __init__(
        self,
        base_url: str = "http://localhost:8080",
        api_token: str | None = None,
        timeout: float = 600.0,
    ) -> None:
        headers: dict[str, str] = {}
        if api_token:
            headers["Authorization"] = f"Bearer {api_token}"
        # trust_env=False bypasses system proxy settings (macOS scutil
        # proxy) that httpx auto-detects. The orchestrator is typically on
        # localhost or a private network — proxying it is never wanted.
        self._client = httpx.Client(
            base_url=base_url,
            timeout=timeout,
            trust_env=False,
            headers=headers,
        )
        self.agents = Agents(self._client)
        self.environments = Environments(self._client)
        self.sessions = Sessions(self._client)

    def close(self) -> None:
        """Close the underlying HTTP connection pool."""
        self._client.close()

    def __enter__(self) -> OpenClawClient:
        return self

    def __exit__(self, *args: object) -> None:
        self.close()
