import { chownSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { addContext, getLogger, withCapturedContext } from "../log.js";
import {
  quotaRejectionsTotal,
  sessionRunDurationSeconds,
  sessionRunFailuresTotal,
} from "../metrics.js";
import type {
  Container,
  Mount,
  NetworkingSpec,
  SpawnOptions,
} from "../runtime/container.js";
import { GatewayWebSocketClient, GatewayWsError } from "../runtime/gateway-ws.js";
import type { ParentTokenMinter } from "../runtime/parent-token.js";
import type { SessionContainerPool } from "../runtime/pool.js";
import type { PiJsonlEventReader } from "../store/pi-jsonl.js";
import type {
  AgentStore,
  EnvironmentStore,
  QueueStore,
  RunUsage,
  SessionStore,
  VaultStore,
} from "../store/types.js";
import type { VaultCredentialMcpOAuth } from "../store/types.js";
import type { AgentConfig, Event, Session } from "./types.js";

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

export function normalizeModelForRuntime(
  model: string,
  passthroughEnv: Record<string, string>,
): string {
  if (!passthroughEnv.ZENMUX_API_KEY) return model;
  return model.startsWith("zenmux/") ? model : `zenmux/${model}`;
}

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
  /**
   * Optional thinking-level override for this turn. Applied via the same
   * WS sessions.patch path as `model`. Session-scoped like model —
   * persists across subsequent runs until changed.
   */
  thinkingLevel?: string;
};

export type RunEventResult = {
  session: Session;
  /** True when the event was queued instead of triggering a run immediately. */
  queued: boolean;
};

export type StreamOutcome = { ok: true } | { ok: false; error: string };

/**
 * Handle returned from `streamEvent`. The HTTP handler pipes `chunks` to
 * the client's SSE output, then calls `finalize` — success path rolls
 * cost up from the JSONL and flips the session idle; error path evicts
 * the container and records the failure. `finalize` is idempotent and
 * guarded against external-cancel races (it no-ops if another path has
 * already transitioned the session out of "running"), so the caller
 * doesn't need a status check of its own.
 */
export type StreamingRunHandle = {
  session: Session;
  /**
   * Async iterator of raw SSE `data:` payload strings from the
   * container's `/v1/chat/completions` response. Each yielded string is
   * the inner body of one SSE frame (no `data: ` prefix). The iterator
   * terminates after yielding the final `"[DONE]"` sentinel OR when the
   * underlying socket closes.
   */
  chunks: AsyncGenerator<string, void, void>;
  finalize(outcome: StreamOutcome): Promise<void>;
};

export type PendingApproval = {
  approvalId: string;
  sessionId: string;
  toolName: string;
  toolCallId?: string;
  description: string;
  arrivedAt: number;
};

type TurnProgressSnapshot = {
  userTurns: number;
  latestAgentMessageId?: string;
};

export class AgentRouter {
  /** Pending tool-confirmation approvals per session. Populated by WS
   *  event listeners when the container's confirm-tools plugin fires
   *  `plugin.approval.requested`. Read by the SSE handler to emit
   *  `agent.tool_confirmation_request` events. Cleared on confirm/cancel/delete. */
  private readonly pendingApprovals = new Map<string, PendingApproval[]>();
  /** One plugin-approval WS subscription pair per active session. */
  private readonly approvalSubscriptions = new Map<
    string,
    {
      wsClient: GatewayWebSocketClient;
      unsubscribeRequested: () => void;
      unsubscribeResolved: () => void;
    }
  >();
  /**
   * Sessions whose cancel was requested while the background task was
   * still in the acquire phase (no container / WS client yet). The
   * cancel handler sets the flag; executeInBackground checks it after
   * acquiring and aborts before posting to the container.
   */
  private readonly cancelledDuringAcquire = new Set<string>();

  constructor(
    private readonly agents: AgentStore,
    private readonly environments: EnvironmentStore,
    private readonly sessions: SessionStore,
    private readonly events: PiJsonlEventReader,
    private readonly pool: SessionContainerPool,
    private readonly queue: QueueStore,
    private readonly vaults: VaultStore,
    private readonly cfg: RouterConfig,
  ) {}

  /** Return any pending approval requests for a session (non-destructive). */
  getPendingApprovals(sessionId: string): PendingApproval[] {
    return this.pendingApprovals.get(sessionId) ?? [];
  }

  private replacePendingApprovals(sessionId: string, approvals: PendingApproval[]): void {
    if (approvals.length === 0) {
      this.pendingApprovals.delete(sessionId);
      return;
    }
    const deduped = new Map<string, PendingApproval>();
    for (const approval of approvals) {
      deduped.set(approval.approvalId, approval);
    }
    this.pendingApprovals.set(sessionId, [...deduped.values()]);
  }

  private upsertPendingApproval(sessionId: string, approval: PendingApproval): void {
    const pending = this.pendingApprovals.get(sessionId) ?? [];
    const idx = pending.findIndex((item) => item.approvalId === approval.approvalId);
    if (idx >= 0) pending[idx] = approval;
    else pending.push(approval);
    this.pendingApprovals.set(sessionId, pending);
  }

  private removePendingApproval(sessionId: string, approvalId: string): void {
    const pending = this.pendingApprovals.get(sessionId);
    if (!pending) return;
    const next = pending.filter((item) => item.approvalId !== approvalId);
    if (next.length === 0) this.pendingApprovals.delete(sessionId);
    else this.pendingApprovals.set(sessionId, next);
  }

  private clearApprovalSubscriptions(sessionId: string): void {
    const current = this.approvalSubscriptions.get(sessionId);
    if (!current) return;
    try {
      current.unsubscribeRequested();
    } catch {
      /* best-effort */
    }
    try {
      current.unsubscribeResolved();
    } catch {
      /* best-effort */
    }
    this.approvalSubscriptions.delete(sessionId);
  }

  private parsePendingApproval(
    sessionId: string,
    payload: unknown,
  ): PendingApproval | undefined {
    const root = isRecord(payload) ? payload : undefined;
    const request = isRecord(root?.request) ? root.request : undefined;
    const approvalId = asNonEmptyString(root?.id);
    if (!approvalId) return undefined;
    return {
      approvalId,
      sessionId,
      toolName:
        asNonEmptyString(request?.toolName) ??
        asNonEmptyString(root?.toolName) ??
        asNonEmptyString(request?.title) ??
        asNonEmptyString(root?.title) ??
        "",
      toolCallId:
        asNonEmptyString(request?.toolCallId) ??
        asNonEmptyString(root?.toolCallId) ??
        undefined,
      description:
        asNonEmptyString(request?.description) ??
        asNonEmptyString(root?.description) ??
        "",
      arrivedAt: asFiniteNumber(root?.createdAtMs) ?? Date.now(),
    };
  }

  private async syncPendingApprovals(
    sessionId: string,
    wsClient: GatewayWebSocketClient,
  ): Promise<void> {
    try {
      const records = await wsClient.approvalList();
      const approvals = records
        .map((record) => this.parsePendingApproval(sessionId, record))
        .filter((approval): approval is PendingApproval => approval !== undefined);
      this.replacePendingApprovals(sessionId, approvals);
    } catch (err) {
      log.warn(
        { err, session_id: sessionId },
        "approval-list sync failed",
      );
    }
  }

  private async ensureApprovalSubscriptions(
    sessionId: string,
    wsClient: GatewayWebSocketClient,
  ): Promise<void> {
    const existing = this.approvalSubscriptions.get(sessionId);
    if (existing?.wsClient === wsClient) {
      await this.syncPendingApprovals(sessionId, wsClient);
      return;
    }
    this.clearApprovalSubscriptions(sessionId);

    const unsubscribeRequested = wsClient.onEvent("plugin.approval.requested", (payload) => {
      const approval = this.parsePendingApproval(sessionId, payload);
      if (!approval) return;
      this.upsertPendingApproval(sessionId, approval);
      log.info(
        {
          session_id: sessionId,
          tool_name: approval.toolName,
          tool_call_id: approval.toolCallId,
          approval_id: approval.approvalId,
        },
        "tool approval requested",
      );
    });

    const unsubscribeResolved = wsClient.onEvent("plugin.approval.resolved", (payload) => {
      const root = isRecord(payload) ? payload : undefined;
      const approvalId = asNonEmptyString(root?.id);
      if (!approvalId) return;
      this.removePendingApproval(sessionId, approvalId);
      log.info(
        { session_id: sessionId, approval_id: approvalId, decision: asNonEmptyString(root?.decision) ?? "" },
        "tool approval resolved",
      );
    });

    this.approvalSubscriptions.set(sessionId, {
      wsClient,
      unsubscribeRequested,
      unsubscribeResolved,
    });
    await this.syncPendingApprovals(sessionId, wsClient);
  }

  /**
   * Enforce the agent template's per-session quota against the session's
   * rolling totals (cost, tokens) and elapsed wall time. Throws
   * `quota_exceeded` on any violation. Called BEFORE the container is
   * invoked — we refuse to start a turn we know the session can't
   * afford. Post-turn overage (a single turn exceeding the remaining
   * budget) is accepted and rejected on the NEXT turn; that's simpler
   * than aborting mid-run and matches the "budget is a soft ceiling"
   * contract operators actually want. Operators who need a hard kill
   * stack runTimeoutMs on top.
   */
  private assertQuota(session: Session, agent: AgentConfig): void {
    const q = agent.quota;
    if (!q) return;
    if (q.maxCostUsdPerSession !== undefined && session.costUsd >= q.maxCostUsdPerSession) {
      quotaRejectionsTotal.labels({ kind: "cost" }).inc();
      throw new RouterError(
        "quota_exceeded",
        `session ${session.sessionId} has spent $${session.costUsd.toFixed(4)} which meets or exceeds its quota of $${q.maxCostUsdPerSession}`,
      );
    }
    if (q.maxTokensPerSession !== undefined) {
      const tokens = session.tokensIn + session.tokensOut;
      if (tokens >= q.maxTokensPerSession) {
        quotaRejectionsTotal.labels({ kind: "tokens" }).inc();
        throw new RouterError(
          "quota_exceeded",
          `session ${session.sessionId} has consumed ${tokens} tokens which meets or exceeds its quota of ${q.maxTokensPerSession}`,
        );
      }
    }
    if (q.maxWallDurationMs !== undefined) {
      const elapsed = Date.now() - session.createdAt;
      if (elapsed >= q.maxWallDurationMs) {
        quotaRejectionsTotal.labels({ kind: "duration" }).inc();
        throw new RouterError(
          "quota_exceeded",
          `session ${session.sessionId} has been alive for ${elapsed}ms which meets or exceeds its duration quota of ${q.maxWallDurationMs}ms`,
        );
      }
    }
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
    opts?: { environmentId?: string; remainingSubagentDepth?: number; vaultId?: string; parentSessionId?: string; userId?: string },
  ): Session {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new RouterError("agent_not_found", `agent ${agentId} does not exist`);
    }
    if (agent.archivedAt) {
      throw new RouterError("agent_archived", `agent ${agentId} is archived`);
    }
    if (opts?.vaultId && !this.vaults.getVault(opts.vaultId)) {
      throw new RouterError(
        "vault_not_found",
        `vault ${opts.vaultId} does not exist`,
      );
    }
    const remainingSubagentDepth =
      opts?.remainingSubagentDepth ?? agent.maxSubagentDepth;
    return this.sessions.create({
      agentId,
      environmentId: opts?.environmentId,
      remainingSubagentDepth,
      vaultId: opts?.vaultId,
      parentSessionId: opts?.parentSessionId,
      userId: opts?.userId,
    });
  }

  /**
   * Proactively start booting a container for the given session in the
   * background. Called by the server handler right after createSession.
   * Only sessions whose boot config is purely template-level can use this;
   * sessions with dedicated container config simply skip the warm path and
   * cold-spawn on first event. Fire-and-forget — failure is non-fatal.
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
    // Template-level warm containers are only reusable for sessions whose
    // boot config is also template-level. Skip the background warm when
    // this session needs its own container config (vault creds, limited
    // networking, package preinstalls).
    if (this.shouldBypassWarmPool(session)) {
      return;
    }
    // Delegate to warmForAgent so session-create / agent-create / startup
    // all share the same per-agent dedupe path. With the current
    // per-session sandbox model, sessions on the same agent have separate
    // /workspace mounts and may run in parallel; the dedupe here is only
    // for speculative template warming.
    await this.warmForAgent(agent.agentId);
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
    const warmKey = `__warm_${crypto.randomUUID().slice(0, 8)}__`;
    const spawnOptions = this.buildSpawnOptions(warmKey, agent, {
      remainingSubagentDepth: 0,
      environmentId: null,
    } as Session);
    await this.pool.warmForAgent(agentId, spawnOptions);
  }

  /**
   * Drop the warm container held for the given agent template. Called
   * from the agent-delete HTTP handler so we don't leak a ~4 GB
   * container on a template that no longer exists. Idempotent + safe
   * to call for agents that never had a warm in the first place.
   */
  async dropWarmForAgent(agentId: string): Promise<void> {
    await this.pool.dropWarmForAgent(agentId);
  }

  /**
   * Tear down any live runtime resources for a session without deleting the
   * session metadata itself. Used by DELETE /v1/sessions so the container,
   * queue, pending approvals, and persistent session↔container mapping do
   * not outlive the session row.
   */
  async disposeSessionRuntime(sessionId: string): Promise<void> {
    this.cancelledDuringAcquire.delete(sessionId);
    this.queue.clear(sessionId);
    this.pendingApprovals.delete(sessionId);
    this.clearApprovalSubscriptions(sessionId);
    await this.pool.evictSession(sessionId);
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

    // Quotas are checked BEFORE the busy-session queue path: we refuse
    // to even enqueue a run for a session that's already out of budget.
    this.assertQuota(session, agent);

    if (session.status === "running") {
      this.queue.enqueue(args.sessionId, {
        content: args.content,
        model: args.model,
        thinkingLevel: args.thinkingLevel,
        enqueuedAt: Date.now(),
      });
      this.sessions.bumpTurns(args.sessionId);
      return { session, queued: true };
    }

    const runningSession = this.sessions.beginRun(args.sessionId) ?? session;
    this.sessions.bumpTurns(args.sessionId);
    addContext({ sessionId: args.sessionId, agentId: agent.agentId });

    // Capture the current context (request-id + session/agent) so that the
    // fire-and-forget background task's logs carry the same identifiers
    // as the HTTP handler that kicked it off.
    const runInBackground = withCapturedContext(() =>
      this.executeInBackground(
        args.sessionId,
        agent,
        args.content,
        args.model,
        args.thinkingLevel,
      ),
    );
    const handleFailure = withCapturedContext((err: unknown) =>
      this.handleBackgroundFailure(args.sessionId, err),
    );
    void runInBackground().catch(handleFailure);

    return { session: runningSession, queued: false };
  }

  /**
   * Streaming variant of runEvent. Commits to the HTTP handler's lifetime:
   * the container's `/v1/chat/completions` is called with `stream: true`,
   * the resulting SSE frames are surfaced through `chunks` for the caller
   * to pipe to its client, and `finalize` closes out the session.
   *
   * Rejects with `session_busy` when the session already has a run in
   * flight — streaming cannot interleave with the queue-drain path the
   * non-streaming runEvent uses, so the caller's contract is "either the
   * session is idle and you own the whole run, or retry after it drains".
   * Returns after acquiring the container + opening the upstream stream;
   * `chunks` is already live at that point.
   */
  async streamEvent(args: RunEventArgs): Promise<StreamingRunHandle> {
    const session = this.sessions.get(args.sessionId);
    if (!session) {
      throw new RouterError(
        "session_not_found",
        `session ${args.sessionId} does not exist`,
      );
    }
    const agent = this.agents.get(session.agentId);
    if (!agent) {
      throw new RouterError(
        "agent_not_found",
        `agent ${session.agentId} does not exist`,
      );
    }
    if (session.status === "running") {
      throw new RouterError(
        "session_busy",
        `session ${args.sessionId} is busy; wait for the current run to complete before streaming`,
      );
    }
    this.assertQuota(session, agent);

    const running = this.sessions.beginRun(args.sessionId) ?? session;
    this.sessions.bumpTurns(args.sessionId);
    addContext({ sessionId: args.sessionId, agentId: agent.agentId });

    try {
      // Refresh any OAuth credentials bound to this session that are
      // about to expire, BEFORE we build spawn options (buildSpawnOptions
      // reads the updated creds via injectVaultCredentials). Throws
      // `credential_expired` on refresh failure so the caller's app
      // knows to re-run OAuth for the end-user.
      await this.refreshExpiringOAuthCredentials(agent, running.vaultId ?? null);
      const spawnOptions = this.buildSpawnOptions(args.sessionId, agent, running);
      const networking = this.resolveNetworking(running);
      const container = await this.pool.acquireForSession({
        sessionId: args.sessionId,
        spawnOptions,
        agentId: agent.agentId,
        networking,
        bypassWarmPool: this.shouldBypassWarmPool(running),
      });

      if (agent.permissionPolicy.type === "always_ask") {
        const wsClient = this.pool.getWsClient(args.sessionId);
        if (wsClient) {
          await this.ensureApprovalSubscriptions(args.sessionId, wsClient);
        }
      }

      const effectiveThinking = args.thinkingLevel ?? agent.thinkingLevel;
      const streamIsFirstTurn = session.turns <= 1;
      if ((args.model || effectiveThinking !== "off") && !streamIsFirstTurn) {
        const wsClient = this.pool.getWsClient(args.sessionId);
        if (!wsClient) {
          throw new RouterError(
            "no_active_container",
            `session ${args.sessionId} has no WS client for patch`,
          );
        }
        const patch: Record<string, string> = {};
        if (args.model) patch.model = args.model;
        if (effectiveThinking !== "off") patch.thinkingLevel = effectiveThinking;
        try {
          await wsClient.patch(`agent:main:${args.sessionId}`, patch);
        } catch (patchErr) {
          log.warn(
            { session_id: args.sessionId, err: patchErr },
            "WS patch failed — proceeding without patch",
          );
        }
      }

      const beforeTurn = this.snapshotTurnProgress(agent.agentId, args.sessionId);

      const canonicalSessionKey = `agent:main:${args.sessionId}`;
      const runEnd = sessionRunDurationSeconds.startTimer();
      const res = await fetch(`${container.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          Authorization: `Bearer ${container.token}`,
          "x-openclaw-agent-id": "main",
          "x-openclaw-session-key": canonicalSessionKey,
        },
        body: JSON.stringify({
          model: "openclaw/main",
          user: args.sessionId,
          messages: [{ role: "user", content: args.content }],
          stream: true,
        }),
        signal: AbortSignal.timeout(this.cfg.runTimeoutMs),
      });

      if (!res.ok) {
        runEnd();
        const text = await res.text().catch(() => "");
        throw new RouterError(
          "chat_completions_failed",
          `/v1/chat/completions returned ${res.status}: ${text}`,
        );
      }
      if (!res.body) {
        runEnd();
        throw new RouterError(
          "chat_completions_failed",
          "/v1/chat/completions returned empty body",
        );
      }

      const reader = res.body.getReader();
      const chunks = (async function* (): AsyncGenerator<string, void, void> {
        const decoder = new TextDecoder("utf-8");
        let buf = "";
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            // SSE frames are separated by a blank line. We split eagerly
            // so we can yield each complete frame the moment it arrives —
            // partial frames stay in buf until the next read. This is the
            // only parsing we do: the rest of the SSE body (the inner
            // ChatCompletionChunk JSON) is opaque to the orchestrator;
            // the client speaks OpenAI's chunk schema, we just relay it.
            let sep: number;
            // eslint-disable-next-line no-cond-assign
            while ((sep = buf.indexOf("\n\n")) !== -1) {
              const frame = buf.slice(0, sep);
              buf = buf.slice(sep + 2);
              const dataLines: string[] = [];
              for (const line of frame.split("\n")) {
                if (line.startsWith("data:")) {
                  dataLines.push(line.slice(5).replace(/^ /, ""));
                }
              }
              if (dataLines.length === 0) continue;
              const data = dataLines.join("\n");
              yield data;
              if (data === "[DONE]") return;
            }
          }
        } finally {
          runEnd();
          try {
            reader.releaseLock();
          } catch {
            /* reader already released */
          }
        }
      })();

      const router = this;
      const finalize = async (outcome: StreamOutcome): Promise<void> => {
        // External-cancel race guard: another path may have already flipped
        // status (cancel + drain). Don't overwrite that with our outcome.
        const current = router.sessions.get(args.sessionId);
        if (current?.status !== "running") return;
        if (outcome.ok) {
          const latest = router.assertTurnAdvanced(
            agent.agentId,
            args.sessionId,
            beforeTurn,
          );
          const tokensIn = latest?.tokensIn ?? 0;
          const tokensOut = latest?.tokensOut ?? 0;
          const costUsd = latest?.costUsd ?? 0;
          router.pendingApprovals.delete(args.sessionId);
          router.sessions.endRunSuccess(args.sessionId, { tokensIn, tokensOut, costUsd });
          return;
        }
        sessionRunFailuresTotal.inc();
        log.error(
          { session_id: args.sessionId, error: outcome.error },
          "streaming run failed",
        );
        router.pendingApprovals.delete(args.sessionId);
        router.clearApprovalSubscriptions(args.sessionId);
        await router.pool.evictSession(args.sessionId).catch(() => {
          /* best-effort */
        });
        router.sessions.endRunFailure(args.sessionId, outcome.error);
      };

      return { session: running, chunks, finalize };
    } catch (err) {
      // Failure BEFORE we handed the stream to the caller — unwind the
      // beginRun transition ourselves. Evict the container because the
      // WS patch / initial HTTP may have left it in a bad state.
      const msg = err instanceof Error ? err.message : String(err);
      sessionRunFailuresTotal.inc();
      this.pendingApprovals.delete(args.sessionId);
      this.clearApprovalSubscriptions(args.sessionId);
      await this.pool.evictSession(args.sessionId).catch(() => {
        /* best-effort */
      });
      this.sessions.endRunFailure(args.sessionId, msg);
      throw err;
    }
  }

  /**
   * Cancel a running session. Aborts the in-flight run via the gateway WS
   * control plane and clears any queued events for the session. Sets the
   * session back to idle (no error recorded — cancellation is a deliberate
   * stop, not an agent failure). Returns the updated Session.
   */
  /**
   * Trigger openclaw to compact the session's conversation log. Requires
   * an active container (session has been interacted with at least once —
   * otherwise there's nothing to compact). Does not race with a running
   * turn: we refuse if the session is in "running" state, since openclaw
   * can't compact while a turn is in flight.
   *
   * The compaction itself is openclaw's responsibility; it writes a
   * `compaction` JSONL entry which surfaces as a `session.compaction`
   * event in the subsequent events stream.
   */
  async compact(sessionId: string): Promise<Session> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new RouterError(
        "session_not_found",
        `session ${sessionId} does not exist`,
      );
    }
    if (session.status === "running") {
      throw new RouterError(
        "session_busy",
        `session ${sessionId} is running; wait for it to finish before compacting`,
      );
    }
    const wsClient = this.pool.getWsClient(sessionId);
    if (!wsClient) {
      throw new RouterError(
        "no_active_container",
        `session ${sessionId} has no active container to compact (post an event first)`,
      );
    }
    const canonicalKey = `agent:main:${sessionId}`;
    try {
      await wsClient.compact(canonicalKey);
    } catch (err) {
      throw wrapWsError(err, "compact_failed");
    }
    return session;
  }

  /**
   * Fetch a snapshot of the agent container's stdout+stderr. Useful for
   * debugging "my turn produced an empty output" cases — the container
   * logs reveal upstream provider errors (401, rate limit), tool-call
   * tracebacks, and gateway diagnostics that aren't surfaced through
   * the event stream.
   *
   * Requires an active container for this session. Returns 404-ish
   * (`no_active_container`) if the pool has no container for it.
   */
  async logs(sessionId: string, tail = 200): Promise<string> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new RouterError(
        "session_not_found",
        `session ${sessionId} does not exist`,
      );
    }
    const containerId = this.pool.getContainerId(sessionId);
    if (!containerId) {
      throw new RouterError(
        "no_active_container",
        `session ${sessionId} has no active container (post an event first)`,
      );
    }
    return this.pool.runtime.logs(containerId, { tail });
  }

  /**
   * List files in an agent's workspace at the given relative path (empty
   * = workspace root). Returns entries that live inside Pi's workspace
   * directory. Rejects path traversal.
   *
   * The "workspace" here is the host bind mount at `<stateRoot>/<agentId>/`
   * that openclaw uses as its `cwd` inside the container. Agents read/write
   * here when a session invokes file tools, so a developer debugging "what
   * did my agent produce" starts here.
   */
  async listFiles(
    agentId: string,
    sessionId: string,
    relPath = "",
  ): Promise<Array<{ name: string; path: string; type: "file" | "dir"; size: number; mtime: number }>> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new RouterError("agent_not_found", `agent ${agentId} does not exist`);
    }
    const { fullPath, relNormalized } = this.resolveWorkspacePath(agentId, sessionId, relPath);
    const { readdir, stat } = await import("node:fs/promises");
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(fullPath, { withFileTypes: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        throw new RouterError("file_not_found", `workspace path not found: ${relNormalized}`);
      }
      throw err;
    }
    const { join } = await import("node:path");
    const result: Array<{ name: string; path: string; type: "file" | "dir"; size: number; mtime: number }> = [];
    for (const e of entries) {
      try {
        const st = await stat(join(fullPath, e.name));
        result.push({
          name: e.name,
          path: relNormalized ? `${relNormalized}/${e.name}` : e.name,
          type: e.isDirectory() ? "dir" : "file",
          size: st.size,
          mtime: st.mtimeMs,
        });
      } catch {
        /* broken symlink or permission issue — skip it */
      }
    }
    result.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
    return result;
  }

  /**
   * Read a file from an agent's workspace. Returns a Buffer up to
   * `maxBytes` (default 10 MiB). Files larger than that get truncated
   * with the first N bytes — callers that need full content should GET
   * with the `?raw=true` query that reads up to 50 MiB. Binary-safe.
   */
  async readFile(agentId: string, sessionId: string, relPath: string, maxBytes = 10 * 1024 * 1024): Promise<Buffer> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new RouterError("agent_not_found", `agent ${agentId} does not exist`);
    }
    const { fullPath, relNormalized } = this.resolveWorkspacePath(agentId, sessionId, relPath);
    const { readFile, stat } = await import("node:fs/promises");
    try {
      const st = await stat(fullPath);
      if (!st.isFile()) {
        throw new RouterError("file_not_found", `not a file: ${relNormalized}`);
      }
      const buf = await readFile(fullPath);
      if (buf.length > maxBytes) return buf.subarray(0, maxBytes);
      return buf;
    } catch (err) {
      if (err instanceof RouterError) throw err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        throw new RouterError("file_not_found", `file not found: ${relNormalized}`);
      }
      throw err;
    }
  }

  /**
   * Write a file in an agent's workspace, creating parent directories as
   * needed. Overwrites existing files. `content` is written verbatim.
   * Does not race with concurrent tool calls — the container filesystem
   * is shared with whatever the agent is doing, so coordinate externally
   * if you're writing into an active workspace.
   */
  async writeFile(agentId: string, sessionId: string, relPath: string, content: Buffer): Promise<{ size: number; path: string }> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new RouterError("agent_not_found", `agent ${agentId} does not exist`);
    }
    const { fullPath, relNormalized } = this.resolveWorkspacePath(agentId, sessionId, relPath);
    if (!relNormalized) {
      throw new RouterError("invalid_path", `refusing to write to workspace root`);
    }
    const { writeFile, mkdir } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content);
    return { size: content.length, path: relNormalized };
  }

  /** Delete a file (not a directory) from an agent's workspace. */
  async deleteFile(agentId: string, sessionId: string, relPath: string): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new RouterError("agent_not_found", `agent ${agentId} does not exist`);
    }
    const { fullPath, relNormalized } = this.resolveWorkspacePath(agentId, sessionId, relPath);
    if (!relNormalized) {
      throw new RouterError("invalid_path", `refusing to delete workspace root`);
    }
    const { unlink } = await import("node:fs/promises");
    try {
      await unlink(fullPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        throw new RouterError("file_not_found", `file not found: ${relNormalized}`);
      }
      if (code === "EISDIR" || code === "EPERM") {
        throw new RouterError("invalid_path", `not a file: ${relNormalized}`);
      }
      throw err;
    }
  }

  private resolveWorkspacePath(
    agentId: string,
    sessionId: string,
    relPath: string,
  ): { fullPath: string; relNormalized: string } {
    // Normalize + enforce confinement in one place so every file API entry
    // point shares the same rules: strip leading slashes, collapse `..`,
    // reject anything whose resolved path escapes the agent workspace.
    const cleaned = (relPath || "")
      .replace(/^\/+/, "")
      .split(/[\\/]+/)
      .filter((seg) => seg !== "" && seg !== ".");
    for (const seg of cleaned) {
      if (seg === "..") {
        throw new RouterError("invalid_path", `path traversal not allowed`);
      }
      if (seg.includes("\0")) {
        throw new RouterError("invalid_path", `invalid character in path`);
      }
    }
    const relNormalized = cleaned.join("/");
    const workspaceRoot = this.events.stateRoot;
    const agentRoot = `${workspaceRoot}/${agentId}/sessions/${sessionId}`;
    const fullPath = relNormalized ? `${agentRoot}/${relNormalized}` : agentRoot;
    // Final belt-and-suspenders check — a realpath() resolve would follow
    // symlinks and verify confinement, but that requires the path to
    // already exist. For writes to a new file, realpath would fail.
    // Instead we rely on the segment-based `..` rejection above plus
    // ensuring the final path starts with the agent root prefix.
    if (!fullPath.startsWith(agentRoot)) {
      throw new RouterError("invalid_path", `path escapes workspace`);
    }
    return { fullPath, relNormalized };
  }

  /**
   * Merge vault credentials into an agent's MCP server config for a
   * specific session. Pure function over store reads — no side effects.
   *
   * For each HTTP MCP server (one with a `url`), match the server's URL
   * prefix against every credential's `matchUrl`. The longest matching
   * prefix wins (so more-specific credentials override more-general
   * ones). The credential's bearer token becomes
   * `Authorization: Bearer <token>` in the server's headers, preserving
   * any other headers the agent template declared.
   *
   * stdio MCP servers (those without a URL) are passed through
   * untouched — their credentials live in the server's `env` field,
   * which the agent template owner controls directly.
   */
  private injectVaultCredentials(
    agentMcpServers: AgentConfig["mcpServers"],
    vaultId: string | null,
  ): AgentConfig["mcpServers"] {
    if (!vaultId) return agentMcpServers;
    if (!agentMcpServers || Object.keys(agentMcpServers).length === 0) {
      return agentMcpServers;
    }
    const creds = this.vaults.listCredentials(vaultId);
    if (creds.length === 0) return agentMcpServers;
    const out: AgentConfig["mcpServers"] = {};
    for (const [name, server] of Object.entries(agentMcpServers)) {
      const url = typeof server.url === "string" ? server.url : undefined;
      if (!url) {
        out[name] = server;
        continue;
      }
      // Longest-prefix wins — lets operators declare a generic
      // org-wide credential plus narrower per-service overrides.
      const match = creds
        .filter((c) => url.startsWith(c.matchUrl))
        .sort((a, b) => b.matchUrl.length - a.matchUrl.length)[0];
      if (!match) {
        out[name] = server;
        continue;
      }
      const bearer = match.type === "mcp_oauth" ? match.accessToken : match.token;
      const existingHeaders = (server.headers ?? {}) as Record<string, string>;
      out[name] = {
        ...server,
        headers: {
          ...existingHeaders,
          Authorization: `Bearer ${bearer}`,
        },
      };
    }
    return out;
  }

  /**
   * Refresh any mcp_oauth credentials in the vault that are within the
   * `expiresAt - 60s` window before they're injected into a session.
   * Updates the stored credential in place (vaultStore.updateOAuthTokens)
   * so subsequent spawns use the fresh access token.
   *
   * Called exactly once per acquire (from executeInBackground and
   * streamEvent, before buildSpawnOptions). Failures throw
   * `credential_expired` — the caller surfaces a 401 so the developer's
   * app knows to re-run its OAuth flow for that end-user.
   *
   * Only refreshes credentials whose `matchUrl` is a prefix of at least
   * one MCP server URL on the agent. Prevents pointless refresh of
   * credentials that aren't about to be used.
   */
  private async refreshExpiringOAuthCredentials(
    agent: AgentConfig,
    vaultId: string | null,
  ): Promise<void> {
    if (!vaultId) return;
    if (!agent.mcpServers || Object.keys(agent.mcpServers).length === 0) return;
    const creds = this.vaults.listCredentials(vaultId);
    const oauthCreds = creds.filter(
      (c): c is VaultCredentialMcpOAuth => c.type === "mcp_oauth",
    );
    if (oauthCreds.length === 0) return;
    const serverUrls = Object.values(agent.mcpServers)
      .map((s) => (typeof s.url === "string" ? s.url : undefined))
      .filter((u): u is string => typeof u === "string");
    if (serverUrls.length === 0) return;
    const now = Date.now();
    const refreshThreshold = 60_000;
    for (const cred of oauthCreds) {
      const willBeUsed = serverUrls.some((u) => u.startsWith(cred.matchUrl));
      if (!willBeUsed) continue;
      if (cred.expiresAt - refreshThreshold > now) continue;
      try {
        const refreshed = await this.performOAuthRefresh(cred);
        this.vaults.updateOAuthTokens(cred.credentialId, refreshed);
        log.info(
          {
            credential_id: cred.credentialId,
            vault_id: vaultId,
            new_expires_at: refreshed.expiresAt,
          },
          "refreshed mcp_oauth credential",
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new RouterError(
          "credential_expired",
          `mcp_oauth credential ${cred.credentialId} refresh failed: ${msg}`,
        );
      }
    }
  }

  /**
   * RFC 6749 section 6: token refresh via `grant_type=refresh_token`.
   * Provider-agnostic — works for GitHub, Google, Notion, Asana, any
   * OAuth 2.0 server that honors the standard refresh grant.
   *
   * Some providers return a new refresh_token on every rotation (GitHub
   * does); we persist it when present. Some return only an
   * `access_token` + `expires_in`; we keep the old refresh token in that
   * case. Some providers use a non-standard response shape — add a
   * provider discriminator here if we hit one in practice.
   */
  private async performOAuthRefresh(
    cred: VaultCredentialMcpOAuth,
  ): Promise<{ accessToken: string; refreshToken?: string; expiresAt: number }> {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: cred.refreshToken,
      client_id: cred.clientId,
      client_secret: cred.clientSecret,
    });
    const res = await fetch(cred.tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`token endpoint returned HTTP ${res.status}: ${text.slice(0, 500)}`);
    }
    // GitHub historically returned application/x-www-form-urlencoded
    // on success; most other providers return JSON. Handle both.
    const contentType = res.headers.get("content-type") ?? "";
    let parsed: Record<string, unknown>;
    if (contentType.includes("application/json")) {
      parsed = (await res.json()) as Record<string, unknown>;
    } else {
      const text = await res.text();
      parsed = Object.fromEntries(new URLSearchParams(text).entries());
    }
    const accessToken = parsed.access_token;
    const refreshToken = parsed.refresh_token;
    const expiresIn = parsed.expires_in;
    if (typeof accessToken !== "string" || accessToken.length === 0) {
      throw new Error(`token endpoint response missing access_token`);
    }
    const expiresAt =
      typeof expiresIn === "number" || (typeof expiresIn === "string" && !Number.isNaN(Number(expiresIn)))
        ? Date.now() + Number(expiresIn) * 1000
        : Date.now() + 3600_000; // fallback: 1 hour
    return {
      accessToken,
      refreshToken: typeof refreshToken === "string" && refreshToken.length > 0 ? refreshToken : undefined,
      expiresAt,
    };
  }

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
      // Session is running but no container yet — still in the acquire
      // phase. Set a flag so executeInBackground aborts after acquire
      // returns, and transition the session to idle immediately so the
      // client isn't stuck.
      log.info({ session_id: sessionId }, "cancel during acquire phase — flagging");
      this.cancelledDuringAcquire.add(sessionId);
      this.queue.clear(sessionId);
      this.pendingApprovals.delete(sessionId);
      return this.sessions.endRunCancelled(sessionId) ?? session;
    }
    const canonicalKey = `agent:main:${sessionId}`;
    try {
      await wsClient.abort(canonicalKey);
    } catch (err) {
      throw wrapWsError(err, "cancel_failed");
    }
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
  ): Promise<void> {
    const wsClient = this.pool.getWsClient(sessionId);
    if (!wsClient) {
      throw new RouterError(
        "no_active_container",
        `session ${sessionId} has no live container for tool confirmation`,
      );
    }
    const wsDecision = decision === "allow" ? "allow-once" : "deny";
    try {
      await wsClient.approvalResolve(approvalId, wsDecision);
      this.removePendingApproval(sessionId, approvalId);
    } catch (err) {
      throw wrapWsError(err, "confirm_tool_failed");
    }
  }

  /**
   * Resolve the networking spec for a session from its bound environment.
   * Returns undefined when there's no environment, no networking config,
   * or when networking is "unrestricted" (the pool uses the default
   * single-network path in that case — no per-session confined topology
   * needs to spin up). When the environment is `networking: "limited"`,
   * returns the NetworkingSpec the pool's doLimitedSpawn path consumes.
   */
  private resolveNetworking(session: Session): NetworkingSpec | undefined {
    if (!session.environmentId) return undefined;
    const env = this.environments.get(session.environmentId);
    if (!env) return undefined;
    if (env.networking.type === "limited") {
      return {
        type: "limited",
        allowedHosts: env.networking.allowedHosts,
        allowMcpServers: env.networking.allowMcpServers,
        allowPackageManagers: env.networking.allowPackageManagers,
      };
    }
    return undefined;
  }

  /**
   * Warm-pool entries are keyed only by agent template. Any session whose
   * container boot depends on session-specific inputs must bypass warm
   * reuse and cold-spawn its own container.
   */
  private shouldBypassWarmPool(session: Session | undefined): boolean {
    if (!session) return false;
    if (session.vaultId) return true;
    if (this.resolveNetworking(session)?.type === "limited") return true;
    if (!session.environmentId) return false;
    const env = this.environments.get(session.environmentId);
    if (!env?.packages) return false;
    return Object.values(env.packages).some(
      (pkgs) => Array.isArray(pkgs) && pkgs.length > 0,
    );
  }

  private buildSpawnOptions(
    sessionId: string,
    agent: AgentConfig,
    session: Session,
  ): SpawnOptions {
    const hostMount: Mount = {
      hostPath: `${this.cfg.hostStateRoot}/${agent.agentId}/sessions/${sessionId}`,
      containerPath: "/workspace",
    };

    const inProcessWorkspace = join(this.events.stateRoot, agent.agentId, "sessions", sessionId);
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

    const runtimeModel = normalizeModelForRuntime(
      agent.model,
      this.cfg.passthroughEnv,
    );
    const env: Record<string, string> = {
      ...this.cfg.passthroughEnv,
      OPENCLAW_AGENT_ID: "main",
      OPENCLAW_MODEL: runtimeModel,
      OPENCLAW_TOOLS: agent.tools.join(","),
      OPENCLAW_INSTRUCTIONS: effectiveInstructions,
      OPENCLAW_STATE_DIR: "/workspace",
      OPENCLAW_GATEWAY_PORT: String(this.cfg.gatewayPort),
      OPENCLAW_ORCHESTRATOR_URL: this.cfg.orchestratorUrl,
      OPENCLAW_ORCHESTRATOR_TOKEN: parentToken,
    };
    // NOTE on thinkingLevel: openclaw's config schema rejects thinkingLevel
    // in both `agents.list[].thinkingLevel` and `agents.defaults.thinkingLevel`
    // paths — it's a *runtime* session field set via WS sessions.patch
    // (same channel model override takes). executeInBackground + streamEvent
    // patch it before every turn based on agent.thinkingLevel + per-event
    // override, so no env var is needed here.
    if (envConfig?.packages) {
      env.OPENCLAW_PACKAGES_JSON = JSON.stringify(envConfig.packages);
    }
    const effectiveMcpServers = this.injectVaultCredentials(
      agent.mcpServers,
      session.vaultId ?? null,
    );
    if (effectiveMcpServers && Object.keys(effectiveMcpServers).length > 0) {
      env.OPENCLAW_MCP_SERVERS_JSON = JSON.stringify(effectiveMcpServers);
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
    thinkingLevelOverride?: string,
  ): Promise<void> {
    const t0 = Date.now();
    const tick = (label: string, from: number) => ({ [label + "_ms"]: Date.now() - from });
    let cursor = t0;
    const currentSession = this.sessions.get(sessionId);
    await this.refreshExpiringOAuthCredentials(agent, currentSession?.vaultId ?? null);
    const timings: Record<string, number> = { ...tick("oauth_refresh", cursor) };
    cursor = Date.now();

    // Check credential freshness: if the session's vault credentials
    // were rotated since the container was last claimed, the container's
    // env vars carry stale tokens. Evict so the next acquire rebuilds
    // with fresh env. Only applies to sessions with vault bindings.
    if (currentSession?.vaultId) {
      this.evictIfCredentialsStale(sessionId, currentSession.vaultId);
    }

    const spawnOptions = this.buildSpawnOptions(
      sessionId,
      agent,
      currentSession ?? { remainingSubagentDepth: 0, environmentId: null } as Session,
    );
    Object.assign(timings, tick("build_spawn_options", cursor));
    cursor = Date.now();

    // Phase 1: Acquire container + WS patch. This phase is retryable
    // because Pi has NOT received the user message yet — all failures
    // here are infrastructure (spawn, /readyz, WS handshake). Pi writes
    // user.message to JSONL immediately on HTTP receipt, so once the
    // POST reaches the container, we must NOT retry (would duplicate
    // the user message in the session log).
    const container = await this.acquireWithRetry(
      sessionId, agent, spawnOptions, currentSession,
      modelOverride, thinkingLevelOverride, timings,
    );
    Object.assign(timings, tick("acquire_total", cursor));
    cursor = Date.now();

    // Check if cancel was requested while we were acquiring.
    if (this.cancelledDuringAcquire.has(sessionId)) {
      this.cancelledDuringAcquire.delete(sessionId);
      log.info({ session_id: sessionId }, "acquire completed but session was cancelled during it — aborting");
      return;
    }

    log.info(
      { session_id: sessionId, total_pre_llm_ms: cursor - t0, ...timings },
      "turn pre-LLM timings (receipt → chat.completions dispatch)",
    );
    const beforeTurn = this.snapshotTurnProgress(agent.agentId, sessionId);

    // Phase 2: Invoke chat completions. NOT retryable — Pi writes
    // user.message to JSONL immediately on HTTP receipt. Even connect-
    // level errors (ECONNRESET) can occur after the server received
    // the request body, so retrying would duplicate the user message.
    const runEnd = sessionRunDurationSeconds.startTimer();
    const completion = await this.invokeChatCompletions({
      baseUrl: container.baseUrl,
      token: container.token,
      content,
      sessionKey: sessionId,
    });
    runEnd();
    log.info(
      { session_id: sessionId, chat_completions_ms: Date.now() - cursor },
      "chat.completions returned",
    );

    // Item 9 — cost accounting. Pi's provider plugins compute the
    // authoritative per-turn cost from their catalogs (cache-aware: a
    // cacheRead-heavy turn pays the cache-read rate, not the normal
    // input rate) and write it to message.usage.cost.total in the JSONL.
    // PiJsonlEventReader already surfaces that as agent.message.costUsd,
    // so the orchestrator reads the single source of truth rather than
    // maintaining a separate static price sheet that would drift. If
    // the provider plugin does not report cost (for example, when the
    // pinned OpenClaw runtime is missing full catalog metadata for a
    // downstream model id), the recorded cost is 0 — not a rollup bug,
    // just the truth per the active catalog. Updating the runtime
    // provider catalog or our price-override injection layer will
    // propagate through this path with zero code changes.
    const latestAgent = this.assertTurnAdvanced(
      agent.agentId,
      sessionId,
      beforeTurn,
    );
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
      void this.executeInBackground(
        sessionId,
        agent,
        next.content,
        next.model,
        next.thinkingLevel,
      ).catch((err) => this.handleBackgroundFailure(sessionId, err));
      return;
    }

    this.pendingApprovals.delete(sessionId);
    this.sessions.endRunSuccess(sessionId, usage);
  }

  /**
   * Observer for a session that was adopted at orchestrator startup (the
   * container survived the restart, the session was still `running`).
   * Subscribes to the container's gateway `chat` broadcasts so we can
   * finalize the session when the in-flight turn completes server-side —
   * `state: "final"` → rollup + endRunSuccess + drain queue;
   * `state: "error"` → endRunFailure + evict. Also runs a JSONL
   * fast-path check: if the turn already completed between shutdown and
   * restart, the `chat` event is gone but a fresh `agent.message` is on
   * disk — we finalize immediately instead of waiting for an event that
   * will never come.
   *
   * Wired up from `src/index.ts` after a successful `pool.adopt` when
   * the adopted session was `running` at shutdown. No-op for sessions
   * that were already idle — those have no pending run to observe.
   *
   * Idempotent: the `finalized` guard + session-status check inside
   * `finalizeFromJsonl` ensure the JSONL fast-path and the WS callback
   * don't double-transition the session if they race.
   */
  async observeAdoptedSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== "running") return;
    const agent = this.agents.get(session.agentId);
    if (!agent) return;

    let finalized = false;
    let unsubscribe: (() => void) | undefined;
    const handleFinal = async (outcome: StreamOutcome): Promise<void> => {
      if (finalized) return;
      finalized = true;
      unsubscribe?.();
      await this.finalizeFromJsonl(sessionId, agent, outcome);
    };

    // Subscribe BEFORE the fast-path check so an event that fires during
    // the check still lands on us. `unsubscribe` guards against double-fire.
    const wsClient = this.pool.getWsClient(sessionId);
    if (wsClient) {
      if (agent.permissionPolicy.type === "always_ask") {
        await this.ensureApprovalSubscriptions(sessionId, wsClient);
      }
      const canonicalKey = `agent:main:${sessionId}`;
      unsubscribe = wsClient.onEvent("chat", (payload) => {
        const p = payload as
          | { sessionKey?: string; state?: string; errorMessage?: string }
          | undefined;
        if (!p || p.sessionKey !== canonicalKey) return;
        // State "delta" is per-token progress — not a completion signal.
        // We only care about terminal states.
        if (p.state === "final") {
          void handleFinal({ ok: true });
        } else if (p.state === "error") {
          void handleFinal({
            ok: false,
            error: p.errorMessage ?? "run failed (observed post-restart)",
          });
        }
      });
    } else {
      log.warn(
        { session_id: sessionId },
        "adopted session has no WS client — falling back to JSONL-only observation",
      );
    }

    // Fast path: turn may have completed while the orchestrator was down.
    // Compare the latest agent.message's createdAt to the session's
    // lastEventAt (which was set by beginRun before the crash). A newer
    // agent.message means Pi finished the turn without us watching.
    const latest = this.events.latestAgentMessage(agent.agentId, sessionId);
    const startedAt = session.lastEventAt ?? session.createdAt;
    if (latest && latest.createdAt > startedAt) {
      log.info(
        { session_id: sessionId },
        "adopted session's turn already completed during downtime — finalizing from JSONL",
      );
      await handleFinal({ ok: true });
    }
  }

  private async finalizeFromJsonl(
    sessionId: string,
    agent: AgentConfig,
    outcome: StreamOutcome,
  ): Promise<void> {
    // External-cancel guard: if another path already transitioned the
    // session out of running (e.g., a client posted a cancel during
    // startup), don't overwrite.
    const current = this.sessions.get(sessionId);
    if (current?.status !== "running") return;

    if (outcome.ok) {
      const latest = this.events.latestAgentMessage(agent.agentId, sessionId);
      const tokensIn = latest?.tokensIn ?? 0;
      const tokensOut = latest?.tokensOut ?? 0;
      const costUsd = latest?.costUsd ?? 0;
      this.pendingApprovals.delete(sessionId);
      this.sessions.endRunSuccess(sessionId, { tokensIn, tokensOut, costUsd });
      log.info(
        { session_id: sessionId, cost_usd: costUsd },
        "adopted session finalized",
      );
      // Now that the session is idle, drain any queued events the
      // previous process had committed to but not dispatched. One event
      // is enough — runEvent will chain the rest via the normal
      // queue-drain path.
      const next = this.queue.shift(sessionId);
      if (next) {
        void this.runEvent({
          sessionId,
          content: next.content,
          model: next.model,
          thinkingLevel: next.thinkingLevel,
        }).catch((err) => {
          log.warn(
            { err, session_id: sessionId },
            "post-adopt queue drain failed",
          );
        });
      }
      return;
    }
    sessionRunFailuresTotal.inc();
    log.error(
      { session_id: sessionId, error: outcome.error },
      "adopted session run failed post-restart",
    );
    this.queue.clear(sessionId);
    this.pendingApprovals.delete(sessionId);
    this.clearApprovalSubscriptions(sessionId);
    await this.pool.evictSession(sessionId).catch(() => {
      /* best-effort */
    });
    this.sessions.endRunFailure(sessionId, outcome.error);
  }

  private snapshotTurnProgress(
    agentId: string,
    sessionId: string,
  ): TurnProgressSnapshot {
    return {
      userTurns: this.events.countUserTurns(agentId, sessionId),
      latestAgentMessageId:
        this.events.latestAgentMessage(agentId, sessionId)?.eventId,
    };
  }

  private assertTurnAdvanced(
    agentId: string,
    sessionId: string,
    before: TurnProgressSnapshot,
  ): Event {
    const afterUserTurns = this.events.countUserTurns(agentId, sessionId);
    if (afterUserTurns <= before.userTurns) {
      throw new RouterError(
        "chat_completions_failed",
        "turn returned but no new user.message was written to JSONL",
      );
    }
    const latestAgent = this.events.latestAgentMessage(agentId, sessionId);
    if (!latestAgent || latestAgent.eventId === before.latestAgentMessageId) {
      throw new RouterError(
        "chat_completions_failed",
        "turn returned but no new agent.message was written to JSONL",
      );
    }
    return latestAgent;
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
    this.cancelledDuringAcquire.delete(sessionId);
    const current = this.sessions.get(sessionId);
    if (current?.status !== "running") {
      return;
    }
    // Drop any queued events and pending approvals.
    const dropped = this.queue.clear(sessionId);
    this.pendingApprovals.delete(sessionId);
    this.clearApprovalSubscriptions(sessionId);
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

  /**
   * Acquire a container and apply WS patch, with retry on infrastructure
   * failures. Retries are safe here because Pi has NOT received the HTTP
   * request yet — no user.message has been written to the JSONL.
   */
  private async acquireWithRetry(
    sessionId: string,
    agent: AgentConfig,
    spawnOptions: SpawnOptions,
    currentSession: Session | undefined,
    modelOverride: string | undefined,
    thinkingLevelOverride: string | undefined,
    timings: Record<string, number>,
  ): Promise<Container> {
    const MAX_INFRA_RETRIES = 2;
    let lastError: unknown;

    for (let attempt = 0; attempt < MAX_INFRA_RETRIES; attempt++) {
      try {
        const container = await this.pool.acquireForSession({
          sessionId,
          spawnOptions,
          agentId: agent.agentId,
          networking: currentSession ? this.resolveNetworking(currentSession) : undefined,
          bypassWarmPool: this.shouldBypassWarmPool(currentSession),
        });

        if (agent.permissionPolicy.type === "always_ask") {
          const wsClient = this.pool.getWsClient(sessionId);
          if (wsClient) {
            await this.ensureApprovalSubscriptions(sessionId, wsClient);
          }
        }

        const effectiveThinking = thinkingLevelOverride ?? agent.thinkingLevel;
        const needsPatch = Boolean(modelOverride) || effectiveThinking !== "off";
        // Pi creates the session key on the first HTTP POST. Before that,
        // sessions.patch can't find the key and times out (10s wasted).
        // Skip the patch on the first turn — Pi will use the model's
        // default thinking level. Subsequent turns have a key and patch
        // instantly.
        const isFirstTurn = currentSession ? currentSession.turns <= 1 : true;
        if (needsPatch && !isFirstTurn) {
          const wsClient = this.pool.getWsClient(sessionId);
          if (!wsClient) {
            throw new RouterError(
              "no_active_container",
              `session ${sessionId} has no WS client for patch`,
            );
          }
          const canonicalKey = `agent:main:${sessionId}`;
          const patch: Record<string, string> = {};
          if (modelOverride) {
            patch.model = normalizeModelForRuntime(
              modelOverride,
              this.cfg.passthroughEnv,
            );
          }
          if (effectiveThinking !== "off") patch.thinkingLevel = effectiveThinking;
          try {
            await wsClient.patch(canonicalKey, patch);
          } catch (patchErr) {
            log.warn(
              { session_id: sessionId, err: patchErr },
              "WS patch failed — proceeding without patch",
            );
          }
        }

        if (attempt > 0) {
          log.info(
            { session_id: sessionId, attempt },
            "container acquire succeeded on retry",
          );
        }
        return container;
      } catch (err) {
        lastError = err;
        await this.pool.evictSession(sessionId).catch(() => {});
        if (attempt < MAX_INFRA_RETRIES - 1) {
          log.warn(
            { session_id: sessionId, attempt, err },
            "container acquire failed — retrying after backoff",
          );
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }
      }
    }
    throw lastError;
  }

  /**
   * Evict the active container if the session's vault credentials have
   * been updated since the container was claimed. Docker env vars are
   * immutable post-create, so a rotated OAuth token requires a fresh
   * container with the new token in its env.
   */
  private evictIfCredentialsStale(sessionId: string, vaultId: string): void {
    const entry = this.pool.getActiveEntry(sessionId);
    if (!entry) return;
    const creds = this.vaults.listCredentials(vaultId);
    const containerClaimedAt = entry.spawnedAt;
    const hasStale = creds.some((c) => c.updatedAt > containerClaimedAt);
    if (hasStale) {
      log.info(
        { session_id: sessionId, vault_id: vaultId },
        "vault credentials rotated since container claim — evicting for fresh env",
      );
      void this.pool.evictSession(sessionId).catch(() => {});
    }
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

    // OpenClaw's OpenAI-compat endpoint returns HTTP 200 even when the
    // upstream provider errored — the failure surfaces as one of these
    // content shapes (see openclaw dist/openai-http / agent-runner.runtime):
    //   - empty string (assistant payloads filtered to nothing)
    //   - "No response from OpenClaw." sentinel
    //   - "⚠️ ..." user-facing fallback (auth / rate-limit / overload / context)
    // Accepting these as success silently corrupts the session — the run
    // looks idle with null error but the caller never got a real reply.
    // Raise here so handleBackgroundFailure / endRunFailure surface it
    // through HTTP like any other infrastructure failure.
    if (isOpenClawFailureContent(output)) {
      throw new RouterError(
        "chat_completions_failed",
        `upstream model call failed: ${output || "<empty reply>"}`,
      );
    }

    return {
      output,
      tokensIn: usage.prompt_tokens ?? 0,
      tokensOut: usage.completion_tokens ?? 0,
    };
  }
}

function isOpenClawFailureContent(content: string): boolean {
  if (content === "" || content.trim() === "") return true;
  if (content === "No response from OpenClaw.") return true;
  if (content.startsWith("⚠️")) return true;
  return false;
}

type ChatCompletionResponse = {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export type RouterErrorCode =
  | "agent_not_found"
  | "agent_archived"
  | "session_not_found"
  | "session_busy"
  | "session_not_running"
  | "no_active_container"
  | "chat_completions_failed"
  | "cancel_failed"
  | "compact_failed"
  | "patch_failed"
  | "confirm_tool_failed"
  | "quota_exceeded"
  | "file_not_found"
  | "invalid_path"
  | "vault_not_found"
  | "credential_expired";

export class RouterError extends Error {
  constructor(
    public readonly code: RouterErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RouterError";
  }
}

/**
 * Classify whether a fetch error is a connect-level failure (the TCP
 * connection never established or was reset before any HTTP response
 * headers arrived). These are safe to retry because Pi never received
 * the request — no user.message was written to the JSONL.
 */
function isConnectError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const cause = (err as { cause?: { code?: string } }).cause;
  if (cause?.code === "ECONNREFUSED") return true;
  if (cause?.code === "ECONNRESET") return true;
  if (cause?.code === "ENOTFOUND") return true;
  if (cause?.code === "ETIMEDOUT") return true;
  if (err.message.includes("fetch failed") && cause) return true;
  return false;
}

function wrapWsError(err: unknown, fallbackCode: RouterErrorCode): RouterError {
  if (err instanceof GatewayWsError) {
    return new RouterError(fallbackCode, `${err.code}: ${err.message}`);
  }
  const msg = err instanceof Error ? err.message : String(err);
  return new RouterError(fallbackCode, msg);
}
