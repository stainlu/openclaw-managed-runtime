import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
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
};

type PiMessage = {
  role?: "user" | "assistant";
  content?: PiContentBlock[];
  stopReason?: string;
  errorMessage?: string;
  usage?: {
    input?: number;
    output?: number;
    cost?: {
      total?: number;
    };
  };
  model?: string;
  provider?: string;
};

type PiLine = {
  type: string;
  id?: string;
  timestamp?: string;
  message?: PiMessage;
};

type SessionsJsonEntry = {
  sessionId?: string;
  [k: string]: unknown;
};

type SessionsJson = Record<string, SessionsJsonEntry>;

export class PiJsonlEventReader {
  constructor(private readonly stateRoot: string) {}

  listBySession(agentId: string, sessionId: string): Event[] {
    const piSessionId = this.resolvePiSessionId(agentId, sessionId);
    if (!piSessionId) return [];
    const filePath = this.jsonlPath(agentId, piSessionId);
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
      const event = mapLineToEvent(parsed, sessionId);
      if (event) events.push(event);
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

  deleteBySession(agentId: string, sessionId: string): void {
    const piSessionId = this.resolvePiSessionId(agentId, sessionId);
    if (!piSessionId) return;

    try {
      unlinkSync(this.jsonlPath(agentId, piSessionId));
    } catch {
      // Already gone — fine.
    }

    // Remove the sessions.json entry so a future session with the same id
    // doesn't resolve back to the now-missing file.
    const key = canonicalKey(sessionId);
    const sessionsJsonPath = this.sessionsJsonPath(agentId);
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
    } = {},
  ): AsyncGenerator<Event> {
    const pollMs = opts.pollIntervalMs ?? 250;
    const idleTimeoutMs = opts.idleTimeoutMs ?? 30_000;
    const seen = new Set<string>();

    // Phase 1: catch-up.
    for (const e of this.listBySession(agentId, sessionId)) {
      if (opts.signal?.aborted) return;
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
    const sessionsJsonPath = this.sessionsJsonPath(agentId);
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

  private sessionsDir(agentId: string): string {
    return join(this.stateRoot, agentId, "agents", "main", "sessions");
  }

  private sessionsJsonPath(agentId: string): string {
    return join(this.sessionsDir(agentId), "sessions.json");
  }

  private jsonlPath(agentId: string, piSessionId: string): string {
    return join(this.sessionsDir(agentId), `${piSessionId}.jsonl`);
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

function mapLineToEvent(line: PiLine, sessionId: string): Event | undefined {
  // Pi writes a dozen record types (session, model_change, thinking_level,
  // custom, message, ...). Only `message` records map onto our Event model.
  // Everything else is skipped so the HTTP surface stays stable even as
  // Pi's internal schema grows.
  if (line.type !== "message") return undefined;
  const msg = line.message;
  if (!msg) return undefined;

  const eventId = line.id ?? "";
  const createdAt = line.timestamp ? Date.parse(line.timestamp) : Date.now();

  if (msg.role === "user") {
    const text = extractText(msg.content);
    if (!text) return undefined;
    return {
      eventId,
      sessionId,
      type: "user.message",
      content: text,
      createdAt,
    };
  }

  if (msg.role === "assistant") {
    const text = extractText(msg.content);

    // Drop every empty-content assistant message, whether it's a
    // mid-stream retry or a final error. Pi records each retry attempt
    // as its own line — if the turn ultimately succeeded, the next
    // assistant line with non-empty text is the one the caller wants,
    // and the intermediate errors are noise. If every retry failed,
    // Pi's SessionManager never produces a text line at all; the
    // orchestrator surfaces that outcome through session.error and
    // session.status=failed instead of as a per-event agent.error.
    //
    // Consequence: the count of emitted events stays equal to the
    // number of turns (one user + one agent per successful turn),
    // regardless of how many internal retries Pi needed to get there.
    if (!text) return undefined;

    return {
      eventId,
      sessionId,
      type: "agent.message",
      content: text,
      createdAt,
      tokensIn: msg.usage?.input,
      tokensOut: msg.usage?.output,
      costUsd: msg.usage?.cost?.total,
      model: combineModel(msg.provider, msg.model),
    };
  }

  return undefined;
}

function extractText(blocks: PiContentBlock[] | undefined): string {
  if (!blocks || blocks.length === 0) return "";
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("");
}

function combineModel(
  provider: string | undefined,
  model: string | undefined,
): string | undefined {
  if (!model) return undefined;
  return provider ? `${provider}/${model}` : model;
}
