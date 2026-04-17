# OpenClaw Managed Agents Python SDK

Python client for the [OpenClaw Managed Agents](https://github.com/stainlu/openclaw-managed-agents) API.

## Install

```bash
pip install openclaw-managed-agents
```

## Usage

```python
from openclaw_managed_agents import OpenClawClient

# Pass api_token to match the orchestrator's OPENCLAW_API_TOKEN when
# bearer-token auth is enabled. Omit for a local orchestrator without auth.
client = OpenClawClient(base_url="http://localhost:8080", api_token="my-shared-secret")

# Create an agent
agent = client.agents.create(
    model="moonshot/kimi-k2.5",
    instructions="You are a research assistant.",
)

# Open a session
session = client.sessions.create(agent_id=agent.agent_id)

# Send a message
client.sessions.send(session.session_id, content="What is 2+2?")

# Stream events in real time
for event in client.sessions.stream(session.session_id):
    if event.type == "agent.message":
        print(event.content)
    elif event.type == "agent.tool_use":
        print(f"[tool: {event.tool_name}]")
```

## Resources

- `client.agents` — create, get, list, update, archive, delete, list_versions
- `client.environments` — create, get, list, delete
- `client.sessions` — create, get, list, delete, send, cancel, events, stream, confirm_tool
