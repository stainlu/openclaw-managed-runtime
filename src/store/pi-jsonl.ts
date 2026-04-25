import { accessSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Event } from "../orchestrator/types.js";

// Reads the per-session JSONL that OpenClaw's SessionManager writes for us.
// OpenClaw is the only writer — the orchestrator never appends anything to
// these files. All three pieces of information the HTTP API surfaces about a
// session's history (list, latest agent reply, delete) are derived by
// re-parsing this file.
//
// Path layout:
//   <stateRoot>/<agentId>/agents/main/sessions/sessions.json
//   <stateRoot>/<agentId>/agents/main/sessions/<piSessionId>.jsonl
//
// `stateRoot` is the IN-PROCESS path of the mounted directory — the
// orchestrator reads files via this path, not the host-side bind path that
// dockerode uses. docker-compose.yml keeps the two aligned.
//
// The mapping from our session_id (e.g. `ses_abc`) to the Pi session id
// (e.g. `8729f6c9-cd2c-...`) goes through sessions.json, keyed by the
// canonical session key form `agent:main:<session_id>` that Item 1 already
// uses on the wire. We intentionally re-read sessions.json on every call —
// it's small, it's local, and caching it just invites staleness bugs.

type PiContentBlock = {
  type: string;
  text?: string;
  thinking?: string;
  textSignature?: string;
  phase?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
};

type PiMessage = {
  role?: "user" | "assistant" | "toolResult";
  content?: PiContentBlock[] | string;
  text?: string;
  phase?: string;
  stopReason?: string;
  errorMessage?: string;
  usage?: {
    input?: number;
    output?: number;
    input_tokens?: number;
    output_tokens?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
    inputTokens?: number;
    outputTokens?: number;
    promptTokens?: number;
    completionTokens?: number;
    cost?: {
      total?: number;
    } | number;
  };
  model?: string;
  provider?: string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
};

type PiLine = {
  type: string;
  id?: string;
  timestamp?: string;
  message?: PiMessage;
  // model_change entry fields
  provider?: string;
  modelId?: string;
  // thinking_level_change entry fields
  thinkingLevel?: string;
  // compaction entry fields
  summary?: string;
  firstKeptEntryId?: string;
  tokensBefore?: number;
};

type SessionsJsonEntry = {
  sessionId?: string;
  [k: string]: unknown;
};

type SessionsJson = Record<string, SessionsJsonEntry>;

export class PiJsonlEventReader {
  constructor(public readonly stateRoot: string) {}

  listBySession(agentId: string, sessionId: string): Event[] {
    const piSessionId = this.resolvePiSessionId(agentId, sessionId);
    if (!piSessionId) return [];
    const filePath = this.jsonlPath(agentId, sessionId, piSessionId);
    let raw: string;
    try {
      raw = readFileSync(filePath, "utf8");
    } catch {
      return [];
    }
    const events: Event[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let parsed: PiLine;
      try {
        parsed = JSON.parse(line) as PiLine;
      } catch {
        // Skip malformed lines rather than failing the whole read — a
        // partial line at the tail of the file is possible if the writer
        // is in the middle of appending.
        continue;
      }
      for (const event of mapLineToEvents(parsed, sessionId)) {
        events.push(event);
      }
    }
    return events;
  }

  latestAgentMessage(agentId: string, sessionId: string): Event | undefined {
    const events = this.listBySession(agentId, sessionId);
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e && e.type === "agent.message") return e;
    }
    return undefined;
  }

  latestAgentOutcome(agentId: string, sessionId: string): Event | undefined {
    const events = this.listBySession(agentId, sessionId);
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (!e) continue;
      if (e.type === "agent.message" || e.type === "agent.tool_result") {
        return e;
      }
    }
    return undefined;
  }

  /**
   * Count "turns" = user.message events for this session. Used by the
   * orchestrator's session-list endpoint to expose a turns field on the
   * session-summary response so the UI can render "4 turns" etc. without
   * the client having to tail the entire event stream.
   *
   * Single-pass over the JSONL, no extra file I/O vs latestAgentMessage
   * (same listBySession call); callers that want both should read the
   * events array once and loop instead of hitting this twice.
   */
  countUserTurns(agentId: string, sessionId: string): number {
    const events = this.listBySession(agentId, sessionId);
    let n = 0;
    for (const e of events) if (e && e.type === "user.message") n++;
    return n;
  }

  /**
   * Return the on-disk byte size of the session's JSONL, or undefined
   * if the file doesn't exist yet (session hasn't written anything, or
   * container hasn't booted). Pure stat — no parsing, no read. Used by
   * the size sampler in src/index.ts to expose growth metrics and
   * warn operators about unbounded single-session logs (Pi's
   * compaction is a context-window concern, not a file-rotation one).
   */
  statJsonl(agentId: string, sessionId: string): { bytes: number } | undefined {
    const piSessionId = this.resolvePiSessionId(agentId, sessionId);
    if (!piSessionId) return undefined;
    try {
      const s = statSync(this.jsonlPath(agentId, sessionId, piSessionId));
      return { bytes: s.size };
    } catch {
      return undefined;
    }
  }

  deleteBySession(agentId: string, sessionId: string): void {
    const piSessionId = this.resolvePiSessionId(agentId, sessionId);
    if (!piSessionId) return;

    try {
      unlinkSync(this.jsonlPath(agentId, sessionId, piSessionId));
    } catch {
      // Already gone — fine.
    }

    // Remove the sessions.json entry so a future session with the same id
    // doesn't resolve back to the now-missing file.
    const key = canonicalKey(sessionId);
    const sessionsJsonPath = this.sessionsJsonPath(agentId, sessionId);
    try {
      const raw = readFileSync(sessionsJsonPath, "utf8");
      const parsed = JSON.parse(raw) as SessionsJson;
      if (key in parsed) {
        delete parsed[key];
        writeFileSync(sessionsJsonPath, JSON.stringify(parsed, null, 2), "utf8");
      }
    } catch {
      // sessions.json missing or unparseable — nothing left to clean.
    }
  }

  /**
   * Tail-follow the session's JSONL and yield each new Event as it appears.
   *
   * Phase 1 is a catch-up: every event already on disk is yielded in order.
   * Phase 2 polls the file at `pollIntervalMs` and emits any events whose
   * Pi id has not been seen yet. The generator terminates when:
   *   - the caller's AbortSignal fires (client disconnected), OR
   *   - `isSessionRunning()` returns false AND nothing new has been yielded
   *     for `idleTimeoutMs` — a grace period so clients can still stream
   *     across multiple turns without having to reconnect.
   *
   * When `afterEventId` is set, phase 1 skips every event up to and
   * including the one with that id. Used by the SSE resume path so a
   * reconnecting client doesn't re-receive events it already saw; the
   * event id is whatever the last successful `id: ...` SSE frame carried
   * (which, thanks to the browser's `EventSource`, comes back to us as
   * the `Last-Event-ID` request header on reconnect). If the id cannot be
   * found in the current catch-up (e.g. the client missed older events
   * AND the JSONL was truncated), we replay everything from the start —
   * safer to over-send than to silently drop history.
   *
   * Intentionally simple: each poll re-reads and re-parses the whole file
   * (sessions are a few KB in practice). A byte-offset tail is a
   * straightforward future optimization if this shows up on a profile.
   */
  async *follow(
    agentId: string,
    sessionId: string,
    opts: {
      signal?: AbortSignal;
      pollIntervalMs?: number;
      idleTimeoutMs?: number;
      isSessionRunning?: () => boolean;
      afterEventId?: string;
    } = {},
  ): AsyncGenerator<Event> {
    const pollMs = opts.pollIntervalMs ?? 100;
    const idleTimeoutMs = opts.idleTimeoutMs ?? 30_000;
    const seen = new Set<string>();

    // Phase 1: catch-up. When a resume cursor is supplied, skip every
    // event up to and including it. We pass 1 if the cursor id appears
    // in the file; if not, we replay everything (the cursor may be
    // stale / invalid — losing client context to safety beats losing
    // events to a wrong cursor).
    const catchUp = this.listBySession(agentId, sessionId);
    const afterId = opts.afterEventId;
    let cursorSeen = afterId === undefined;
    if (afterId !== undefined && !catchUp.some((e) => e.eventId === afterId)) {
      cursorSeen = true; // cursor not present → treat as no cursor
    }
    for (const e of catchUp) {
      if (opts.signal?.aborted) return;
      if (!cursorSeen) {
        if (e.eventId === afterId) cursorSeen = true;
        seen.add(e.eventId);
        continue;
      }
      seen.add(e.eventId);
      yield e;
    }

    // Phase 2: tail-follow.
    let lastYieldAt = Date.now();
    while (!opts.signal?.aborted) {
      try {
        await sleepWithAbort(pollMs, opts.signal);
      } catch {
        return; // signal fired
      }

      for (const e of this.listBySession(agentId, sessionId)) {
        if (opts.signal?.aborted) return;
        if (seen.has(e.eventId)) continue;
        seen.add(e.eventId);
        lastYieldAt = Date.now();
        yield e;
      }

      // Grace-period shutdown. Only trip when the caller supplied a busy
      // check AND the session is no longer running AND nothing new has
      // landed for idleTimeoutMs.
      if (
        opts.isSessionRunning !== undefined &&
        !opts.isSessionRunning() &&
        Date.now() - lastYieldAt > idleTimeoutMs
      ) {
        return;
      }
    }
  }

  private resolvePiSessionId(agentId: string, sessionId: string): string | undefined {
    const sessionsJsonPath = this.sessionsJsonPath(agentId, sessionId);
    let raw: string;
    try {
      raw = readFileSync(sessionsJsonPath, "utf8");
    } catch {
      return undefined;
    }
    let parsed: SessionsJson;
    try {
      parsed = JSON.parse(raw) as SessionsJson;
    } catch {
      return undefined;
    }
    const entry = parsed[canonicalKey(sessionId)];
    if (entry && typeof entry.sessionId === "string") {
      return entry.sessionId;
    }
    return undefined;
  }

  private sessionsDir(agentId: string, sessionId: string): string {
    // Per-session workspace path (post-migration). Falls back to the old
    // per-agent path for sessions created before the migration shipped.
    const perSession = join(this.stateRoot, agentId, "sessions", sessionId, "agents", "main", "sessions");
    try {
      accessSync(join(perSession, "sessions.json"));
      return perSession;
    } catch {
      // Pre-migration session: JSONL lives at the old per-agent path.
      return join(this.stateRoot, agentId, "agents", "main", "sessions");
    }
  }

  private sessionsJsonPath(agentId: string, sessionId: string): string {
    return join(this.sessionsDir(agentId, sessionId), "sessions.json");
  }

  private jsonlPath(agentId: string, sessionId: string, piSessionId: string): string {
    return join(this.sessionsDir(agentId, sessionId), `${piSessionId}.jsonl`);
  }
}

function canonicalKey(sessionId: string): string {
  return `agent:main:${sessionId}`;
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function mapLineToEvents(line: PiLine, sessionId: string): Event[] {
  const eventId = line.id ?? "";
  const createdAt = line.timestamp ? Date.parse(line.timestamp) : Date.now();

  // Non-message JSONL entry types: model changes, thinking level toggles,
  // compaction summaries. These are session-level metadata events, not
  // agent conversation turns.
  if (line.type === "model_change") {
    const model = combineModel(line.provider, line.modelId);
    if (!model) return [];
    return [{
      eventId,
      sessionId,
      type: "session.model_change",
      content: model,
      createdAt,
      model,
    }];
  }

  if (line.type === "thinking_level_change") {
    return [{
      eventId,
      sessionId,
      type: "session.thinking_level_change",
      content: line.thinkingLevel ?? "unknown",
      createdAt,
    }];
  }

  if (line.type === "compaction") {
    return [{
      eventId,
      sessionId,
      type: "session.compaction",
      content: line.summary ?? "(compacted)",
      createdAt,
    }];
  }

  if (line.type !== "message") return [];
  const msg = line.message;
  if (!msg) return [];

  if (msg.role === "user") {
    const text = extractText(msg.content);
    if (!text) return [];
    if (isRuntimeNotice(text)) {
      return [{
        eventId,
        sessionId,
        type: "session.runtime_notice",
        content: text,
        createdAt,
      }];
    }
    return [{
      eventId,
      sessionId,
      type: "user.message",
      content: text,
      createdAt,
    }];
  }

  if (msg.role === "assistant") {
    const events: Event[] = [];
    const text = extractAssistantText(msg);

    // Emit agent.thinking events for thinking content blocks.
    // These appear when a thinking-capable model (e.g. Claude with
    // extended thinking) is used with thinkingLevel != "off".
    const blocks = contentBlocks(msg.content);
    if (blocks.length > 0) {
      let thinkingIdx = 0;
      for (const block of blocks) {
        const thinking = extractThinkingBlockText(block);
        if (thinking) {
          events.push({
            eventId: `${eventId}:thinking:${String(thinkingIdx)}`,
            sessionId,
            type: "agent.thinking",
            content: thinking,
            createdAt,
          });
          thinkingIdx++;
        }
      }
    }

    // Emit agent.tool_use events for each toolCall content block.
    if (blocks.length > 0) {
      let toolIdx = 0;
      for (const block of blocks) {
        if (block.type === "toolCall" && block.name) {
          events.push({
            eventId: `${eventId}:tool:${block.id ?? String(toolIdx)}`,
            sessionId,
            type: "agent.tool_use",
            content: block.name,
            createdAt,
            toolName: block.name,
            toolCallId: block.id,
            toolArguments: block.arguments,
          });
          toolIdx++;
        }
      }
    }

    // Drop empty-content assistant messages (retries, errors) — but only
    // if there are also no tool calls. A message with ONLY tool calls and
    // no text is valid (stopReason=toolUse).
    if (text) {
      const usage = normalizeUsage(msg.usage);
      events.push({
        eventId,
        sessionId,
        type: "agent.message",
        content: text,
        createdAt,
        tokensIn: usage.tokensIn,
        tokensOut: usage.tokensOut,
        costUsd: usage.costUsd,
        model: combineModel(msg.provider, msg.model),
      });
    }

    return events;
  }

  if (msg.role === "toolResult") {
    const text = extractText(msg.content);
    return [{
      eventId,
      sessionId,
      type: "agent.tool_result",
      content: text || "(no output)",
      createdAt,
      toolName: msg.toolName,
      toolCallId: msg.toolCallId,
      isError: msg.isError,
    }];
  }

  return [];
}

function contentBlocks(content: PiMessage["content"] | undefined): PiContentBlock[] {
  return Array.isArray(content) ? content : [];
}

function extractText(content: PiMessage["content"] | undefined): string {
  if (typeof content === "string") return content;
  const blocks = contentBlocks(content);
  if (blocks.length === 0) return "";
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("");
}

function extractAssistantText(msg: PiMessage): string {
  const blocks = contentBlocks(msg.content);
  if (blocks.length > 0) {
    const finalAnswer = extractTextForPhase(blocks, "final_answer");
    if (finalAnswer.trim()) return finalAnswer;

    const unphased = extractTextForPhase(blocks, undefined);
    if (unphased.trim()) return unphased;

    // If the runtime gave us text blocks but every block is phase-tagged
    // with an unrecognized value, surface the raw visible text instead of
    // turning a completed provider response into an empty orchestrator event.
    const allText = extractText(msg.content);
    if (allText.trim()) return allText;
  }

  if (typeof msg.text === "string") return msg.text;
  if (typeof msg.content === "string") return msg.content;
  return "";
}

function extractTextForPhase(
  blocks: PiContentBlock[],
  requestedPhase: "final_answer" | undefined,
): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type !== "text" || typeof block.text !== "string") continue;
    const phase = resolveTextBlockPhase(block);
    if (requestedPhase === undefined) {
      if (phase === undefined) parts.push(block.text);
      continue;
    }
    if (phase === requestedPhase) parts.push(block.text);
  }
  return parts.join("");
}

function resolveTextBlockPhase(block: PiContentBlock): string | undefined {
  if (typeof block.phase === "string" && block.phase) return block.phase;
  if (typeof block.textSignature !== "string" || block.textSignature.trim() === "") {
    return undefined;
  }
  try {
    const parsed = JSON.parse(block.textSignature) as { phase?: unknown };
    return typeof parsed.phase === "string" && parsed.phase ? parsed.phase : undefined;
  } catch {
    return undefined;
  }
}

function extractThinkingBlockText(block: PiContentBlock): string {
  if (block.type !== "thinking") return "";
  if (typeof block.thinking === "string") return block.thinking;
  if (typeof block.text === "string") return block.text;
  return "";
}

function isRuntimeNotice(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  // OpenClaw sometimes persists internal operator/runtime notices into the
  // JSONL as synthetic role="user" text messages. These are not actual user
  // turns — they should not increment turns, satisfy "user.message written"
  // durability checks, or render in the UI as if the human typed them.
  //
  // Match conservatively on the stock notice forms we have observed in prod:
  //   System (untrusted): [...]
  //   System (trusted):   [...]
  // plus the async-command completion footer OpenClaw appends.
  if (
    /^System \((?:untrusted|trusted)\):/i.test(trimmed) ||
    trimmed.includes("An async command you ran earlier has completed.") ||
    trimmed.includes("Handle the result internally. Do not relay it to the user")
  ) {
    return true;
  }
  return false;
}

function normalizeUsage(usage: PiMessage["usage"] | undefined): {
  tokensIn: number | undefined;
  tokensOut: number | undefined;
  costUsd: number | undefined;
} {
  if (!usage) {
    return { tokensIn: undefined, tokensOut: undefined, costUsd: undefined };
  }
  const tokensIn =
    finiteNumber(usage.input) ??
    finiteNumber(usage.input_tokens) ??
    finiteNumber(usage.prompt_tokens) ??
    finiteNumber(usage.inputTokens) ??
    finiteNumber(usage.promptTokens);
  const tokensOut =
    finiteNumber(usage.output) ??
    finiteNumber(usage.output_tokens) ??
    finiteNumber(usage.completion_tokens) ??
    finiteNumber(usage.outputTokens) ??
    finiteNumber(usage.completionTokens);
  const costUsd =
    typeof usage.cost === "number"
      ? finiteNumber(usage.cost)
      : finiteNumber(usage.cost?.total);
  return { tokensIn, tokensOut, costUsd };
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function combineModel(
  provider: string | undefined,
  model: string | undefined,
): string | undefined {
  if (!model) return undefined;
  return provider ? `${provider}/${model}` : model;
}
