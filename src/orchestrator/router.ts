import type { ContainerRuntime, Mount } from "../runtime/container.js";
import type { AgentStore, EventStore, SessionStore } from "../store/types.js";
import type { AgentConfig, Event, Session } from "./types.js";

export type RouterConfig = {
  /** Image reference for the OpenClaw agent container. */
  runtimeImage: string;
  /** Host path mounted into each agent container as /workspace for session state. */
  hostStateRoot: string;
  /** Docker network the spawned containers join. */
  network: string;
  /** Gateway port inside the container (must match Dockerfile.runtime). */
  gatewayPort: number;
  /** Environment variables passed through to every spawned container (AWS creds, region, etc.). */
  passthroughEnv: Record<string, string>;
  /** Max time to wait for /readyz (ms). */
  readyTimeoutMs: number;
  /** Max time to wait for the agent task to complete end-to-end (ms). */
  runTimeoutMs: number;
};

export class AgentRouter {
  constructor(
    private readonly agents: AgentStore,
    private readonly sessions: SessionStore,
    private readonly events: EventStore,
    private readonly runtime: ContainerRuntime,
    private readonly cfg: RouterConfig,
  ) {}

  /**
   * Create a session bound to an agent. Pure metadata: no container spawn,
   * no JSONL allocation, no remote calls. The container is only spawned when
   * the first event is posted to this session via runEvent().
   */
  createSession(agentId: string): Session {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new RouterError("agent_not_found", `agent ${agentId} does not exist`);
    }
    return this.sessions.create({ agentId });
  }

  /**
   * Post a user.message event to an existing session. Synchronously appends
   * the user event, transitions the session to "running", and schedules a
   * background run that spawns a container, proxies the task to its chat
   * completions endpoint, captures the agent.message reply, rolls usage up
   * onto the session, and tears the container down.
   *
   * Returns the session (status = running) and the newly-appended user event.
   * The HTTP caller returns this to the client immediately; the client then
   * polls GET /v1/sessions/:id until it flips back to idle (or failed), and
   * reads the agent's reply from GET /v1/sessions/:id/events.
   *
   * Live event streaming (SSE) is Item 6.
   */
  runEvent(args: { sessionId: string; content: string }): { session: Session; event: Event } {
    const session = this.sessions.get(args.sessionId);
    if (!session) {
      throw new RouterError(
        "session_not_found",
        `session ${args.sessionId} does not exist`,
      );
    }
    if (session.status === "running") {
      throw new RouterError(
        "session_busy",
        `session ${args.sessionId} is already processing an event`,
      );
    }
    const agent = this.agents.get(session.agentId);
    if (!agent) {
      // Safety net: the session outlives its template only if the template was
      // deleted while the session was idle. Treat as a hard error — we cannot
      // spawn a container without the config.
      throw new RouterError(
        "agent_not_found",
        `agent ${session.agentId} does not exist`,
      );
    }

    // Append the user event synchronously so it is visible in the event log
    // the moment the HTTP handler returns.
    const userEvent = this.events.append({
      sessionId: args.sessionId,
      type: "user.message",
      content: args.content,
    });

    // Mark the session running before spawning the background task. This
    // closes the window where a racing read could observe "idle" while a run
    // is about to begin.
    const runningSession = this.sessions.beginRun(args.sessionId) ?? session;

    this.executeInBackground(args.sessionId, agent, args.content).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.events.append({
        sessionId: args.sessionId,
        type: "agent.error",
        content: msg,
      });
      this.sessions.endRunFailure(args.sessionId, msg);
    });

    return { session: runningSession, event: userEvent };
  }

  private async executeInBackground(
    sessionId: string,
    agent: AgentConfig,
    content: string,
  ): Promise<void> {
    // Per-orchestrator-agent mount. Gives every orchestrator agent its own
    // isolated OpenClaw workspace (sessions.json, per-session JSONLs, skills
    // cache, models cache). The mount path is stable across container restarts
    // for the same orchestrator agent, which is what lets session resume work.
    const hostMount: Mount = {
      hostPath: `${this.cfg.hostStateRoot}/${agent.agentId}`,
      containerPath: "/workspace",
    };

    // Inside the container, OpenClaw always sees itself as agent "main".
    // That is OpenClaw's DEFAULT_AGENT_ID — aligning with it means:
    //   1. The session store lives at agents/main/sessions/sessions.json,
    //      which is where OpenClaw's session-key resolver and orphan-key
    //      migration both look by default.
    //   2. The canonical session key form `agent:main:<stable-key>` matches
    //      OpenClaw's buildAgentMainSessionKey output, so startup migrations
    //      don't wipe our mappings as "orphaned."
    // Multi-tenancy is provided by the mount path (one orchestrator agent =
    // one mount = one container), not by naming. The orchestrator's agent id
    // lives in the label and mount path; inside the container it is "main".
    const env: Record<string, string> = {
      ...this.cfg.passthroughEnv,
      OPENCLAW_AGENT_ID: "main",
      OPENCLAW_MODEL: agent.model,
      OPENCLAW_TOOLS: agent.tools.join(","),
      OPENCLAW_INSTRUCTIONS: agent.instructions,
      OPENCLAW_STATE_DIR: "/workspace",
      OPENCLAW_GATEWAY_PORT: String(this.cfg.gatewayPort),
    };

    const container = await this.runtime.spawn({
      image: this.cfg.runtimeImage,
      env,
      mounts: [hostMount],
      containerPort: this.cfg.gatewayPort,
      network: this.cfg.network,
      labels: {
        "orchestrator-agent-id": agent.agentId,
        "orchestrator-session-id": sessionId,
      },
    });

    try {
      await this.runtime.waitForReady(container, this.cfg.readyTimeoutMs);

      const completion = await this.invokeChatCompletions({
        baseUrl: container.baseUrl,
        token: container.token,
        content,
        sessionKey: sessionId,
      });

      this.events.append({
        sessionId,
        type: "agent.message",
        content: completion.output,
        tokensIn: completion.tokensIn,
        tokensOut: completion.tokensOut,
        costUsd: completion.costUsd,
        model: agent.model,
      });
      this.sessions.endRunSuccess(sessionId, {
        tokensIn: completion.tokensIn,
        tokensOut: completion.tokensOut,
        costUsd: completion.costUsd,
      });
    } finally {
      await this.runtime.stop(container.id).catch(() => {
        /* best-effort teardown */
      });
    }
  }

  private async invokeChatCompletions(args: {
    baseUrl: string;
    token: string;
    content: string;
    sessionKey: string;
  }): Promise<{ output: string; tokensIn: number; tokensOut: number; costUsd: number }> {
    const url = `${args.baseUrl}/v1/chat/completions`;
    // OpenClaw's OpenAI-compatible endpoint validates the `model` field against
    // either the literal "openclaw" or the "openclaw/<agentId>" pattern — it is
    // a routing hint, not the inference model. The actual model used is picked
    // from the selected agent's config (agents.list[].model.primary). See
    // /src/gateway/http-utils.ts:resolveAgentIdFromModel for the pattern.
    //
    // Session continuity: we send the session key in OpenClaw's canonical
    // `agent:<agentId>:<stable-key>` form so that OpenClaw's startup
    // orphan-key migration (src/infra/state-migrations.ts:1000) treats it as
    // already-canonicalized and does not rewrite it between turns. Sending a
    // bare key like `ses_xxx` causes the migration to canonicalize on the
    // next restart, producing a duplicate key in the store and losing
    // continuity — we verified this empirically in the two-turn smoke test.
    //
    // The container's internal agent id is always "main" (see executeInBackground
    // above) because that is OpenClaw's DEFAULT_AGENT_ID; per-orchestrator-agent
    // isolation is provided by the bind mount, not by agent naming inside the
    // container.
    const canonicalSessionKey = `agent:main:${args.sessionKey}`;
    const body = {
      model: "openclaw/main",
      user: args.sessionKey,
      messages: [{ role: "user", content: args.content }],
      stream: false,
    };

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${args.token}`,
        "x-openclaw-agent-id": "main",
        "x-openclaw-session-key": canonicalSessionKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.cfg.runTimeoutMs),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new RouterError(
        "chat_completions_failed",
        `/v1/chat/completions returned ${res.status}: ${text}`,
      );
    }

    const data = (await res.json()) as ChatCompletionResponse;
    const output = data.choices?.[0]?.message?.content ?? "";
    const usage = data.usage ?? { prompt_tokens: 0, completion_tokens: 0 };
    return {
      output,
      tokensIn: usage.prompt_tokens ?? 0,
      tokensOut: usage.completion_tokens ?? 0,
      // Cost accounting is Item 9 — leave it zero until the per-provider price
      // sheet lands.
      costUsd: 0,
    };
  }
}

type ChatCompletionResponse = {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

export type RouterErrorCode =
  | "agent_not_found"
  | "session_not_found"
  | "session_busy"
  | "chat_completions_failed";

export class RouterError extends Error {
  constructor(
    public readonly code: RouterErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RouterError";
  }
}
