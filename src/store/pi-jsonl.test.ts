import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Event } from "../orchestrator/types.js";
import { PiJsonlEventReader } from "./pi-jsonl.js";

// Pi's JSONL uses a canonical session-key scheme in sessions.json:
//   key = "agent:main:<our_session_id>"
//   value = { sessionId: "<pi_internal_session_id>", ... }
// The reader opens <stateRoot>/<agentId>/agents/main/sessions/<piSessionId>.jsonl
// and parses each line as one PiLine. These tests build a tiny but
// representative fixture tree and assert the event shapes we expose.

type Fixture = {
  root: string;
  agentId: string;
  sessionId: string;
  piSessionId: string;
};

function makeFixture(lines: Array<Record<string, unknown>> | undefined): Fixture {
  const root = mkdtempSync(join(tmpdir(), "pi-jsonl-test-"));
  const agentId = "agt_test";
  const sessionId = "ses_test";
  const piSessionId = "pi-0000";
  const sessionsDir = join(root, agentId, "sessions", sessionId, "agents", "main", "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(
    join(sessionsDir, "sessions.json"),
    JSON.stringify({
      [`agent:main:${sessionId}`]: { sessionId: piSessionId },
    }),
    "utf8",
  );
  if (lines) {
    const jsonl = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
    writeFileSync(join(sessionsDir, `${piSessionId}.jsonl`), jsonl, "utf8");
  }
  return { root, agentId, sessionId, piSessionId };
}

describe("PiJsonlEventReader", () => {
  let fixtures: Fixture[] = [];
  beforeEach(() => {
    fixtures = [];
  });
  afterEach(() => {
    for (const f of fixtures) rmSync(f.root, { recursive: true, force: true });
  });

  it("returns [] when sessions.json is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-jsonl-test-"));
    fixtures.push({ root, agentId: "x", sessionId: "y", piSessionId: "z" });
    const reader = new PiJsonlEventReader(root);
    expect(reader.listBySession("no-agent", "no-session")).toEqual([]);
    expect(reader.latestAgentMessage("no-agent", "no-session")).toBeUndefined();
    expect(reader.latestAgentOutcome("no-agent", "no-session")).toBeUndefined();
  });

  it("returns [] when the JSONL file is missing but sessions.json maps the key", () => {
    const f = makeFixture(undefined);
    fixtures.push(f);
    const reader = new PiJsonlEventReader(f.root);
    expect(reader.listBySession(f.agentId, f.sessionId)).toEqual([]);
  });

  it("parses user + assistant messages with usage and cost", () => {
    const f = makeFixture([
      {
        type: "message",
        id: "evt-1",
        timestamp: "2026-04-17T10:00:00.000Z",
        message: { role: "user", content: [{ type: "text", text: "hi" }] },
      },
      {
        type: "message",
        id: "evt-2",
        timestamp: "2026-04-17T10:00:01.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hello there" }],
          provider: "moonshot",
          model: "kimi-k2.5",
          usage: { input: 42, output: 7, cost: { total: 0.00012 } },
        },
      },
    ]);
    fixtures.push(f);
    const reader = new PiJsonlEventReader(f.root);
    const events = reader.listBySession(f.agentId, f.sessionId);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      eventId: "evt-1",
      type: "user.message",
      content: "hi",
    });
    expect(events[1]).toMatchObject({
      eventId: "evt-2",
      type: "agent.message",
      content: "hello there",
      tokensIn: 42,
      tokensOut: 7,
      costUsd: 0.00012,
      model: "moonshot/kimi-k2.5",
    });
  });

  it("normalizes OpenAI-family usage aliases from transcript entries", () => {
    const f = makeFixture([
      {
        type: "message",
        id: "evt-1",
        timestamp: "2026-04-24T12:00:00.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          provider: "zenmux",
          model: "openai/gpt-5.4",
          usage: {
            prompt_tokens: 321,
            completion_tokens: 45,
            cost: 0.0042,
          },
        },
      },
    ]);
    fixtures.push(f);
    const reader = new PiJsonlEventReader(f.root);
    const events = reader.listBySession(f.agentId, f.sessionId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "agent.message",
      tokensIn: 321,
      tokensOut: 45,
      costUsd: 0.0042,
      model: "zenmux/openai/gpt-5.4",
    });
  });

  it("parses assistant text from current OpenClaw message shapes", () => {
    const f = makeFixture([
      {
        type: "message",
        id: "evt-string-content",
        message: {
          role: "assistant",
          content: "string content",
        },
      },
      {
        type: "message",
        id: "evt-message-text",
        message: {
          role: "assistant",
          text: "message text",
        },
      },
      {
        type: "message",
        id: "evt-phased",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "commentary",
              textSignature: "{\"v\":1,\"phase\":\"commentary\"}",
            },
            {
              type: "text",
              text: "final answer",
              textSignature: "{\"v\":1,\"phase\":\"final_answer\"}",
            },
          ],
        },
      },
    ]);
    fixtures.push(f);
    const reader = new PiJsonlEventReader(f.root);
    const events = reader.listBySession(f.agentId, f.sessionId);
    expect(events.map((e) => e.content)).toEqual([
      "string content",
      "message text",
      "final answer",
    ]);
  });

  it("emits thinking blocks stored under the thinking field", () => {
    const f = makeFixture([
      {
        type: "message",
        id: "evt-thinking",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "working through it" },
            { type: "text", text: "done" },
          ],
        },
      },
    ]);
    fixtures.push(f);
    const reader = new PiJsonlEventReader(f.root);
    const events = reader.listBySession(f.agentId, f.sessionId);
    expect(events.map((e) => e.type)).toEqual(["agent.thinking", "agent.message"]);
    expect(events[0]).toMatchObject({
      eventId: "evt-thinking:thinking:0",
      content: "working through it",
    });
    expect(events[1]).toMatchObject({
      eventId: "evt-thinking",
      content: "done",
    });
  });

  it("normalizes camelCase usage aliases from transcript entries", () => {
    const f = makeFixture([
      {
        type: "message",
        id: "evt-1",
        timestamp: "2026-04-24T12:00:00.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          provider: "zenmux",
          model: "deepseek/deepseek-v4-pro",
          usage: {
            inputTokens: 222,
            outputTokens: 33,
            cost: { total: 0.0017 },
          },
        },
      },
    ]);
    fixtures.push(f);
    const reader = new PiJsonlEventReader(f.root);
    const events = reader.listBySession(f.agentId, f.sessionId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "agent.message",
      tokensIn: 222,
      tokensOut: 33,
      costUsd: 0.0017,
      model: "zenmux/deepseek/deepseek-v4-pro",
    });
  });

  describe("follow() resume cursor", () => {
    function threeEventFixture(): Fixture {
      return makeFixture([
        {
          type: "message",
          id: "evt-1",
          timestamp: "2026-04-17T10:00:00.000Z",
          message: { role: "user", content: [{ type: "text", text: "a" }] },
        },
        {
          type: "message",
          id: "evt-2",
          timestamp: "2026-04-17T10:00:01.000Z",
          message: { role: "assistant", content: [{ type: "text", text: "b" }] },
        },
        {
          type: "message",
          id: "evt-3",
          timestamp: "2026-04-17T10:00:02.000Z",
          message: { role: "user", content: [{ type: "text", text: "c" }] },
        },
      ]);
    }

    async function drain(gen: AsyncGenerator<Event>): Promise<Event[]> {
      const out: Event[] = [];
      for await (const e of gen) out.push(e);
      return out;
    }

    it("skips events up to and including the cursor", async () => {
      const f = threeEventFixture();
      fixtures.push(f);
      const reader = new PiJsonlEventReader(f.root);
      const events = await drain(
        reader.follow(f.agentId, f.sessionId, {
          afterEventId: "evt-2",
          isSessionRunning: () => false,
          idleTimeoutMs: 0,
          pollIntervalMs: 10,
        }),
      );
      expect(events.map((e) => e.eventId)).toEqual(["evt-3"]);
    });

    it("replays everything when the cursor isn't found (cursor stale / unknown)", async () => {
      const f = threeEventFixture();
      fixtures.push(f);
      const reader = new PiJsonlEventReader(f.root);
      const events = await drain(
        reader.follow(f.agentId, f.sessionId, {
          afterEventId: "evt-does-not-exist",
          isSessionRunning: () => false,
          idleTimeoutMs: 0,
          pollIntervalMs: 10,
        }),
      );
      // Losing client context is preferable to silently dropping events —
      // the reconnecting client will dedupe on its side via eventId.
      expect(events.map((e) => e.eventId)).toEqual(["evt-1", "evt-2", "evt-3"]);
    });
  });

  it("latestAgentMessage returns the newest agent.message (scans in reverse)", () => {
    const f = makeFixture([
      {
        type: "message",
        id: "evt-a",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "first" }],
        },
      },
      {
        type: "message",
        id: "evt-b",
        message: { role: "user", content: [{ type: "text", text: "q?" }] },
      },
      {
        type: "message",
        id: "evt-c",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "second" }],
        },
      },
    ]);
    fixtures.push(f);
    const reader = new PiJsonlEventReader(f.root);
    const latest = reader.latestAgentMessage(f.agentId, f.sessionId);
    expect(latest?.content).toBe("second");
    expect(latest?.eventId).toBe("evt-c");
  });

  it("latestAgentOutcome returns the newest agent.message or agent.tool_result", () => {
    const f = makeFixture([
      {
        type: "message",
        id: "evt-a",
        message: { role: "user", content: [{ type: "text", text: "what time is it?" }] },
      },
      {
        type: "message",
        id: "evt-b",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-date",
              name: "exec",
              arguments: { command: "date" },
            },
          ],
        },
      },
      {
        type: "message",
        id: "evt-c",
        message: {
          role: "toolResult",
          toolCallId: "call-date",
          toolName: "exec",
          content: [{ type: "text", text: "Fri Apr 24 17:58:01 UTC 2026" }],
        },
      },
    ]);
    fixtures.push(f);
    const reader = new PiJsonlEventReader(f.root);
    const latest = reader.latestAgentOutcome(f.agentId, f.sessionId);
    expect(latest?.type).toBe("agent.tool_result");
    expect(latest?.eventId).toBe("evt-c");
  });

  it("drops empty-content assistant messages (Pi auto-retry noise)", () => {
    const f = makeFixture([
      {
        type: "message",
        id: "evt-retry",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "" }],
          stopReason: "error",
          errorMessage: "transient",
        },
      },
      {
        type: "message",
        id: "evt-real",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "final answer" }],
        },
      },
    ]);
    fixtures.push(f);
    const reader = new PiJsonlEventReader(f.root);
    const events = reader.listBySession(f.agentId, f.sessionId);
    expect(events).toHaveLength(1);
    expect(events[0]?.eventId).toBe("evt-real");
  });

  it("emits tool_use events for toolCall content blocks", () => {
    const f = makeFixture([
      {
        type: "message",
        id: "evt-toolcall",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-123",
              name: "bash",
              arguments: { cmd: "ls" },
            },
          ],
        },
      },
      {
        type: "message",
        id: "evt-toolresult",
        message: {
          role: "toolResult",
          toolCallId: "call-123",
          toolName: "bash",
          content: [{ type: "text", text: "file1\nfile2\n" }],
        },
      },
    ]);
    fixtures.push(f);
    const reader = new PiJsonlEventReader(f.root);
    const events = reader.listBySession(f.agentId, f.sessionId);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: "agent.tool_use",
      toolName: "bash",
      toolCallId: "call-123",
      toolArguments: { cmd: "ls" },
    });
    expect(events[1]).toMatchObject({
      type: "agent.tool_result",
      toolName: "bash",
      toolCallId: "call-123",
      content: "file1\nfile2\n",
    });
  });

  it("surfaces session-level metadata events (model_change, thinking_level_change, compaction)", () => {
    const f = makeFixture([
      {
        type: "model_change",
        id: "evt-m",
        provider: "anthropic",
        modelId: "claude-sonnet-4-6",
      },
      { type: "thinking_level_change", id: "evt-t", thinkingLevel: "medium" },
      { type: "compaction", id: "evt-c", summary: "compacted turns 1-5" },
    ]);
    fixtures.push(f);
    const reader = new PiJsonlEventReader(f.root);
    const events = reader.listBySession(f.agentId, f.sessionId);
    expect(events.map((e) => e.type)).toEqual([
      "session.model_change",
      "session.thinking_level_change",
      "session.compaction",
    ]);
    expect(events[0]?.content).toBe("anthropic/claude-sonnet-4-6");
    expect(events[1]?.content).toBe("medium");
    expect(events[2]?.content).toBe("compacted turns 1-5");
  });

  it("reclassifies synthetic runtime notices so they do not count as user turns", () => {
    const f = makeFixture([
      {
        type: "message",
        id: "evt-notice",
        timestamp: "2026-04-24T11:26:04.000Z",
        message: {
          role: "user",
          content: [{
            type: "text",
            text:
              "System (untrusted): [2026-04-24 11:26:04 UTC] Exec failed (neat-bis, code 127) :: sh: 1: python3: not found An async command you ran earlier has completed. The result is shown in the system messages above. Handle the result internally. Do not relay it to the user unless explicitly requested.",
          }],
        },
      },
      {
        type: "message",
        id: "evt-user",
        timestamp: "2026-04-24T11:26:05.000Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "deploy it" }],
        },
      },
    ]);
    fixtures.push(f);
    const reader = new PiJsonlEventReader(f.root);
    const events = reader.listBySession(f.agentId, f.sessionId);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      eventId: "evt-notice",
      type: "session.runtime_notice",
    });
    expect(events[1]).toMatchObject({
      eventId: "evt-user",
      type: "user.message",
      content: "deploy it",
    });
    expect(reader.countUserTurns(f.agentId, f.sessionId)).toBe(1);
  });

  it("skips malformed JSONL lines instead of failing the whole read", () => {
    const f = makeFixture(undefined);
    fixtures.push(f);
    const sessionsDir = join(f.root, f.agentId, "sessions", f.sessionId, "agents", "main", "sessions");
    const mixed =
      JSON.stringify({
        type: "message",
        id: "evt-good",
        message: { role: "user", content: [{ type: "text", text: "hi" }] },
      }) +
      "\n{ this is not valid json \n" +
      JSON.stringify({
        type: "message",
        id: "evt-good-2",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
        },
      }) +
      "\n";
    writeFileSync(join(sessionsDir, `${f.piSessionId}.jsonl`), mixed, "utf8");
    const reader = new PiJsonlEventReader(f.root);
    const events = reader.listBySession(f.agentId, f.sessionId);
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.eventId)).toEqual(["evt-good", "evt-good-2"]);
  });

  it("deleteBySession removes the JSONL file AND the sessions.json entry", () => {
    const f = makeFixture([
      {
        type: "message",
        id: "evt-1",
        message: { role: "user", content: [{ type: "text", text: "hi" }] },
      },
    ]);
    fixtures.push(f);
    const reader = new PiJsonlEventReader(f.root);
    expect(reader.listBySession(f.agentId, f.sessionId)).toHaveLength(1);

    reader.deleteBySession(f.agentId, f.sessionId);

    expect(reader.listBySession(f.agentId, f.sessionId)).toHaveLength(0);
    const sessionsJson = JSON.parse(
      readFileSync(
        join(f.root, f.agentId, "sessions", f.sessionId, "agents", "main", "sessions", "sessions.json"),
        "utf8",
      ) as string,
    );
    expect(sessionsJson[`agent:main:${f.sessionId}`]).toBeUndefined();
  });

  it("deleteBySession is a no-op when the session is unknown", () => {
    const f = makeFixture(undefined);
    fixtures.push(f);
    const reader = new PiJsonlEventReader(f.root);
    expect(() => reader.deleteBySession("no-agent", "no-session")).not.toThrow();
  });
});
