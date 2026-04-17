import { chownSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { addContext, getLogger, withCapturedContext } from "../log.js";
import {
  sessionRunDurationSeconds,
  sessionRunFailuresTotal,
} from "../metrics.js";
import type {
  Container,
  Mount,
  NetworkingSpec,
  SpawnOptions,
} from "../runtime/container.js";
import { GatewayWsError } from "../runtime/gateway-ws.js";
import type { ParentTokenMinter } from "../runtime/parent-token.js";
import type { SessionContainerPool } from "../runtime/pool.js";
import type { PiJsonlEventReader } from "../store/pi-jsonl.js";
import type { AgentStore, EnvironmentStore, RunUsage, SessionStore } from "../store/types.js";
import type { SessionEventQueue } from "./event-queue.js";
import type { AgentConfig, Session } from "./types.js";

const log = getLogger("router");

// UID of the non-root `openclaw` user inside the agent runtime image,
// created by `useradd -r` in Dockerfile.runtime. Docker daemon on Linux
// creates bind-mount source directories as root:root, which the openclaw
// user inside the container cannot write to (`/workspace/openclaw.json:
// Permission denied`). Docker Desktop on macOS uses virtiofs UID remapping
// and sidesteps this, but Linux bind mounts preserve host UIDs literally.
// Fix: before spawning the container, pre-create the session workspace
// directory on the orchestrator's in-process mount view and chown it to
// this UID. On macOS the chown is a harmless no-op.
const AGENT_CONTAINER_UID = 999;

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
  /** Max time to wait for the agent task to complete end-to-end (ms). */
  runTimeoutMs: number;
  /**
   * Item 12-14: URL that the in-container `call_agent` CLI tool uses to
   * reach back to the orchestrator's HTTP API. Usually the orchestrator's
   * Docker service name + port (e.g. `http://openclaw-orchestrator:8080`).
   * Injected into every spawned container as OPENCLAW_ORCHESTRATOR_URL.
   */
  orchestratorUrl: string;
  /**
   * Item 12-14: token minter for per-container parent tokens. The router
   * mints a token scoped to each session's agent template + remaining
   * depth at container spawn time, injected as OPENCLAW_ORCHESTRATOR_TOKEN.
   */
  tokenMinter: ParentTokenMinter;
};

export type RunEventArgs = {
  sessionId: string;
  content: string;
  /**
   * Optional model override to apply to the session before this event.
   * Maps to a WS sessions.patch({ model }) call. Pi's setModel is
   * session-scoped, so the new model persists for this and subsequent
   * runs until changed again.
   */
  model?: string;
};

export type RunEventResult = {
  session: Session;
  /** True when the event was queued instead of triggering a run immediately. */
  queued: boolean;
};

export type PendingApproval = {
  approvalId: string;
  sessionId: string;
  toolName: string;
  description: string;
  arrivedAt: number;
};

export class AgentRouter {
  /** Pending tool-confirmation approvals per session. Populated by WS
   *  event listeners when the container's confirm-tools plugin fires
   *  `plugin.approval.requested`. Read by the SSE handler to emit
   *  `agent.tool_confirmation_request` events. Cleared on confirm/cancel/delete. */
  private readonly pendingApprovals = new Map<string, PendingApproval[]>();

  constructor(
    private readonly agents: AgentStore,
    private readonly environments: EnvironmentStore,
    private readonly sessions: SessionStore,
    private readonly events: PiJsonlEventReader,
    private readonly pool: SessionContainerPool,
    private readonly queue: SessionEventQueue,
    private readonly cfg: RouterConfig,
  ) {}

  /** Return any pending approval requests for a session (non-destructive). */
  getPendingApprovals(sessionId: string): PendingApproval[] {
    return this.pendingApprovals.get(sessionId) ?? [];
  }

  /**
   * Look up the session's environment and return the networking policy
   * the pool should apply. Returns undefined for unrestricted (pool
   * treats that the same as no config — legacy single-network path).
   *
   * Session argument is nullable because runEvent's safety path can
   * call this when the session was freshly looked up and might be gone
   * by the time we reach here. In that case, default to unrestricted.
   */
  private resolveNetworking(session: Session | null): NetworkingSpec | undefined {
    if (!session?.environmentId) return undefined;
    const env = this.environments.get(session.environmentId);
    if (!env) return undefined;
    if (env.networking.type === "limited") {
      return {
        type: "limited",
        allowedHosts: env.networking.allowedHosts,
      };
    }
    return undefined;
  }

  /**
   * Create a session bound to an agent. Pure metadata: no container spawn,
   * no JSONL allocation, no remote calls. The container is only spawned
   * when the first event is posted to this session via runEvent().
   *
   * Optional `remainingSubagentDepth` overrides the default (which is the
   * agent template's `maxSubagentDepth`). Used by the subagent spawn path
   * in server.ts after verifying an X-OpenClaw-Parent-Token header: the
   * child session inherits `parent.remaining_depth - 1` instead of its
   * own template's max depth.
   */
  createSession(
    agentId: string,
    opts?: { environmentId?: string; remainingSubagentDepth?: number },
  ): Session {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new RouterError("agent_not_found", `agent ${agentId} does not exist`);
    }
    if (agent.archivedAt) {
      throw new RouterError("agent_archived", `agent ${agentId} is archived`);
    }
    const remainingSubagentDepth =
      opts?.remainingSubagentDepth ?? agent.maxSubagentDepth;
    return this.sessions.create({
      agentId,
      environmentId: opts?.environmentId,
      remainingSubagentDepth,
    });
  }

  /**
   * Proactively start booting a container for the given session in the
   * background. Called by the server handler right after createSession so
   * the container is warm (or warming) by the time the first event arrives.
   * Fire-and-forget — failure is non-fatal, the first event will cold-spawn.
   */
  async warmSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      log.warn({ session_id: sessionId }, "warmSession: session not found, skipping warm-up");
      return;
    }
    const agent = this.agents.get(session.agentId);
    if (!agent) {
      log.warn({ session_id: sessionId, agent_id: session.agentId }, "warmSession: agent not found, skipping warm-up");
      return;
    }
    const spawnOptions = this.buildSpawnOptions(sessionId, agent, session);
    const networking = this.resolveNetworking(session);
    // Limited networking sessions aren't warm-pool eligible (each one
    // gets fresh per-session networks + sidecar); `warmSession` is
    // effectively a no-op for them, matching how `acquireForSession`
    // bypasses the warm pool for limited. Still call acquireForSession
    // so the spawn happens in the background.
    await this.pool.acquireForSession({
      sessionId,
      spawnOptions,
      agentId: agent.agentId,
      networking,
    });
  }

  /**
   * Pre-warm a container for an agent template so sessions on this agent
   * can claim an already-booted container instead of cold-spawning.
   * Fire-and-forget — failure is logged but not propagated.
   *
   * Skipped for delegating agents. `buildSpawnOptions` bakes the
   * sessionId into both Docker labels and the signed OPENCLAW_ORCHESTRATOR_TOKEN
   * env var, and Docker env is immutable post-create. A warm container
   * built with a placeholder sessionId would carry that placeholder into
   * every subagent spawn it later hosts — labels and the signed
   * parentSessionId would reference `__warm__` instead of the real
   * session. The orchestrator doesn't currently verify parentSessionId
   * against the session store, so the failure would be silent (wrong
   * lineage, not a crash). Skipping warm-up for delegating agents keeps
   * the benefit for the common non-delegating case while avoiding the
   * identity smear.
   */
  async warmForAgent(agentId: string): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    if (agent.callableAgents.length > 0 || agent.maxSubagentDepth > 0) {
      return;
    }
    const spawnOptions = this.buildSpawnOptions("__warm__", agent, {
      remainingSubagentDepth: 0,
      environmentId: null,
    } as Session);
    await this.pool.warmForAgent(agentId, spawnOptions);
  }

  /**
   * Post a user.message to an existing session. Behavior depends on
   * session status:
   *
   *   - Session idle:
   *       Marked running and the run is scheduled in the background. If
   *       `model` is set, the orchestrator first patches the session's
   *       model via the gateway WS so the run uses the new model.
   *
   *   - Session running:
   *       The event is enqueued onto the session's local queue. The
   *       background task that's currently running will pop the queue on
   *       completion and start the next iteration. The session stays in
   *       "running" state across the full chain.
   *
   * Returns the session (status=running in both branches) plus a `queued`
   * flag so the HTTP handler can report whether the event was queued.
   *
   * Note: Pi's "steer" semantics (interrupt the current run with a new
   * message) are not in Item 7. Cleanly implementing it requires either
   * a WS event subscription so the orchestrator knows when the post-steer
   * run finishes, or per-session task tracking so the cancel-then-post
   * sequence doesn't race the in-flight HTTP request. Both are tracked
   * for a follow-up; for now clients that need to redirect a running
   * session can call cancel + post a new event, accepting the small
   * latency hit of two HTTP round trips.
   */
  async runEvent(args: RunEventArgs): Promise<RunEventResult> {
    const session = this.sessions.get(args.sessionId);
    if (!session) {
      throw new RouterError(
        "session_not_found",
        `session ${args.sessionId} does not exist`,
      );
    }
    const agent = this.agents.get(session.agentId);
    if (!agent) {
      // Safety net: the session outlives its template only if the template
      // was deleted while the session was idle. Treat as a hard error — we
      // cannot spawn a container without the config.
      throw new RouterError(
        "agent_not_found",
        `agent ${session.agentId} does not exist`,
      );
    }

    if (session.status === "running") {
      // Queue path: the current background task will pop this on completion.
      this.queue.enqueue(args.sessionId, {
        content: args.content,
        model: args.model,
        enqueuedAt: Date.now(),
      });
      return { session, queued: true };
    }

    // Idle path: start a new run.
    const runningSession = this.sessions.beginRun(args.sessionId) ?? session;
    addContext({ sessionId: args.sessionId, agentId: agent.agentId });

    // Capture the current context (request-id + session/agent) so that the
    // fire-and-forget background task's logs carry the same identifiers
    // as the HTTP handler that kicked it off.
    const runInBackground = withCapturedContext(() =>
      this.executeInBackground(args.sessionId, agent, args.content, args.model),
    );
    const handleFailure = withCapturedContext((err: unknown) =>
      this.handleBackgroundFailure(args.sessionId, err),
    );
    void runInBackground().catch(handleFailure);

    return { session: runningSession, queued: false };
  }

  /**
   * Cancel a running session. Aborts the in-flight run via the gateway WS
   * control plane and clears any queued events for the session. Sets the
   * session back to idle (no error recorded — cancellation is a deliberate
   * stop, not an agent failure). Returns the updated Session.
   */
  async cancel(sessionId: string): Promise<Session> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new RouterError(
        "session_not_found",
        `session ${sessionId} does not exist`,
      );
    }
    if (session.status !== "running") {
      throw new RouterError(
        "session_not_running",
        `session ${sessionId} is not currently running`,
      );
    }
    const wsClient = this.pool.getWsClient(sessionId);
    if (!wsClient) {
      throw new RouterError(
        "no_active_container",
        `session ${sessionId} is running but has no live container`,
      );
    }
    const canonicalKey = `agent:main:${sessionId}`;
    try {
      await wsClient.abort(canonicalKey);
    } catch (err) {
      throw wrapWsError(err, "cancel_failed");
    }
    // Drain queued events and pending approvals.
    this.queue.clear(sessionId);
    this.pendingApprovals.delete(sessionId);
    return this.sessions.endRunCancelled(sessionId) ?? session;
  }

  /**
   * Resolve a pending tool-confirmation approval. Called when the client
   * sends a `user.tool_confirmation` event in response to an
   * `agent.tool_confirmation_request` SSE event. Routes the decision to
   * the container's gateway via WS `plugin.approval.resolve`.
   */
  async confirmTool(
    sessionId: string,
    approvalId: string,
    decision: "allow" | "deny",
    denyMessage?: string,
  ): Promise<void> {
    const wsClient = this.pool.getWsClient(sessionId);
    if (!wsClient) {
      throw new RouterError(
        "no_active_container",
        `session ${sessionId} has no live container for tool confirmation`,
      );
    }
    // Pop the resolved approval from the pending queue.
    const pending = this.pendingApprovals.get(sessionId);
    if (pending) {
      const idx = pending.findIndex((a) => a.approvalId === approvalId);
      if (idx >= 0) pending.splice(idx, 1);
      if (pending.length === 0) this.pendingApprovals.delete(sessionId);
    }
    const wsDecision = decision === "allow" ? "allow-once" : "deny";
    try {
      await wsClient.approvalResolve(approvalId, wsDecision, denyMessage);
    } catch (err) {
      throw wrapWsError(err, "confirm_tool_failed");
    }
  }

  private buildSpawnOptions(
    sessionId: string,
    agent: AgentConfig,
    session: Session,
  ): SpawnOptions {
    const hostMount: Mount = {
      hostPath: `${this.cfg.hostStateRoot}/${agent.agentId}`,
      containerPath: "/workspace",
    };

    const inProcessWorkspace = join(this.events.stateRoot, agent.agentId);
    mkdirSync(inProcessWorkspace, { recursive: true, mode: 0o755 });
    try {
      chownSync(inProcessWorkspace, AGENT_CONTAINER_UID, AGENT_CONTAINER_UID);
    } catch {
      // Non-fatal on Mac/userns — see AGENT_CONTAINER_UID comment.
    }

    const remainingDepth = session.remainingSubagentDepth;
    const parentToken = this.cfg.tokenMinter.mint({
      parentSessionId: sessionId,
      parentAgentId: agent.agentId,
      allowlist: agent.callableAgents,
      remainingDepth,
    });

    let effectiveInstructions = agent.instructions;
    if (agent.callableAgents.length > 0 && remainingDepth > 0) {
      const hint = [
        "",
        "## Delegation",
        "You can delegate tasks to other agents via the `openclaw-call-agent` CLI.",
        `Allowed target agents: ${agent.callableAgents.join(", ")}.`,
        "Invoke it through your `exec` tool:",
        '  openclaw-call-agent --target <agent_id> --task "<prompt>"',
        "Run `openclaw-call-agent --help` for full usage. The tool returns JSON on stdout with the subagent's final reply and a `subagent_session_id` you can use to inspect the delegated run.",
      ].join("\n");
      effectiveInstructions = effectiveInstructions
        ? `${effectiveInstructions}\n${hint}`
        : hint.trimStart();
    }

    const envConfig = session.environmentId
      ? this.environments.get(session.environmentId)
      : undefined;

    const env: Record<string, string> = {
      ...this.cfg.passthroughEnv,
      OPENCLAW_AGENT_ID: "main",
      OPENCLAW_MODEL: agent.model,
      OPENCLAW_TOOLS: agent.tools.join(","),
      OPENCLAW_INSTRUCTIONS: effectiveInstructions,
      OPENCLAW_STATE_DIR: "/workspace",
      OPENCLAW_GATEWAY_PORT: String(this.cfg.gatewayPort),
      OPENCLAW_ORCHESTRATOR_URL: this.cfg.orchestratorUrl,
      OPENCLAW_ORCHESTRATOR_TOKEN: parentToken,
    };
    if (envConfig?.packages) {
      env.OPENCLAW_PACKAGES_JSON = JSON.stringify(envConfig.packages);
    }
    if (agent.permissionPolicy.type === "deny") {
      env.OPENCLAW_DENIED_TOOLS = agent.permissionPolicy.tools.join(",");
    }
    if (agent.permissionPolicy.type === "always_ask") {
      // When `tools` is undefined, the plugin confirms ALL tools.
      // When `tools` is an array, only those tools require confirmation.
      env.OPENCLAW_CONFIRM_TOOLS = agent.permissionPolicy.tools
        ? agent.permissionPolicy.tools.join(",")
        : "__ALL__";
    }

    return {
      image: this.cfg.runtimeImage,
      env,
      mounts: [hostMount],
      containerPort: this.cfg.gatewayPort,
      network: this.cfg.network,
      labels: {
        "orchestrator-agent-id": agent.agentId,
        "orchestrator-session-id": sessionId,
      },
    };
  }

  private async executeInBackground(
    sessionId: string,
    agent: AgentConfig,
    content: string,
    modelOverride?: string,
  ): Promise<void> {
    const currentSession = this.sessions.get(sessionId);
    const spawnOptions = this.buildSpawnOptions(
      sessionId,
      agent,
      currentSession ?? { remainingSubagentDepth: 0, environmentId: null } as Session,
    );

    // Pool-backed: the first event for a session spawns a fresh container,
    // waits for /readyz, and runs the WS handshake; subsequent events
    // reuse the live container and live WS client. NO finally { stop } —
    // teardown is the pool's responsibility.
    const container: Container = await this.pool.acquireForSession({
      sessionId,
      spawnOptions,
      agentId: agent.agentId,
      networking: this.resolveNetworking(currentSession ?? null),
    });

    // Subscribe to approval broadcasts when the agent has always_ask.
    // The WS client was opened during acquireForSession; we attach a
    // listener for `plugin.approval.requested` so the SSE handler can
    // surface approval requests to the client.
    if (agent.permissionPolicy.type === "always_ask") {
      const wsClient = this.pool.getWsClient(sessionId);
      if (wsClient) {
        wsClient.onEvent("plugin.approval.requested", (payload) => {
          const p = payload as Record<string, unknown> | undefined;
          const approvalId = String(p?.id ?? "");
          const toolName = String(p?.toolName ?? p?.title ?? "");
          const description = String(p?.description ?? "");
          if (!approvalId) return;
          const list = this.pendingApprovals.get(sessionId) ?? [];
          list.push({ approvalId, sessionId, toolName, description, arrivedAt: Date.now() });
          this.pendingApprovals.set(sessionId, list);
          log.info(
            { session_id: sessionId, tool_name: toolName, approval_id: approvalId },
            "tool approval requested",
          );
        });
      }
    }

    // Per-event model override. Apply via WS patch BEFORE the chat
    // completions call. The WS handshake completed during acquire so a
    // client must be present here; if it's missing, treat as an
    // infrastructure failure and evict.
    if (modelOverride) {
      const wsClient = this.pool.getWsClient(sessionId);
      if (!wsClient) {
        await this.pool.evictSession(sessionId).catch(() => {
          /* best-effort */
        });
        throw new RouterError(
          "no_active_container",
          `session ${sessionId} has no WS client for model patch`,
        );
      }
      const canonicalKey = `agent:main:${sessionId}`;
      try {
        await wsClient.patch(canonicalKey, { model: modelOverride });
      } catch (err) {
        await this.pool.evictSession(sessionId).catch(() => {
          /* best-effort */
        });
        throw wrapWsError(err, "patch_failed");
      }
    }

    // Run the completion. On failure, do NOT evict here — the failure
    // handler decides whether to evict based on whether the session was
    // also cancelled in flight. Time the whole invocation so /metrics
    // exposes session_run_duration_seconds as a histogram.
    const runEnd = sessionRunDurationSeconds.startTimer();
    const completion = await this.invokeChatCompletions({
      baseUrl: container.baseUrl,
      token: container.token,
      content,
      sessionKey: sessionId,
    });
    runEnd();

    // Item 9 — cost accounting. Pi's provider plugins compute the
    // authoritative per-turn cost from their catalogs (cache-aware: a
    // cacheRead-heavy turn pays the cache-read rate, not the normal
    // input rate) and write it to message.usage.cost.total in the JSONL.
    // PiJsonlEventReader already surfaces that as agent.message.costUsd,
    // so the orchestrator reads the single source of truth rather than
    // maintaining a separate static price sheet that would drift. If
    // the provider plugin does not report cost (e.g., our moonshot
    // config block in docker/entrypoint.sh currently hardcodes zeros),
    // the recorded cost is 0 — not a rollup bug, just the truth per
    // the active catalog. Updating moonshot's prices there will
    // propagate through this path with zero code changes.
    const latestAgent = this.events.latestAgentMessage(agent.agentId, sessionId);
    const costUsd = latestAgent?.costUsd ?? 0;

    const usage: RunUsage = {
      tokensIn: completion.tokensIn,
      tokensOut: completion.tokensOut,
      costUsd,
    };

    // Drain the queue, if any. When the queue has more, roll up usage
    // without flipping to idle and recursively process the next entry —
    // the session stays "running" through the whole chain so polling
    // clients never observe a brief idle window between queued runs.
    const next = this.queue.shift(sessionId);
    if (next) {
      this.sessions.addUsage(sessionId, usage);
      void this.executeInBackground(sessionId, agent, next.content, next.model)
        .catch((err) => this.handleBackgroundFailure(sessionId, err));
      return;
    }

    this.sessions.endRunSuccess(sessionId, usage);
  }

  /**
   * Centralized failure handling for background tasks. Called from the
   * outer .catch of every executeInBackground invocation (idle path and
   * queue-drain recursive path). The guard against status != running is
   * the one piece that makes cancel correct: when cancel runs first, it
   * sets status=idle, then the in-flight chat completions request errors
   * out via the WS abort, and that error surfaces here as a "failure" we
   * must NOT record over the cancel's idle state.
   *
   * Eviction policy: only evict when the failure was a real run failure
   * (status was still running at catch time). If status is already idle,
   * the failure is a side-effect of an external cancel and the container
   * is still healthy — leave it in the pool.
   */
  private handleBackgroundFailure(sessionId: string, err: unknown): void {
    const current = this.sessions.get(sessionId);
    if (current?.status !== "running") {
      // Session was cancelled or otherwise transitioned. The error is the
      // cancellation propagating through the in-flight HTTP request.
      // Don't evict, don't fail.
      return;
    }
    // Drop any queued events and pending approvals.
    const dropped = this.queue.clear(sessionId);
    this.pendingApprovals.delete(sessionId);
    if (dropped > 0) {
      log.warn(
        { session_id: sessionId, dropped_events: dropped },
        "dropped queued events for failed session",
      );
    }
    void this.pool.evictSession(sessionId).catch(() => {
      /* best-effort */
    });
    const msg = err instanceof Error ? err.message : String(err);
    sessionRunFailuresTotal.inc();
    log.error({ session_id: sessionId, err }, "session run failed");
    this.sessions.endRunFailure(sessionId, msg);
  }

  private async invokeChatCompletions(args: {
    baseUrl: string;
    token: string;
    content: string;
    sessionKey: string;
  }): Promise<{ output: string; tokensIn: number; tokensOut: number }> {
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
    };
  }
}

type ChatCompletionResponse = {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

export type RouterErrorCode =
  | "agent_not_found"
  | "agent_archived"
  | "session_not_found"
  | "session_busy"
  | "session_not_running"
  | "no_active_container"
  | "chat_completions_failed"
  | "cancel_failed"
  | "patch_failed"
  | "confirm_tool_failed";

export class RouterError extends Error {
  constructor(
    public readonly code: RouterErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RouterError";
  }
}

function wrapWsError(err: unknown, fallbackCode: RouterErrorCode): RouterError {
  if (err instanceof GatewayWsError) {
    return new RouterError(fallbackCode, `${err.code}: ${err.message}`);
  }
  const msg = err instanceof Error ? err.message : String(err);
  return new RouterError(fallbackCode, msg);
}
