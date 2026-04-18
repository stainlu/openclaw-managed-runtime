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
import { GatewayWsError } from "../runtime/gateway-ws.js";
import type { ParentTokenMinter } from "../runtime/parent-token.js";
import type { SessionContainerPool } from "../runtime/pool.js";
import type { PiJsonlEventReader } from "../store/pi-jsonl.js";
import type {
  AgentStore,
  EnvironmentStore,
  QueueStore,
  RunUsage,
  SessionStore,
} from "../store/types.js";
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
    private readonly queue: QueueStore,
    private readonly cfg: RouterConfig,
  ) {}

  /** Return any pending approval requests for a session (non-destructive). */
  getPendingApprovals(sessionId: string): PendingApproval[] {
    return this.pendingApprovals.get(sessionId) ?? [];
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
    // Delegate to warmForAgent so the shared per-agent dedup map in the
    // pool prevents a parallel spawn against the same agent-workspace
    // bind mount. The previous implementation spawned a session-scoped
    // container here that could collide with the warmForAgent triggered
    // on agent-create, causing one of them to exit(1) under Pi's
    // SessionManager lock. Sessions for delegating agents (subagent
    // tokens baked into env) skip warm pool entirely via warmForAgent's
    // own guard, so the first POST /events on those sessions still
    // cold-spawns on demand.
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

    // Quotas are checked BEFORE the busy-session queue path: we refuse
    // to even enqueue a run for a session that's already out of budget.
    this.assertQuota(session, agent);

    if (session.status === "running") {
      // Queue path: the current background task will pop this on completion.
      this.queue.enqueue(args.sessionId, {
        content: args.content,
        model: args.model,
        thinkingLevel: args.thinkingLevel,
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
    addContext({ sessionId: args.sessionId, agentId: agent.agentId });

    try {
      const spawnOptions = this.buildSpawnOptions(args.sessionId, agent, running);
      const networking = this.resolveNetworking(running);
      const container = await this.pool.acquireForSession({
        sessionId: args.sessionId,
        spawnOptions,
        agentId: agent.agentId,
        networking,
      });

      // Same patch rules as executeInBackground — see the note there.
      const effectiveThinking = args.thinkingLevel ?? agent.thinkingLevel;
      if (args.model || effectiveThinking !== "off") {
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
        } catch (err) {
          throw wrapWsError(err, "patch_failed");
        }
      }

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
          const latest = router.events.latestAgentMessage(agent.agentId, args.sessionId);
          const tokensIn = latest?.tokensIn ?? 0;
          const tokensOut = latest?.tokensOut ?? 0;
          const costUsd = latest?.costUsd ?? 0;
          router.sessions.endRunSuccess(args.sessionId, { tokensIn, tokensOut, costUsd });
          return;
        }
        sessionRunFailuresTotal.inc();
        log.error(
          { session_id: args.sessionId, error: outcome.error },
          "streaming run failed",
        );
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
    relPath = "",
  ): Promise<Array<{ name: string; path: string; type: "file" | "dir"; size: number; mtime: number }>> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new RouterError("agent_not_found", `agent ${agentId} does not exist`);
    }
    const { fullPath, relNormalized } = this.resolveWorkspacePath(agentId, relPath);
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
  async readFile(agentId: string, relPath: string, maxBytes = 10 * 1024 * 1024): Promise<Buffer> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new RouterError("agent_not_found", `agent ${agentId} does not exist`);
    }
    const { fullPath, relNormalized } = this.resolveWorkspacePath(agentId, relPath);
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
  async writeFile(agentId: string, relPath: string, content: Buffer): Promise<{ size: number; path: string }> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new RouterError("agent_not_found", `agent ${agentId} does not exist`);
    }
    const { fullPath, relNormalized } = this.resolveWorkspacePath(agentId, relPath);
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
  async deleteFile(agentId: string, relPath: string): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new RouterError("agent_not_found", `agent ${agentId} does not exist`);
    }
    const { fullPath, relNormalized } = this.resolveWorkspacePath(agentId, relPath);
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
    // join() ONLY on the in-process mount to get the concrete FS path.
    const agentRoot = `${workspaceRoot}/${agentId}`;
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
      };
    }
    return undefined;
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
    // NOTE on thinkingLevel: openclaw's config schema rejects thinkingLevel
    // in both `agents.list[].thinkingLevel` and `agents.defaults.thinkingLevel`
    // paths — it's a *runtime* session field set via WS sessions.patch
    // (same channel model override takes). executeInBackground + streamEvent
    // patch it before every turn based on agent.thinkingLevel + per-event
    // override, so no env var is needed here.
    if (envConfig?.packages) {
      env.OPENCLAW_PACKAGES_JSON = JSON.stringify(envConfig.packages);
    }
    if (agent.mcpServers && Object.keys(agent.mcpServers).length > 0) {
      env.OPENCLAW_MCP_SERVERS_JSON = JSON.stringify(agent.mcpServers);
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
      networking: currentSession ? this.resolveNetworking(currentSession) : undefined,
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

    // Model + thinking-level patch via WS BEFORE the chat completions
    // call. The WS handshake completed during acquire so a client must be
    // present here; if it's missing, treat as an infrastructure failure
    // and evict.
    //
    // thinkingLevel: effective level is (per-event override) ?? (agent
    // default). We always re-patch when the effective level !== "off" —
    // this makes the runtime idempotent in the face of warm-pool
    // container reuse (a container claimed from a different agent could
    // carry the prior agent's level otherwise).
    //
    // model: session-scoped under Pi's setModel; only patched when the
    // per-event override is explicit, to avoid redundant per-turn patches
    // on the same agent.
    const effectiveThinking = thinkingLevelOverride ?? agent.thinkingLevel;
    const needsPatch = Boolean(modelOverride) || effectiveThinking !== "off";
    if (needsPatch) {
      const wsClient = this.pool.getWsClient(sessionId);
      if (!wsClient) {
        await this.pool.evictSession(sessionId).catch(() => {
          /* best-effort */
        });
        throw new RouterError(
          "no_active_container",
          `session ${sessionId} has no WS client for patch`,
        );
      }
      const canonicalKey = `agent:main:${sessionId}`;
      const patch: Record<string, string> = {};
      if (modelOverride) patch.model = modelOverride;
      if (effectiveThinking !== "off") patch.thinkingLevel = effectiveThinking;
      try {
        await wsClient.patch(canonicalKey, patch);
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
      void this.executeInBackground(
        sessionId,
        agent,
        next.content,
        next.model,
        next.thinkingLevel,
      ).catch((err) => this.handleBackgroundFailure(sessionId, err));
      return;
    }

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
    await this.pool.evictSession(sessionId).catch(() => {
      /* best-effort */
    });
    this.sessions.endRunFailure(sessionId, outcome.error);
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
  | "invalid_path";

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
