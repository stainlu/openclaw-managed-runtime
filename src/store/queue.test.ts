import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryStore } from "./memory.js";
import { SqliteStore } from "./sqlite.js";
import type { QueueStore } from "./types.js";

// Shared behavior suite — both backends must honor FIFO, per-session
// isolation, and idempotent clear. Durability is asserted by the
// SQLite-only block below.

function sharedQueueSuite(label: string, build: () => QueueStore) {
  describe(`${label} — shared semantics`, () => {
    it("starts empty and shift returns undefined", () => {
      const q = build();
      expect(q.size("ses_x")).toBe(0);
      expect(q.shift("ses_x")).toBeUndefined();
    });

    it("enqueues and shifts in FIFO order", () => {
      const q = build();
      q.enqueue("ses_x", { content: "a", enqueuedAt: 1 });
      q.enqueue("ses_x", { content: "b", enqueuedAt: 2 });
      q.enqueue("ses_x", { content: "c", enqueuedAt: 3 });
      expect(q.size("ses_x")).toBe(3);
      expect(q.shift("ses_x")?.content).toBe("a");
      expect(q.shift("ses_x")?.content).toBe("b");
      expect(q.shift("ses_x")?.content).toBe("c");
      expect(q.shift("ses_x")).toBeUndefined();
      expect(q.size("ses_x")).toBe(0);
    });

    it("isolates queues across sessions", () => {
      const q = build();
      q.enqueue("ses_a", { content: "alpha", enqueuedAt: 1 });
      q.enqueue("ses_b", { content: "bravo", enqueuedAt: 2 });
      q.enqueue("ses_a", { content: "alpha-2", enqueuedAt: 3 });
      expect(q.size("ses_a")).toBe(2);
      expect(q.size("ses_b")).toBe(1);
      expect(q.shift("ses_a")?.content).toBe("alpha");
      expect(q.shift("ses_b")?.content).toBe("bravo");
      expect(q.shift("ses_b")).toBeUndefined();
      expect(q.size("ses_a")).toBe(1);
    });

    it("clear returns the dropped count", () => {
      const q = build();
      q.enqueue("ses_x", { content: "a", enqueuedAt: 1 });
      q.enqueue("ses_x", { content: "b", enqueuedAt: 2 });
      expect(q.clear("ses_x")).toBe(2);
      expect(q.size("ses_x")).toBe(0);
    });

    it("preserves the optional model override round-trip", () => {
      const q = build();
      q.enqueue("ses_x", {
        content: "override-me",
        model: "anthropic/claude-sonnet-4-6",
        enqueuedAt: 42,
      });
      const out = q.shift("ses_x");
      expect(out?.content).toBe("override-me");
      expect(out?.model).toBe("anthropic/claude-sonnet-4-6");
      expect(out?.enqueuedAt).toBe(42);
    });

    it("listSessionsWithQueued reports sessions with non-empty queues only", () => {
      const q = build();
      expect(q.listSessionsWithQueued()).toEqual([]);
      q.enqueue("ses_a", { content: "x", enqueuedAt: 1 });
      q.enqueue("ses_b", { content: "y", enqueuedAt: 2 });
      expect(q.listSessionsWithQueued().sort()).toEqual(["ses_a", "ses_b"]);
      q.shift("ses_a");
      expect(q.listSessionsWithQueued()).toEqual(["ses_b"]);
      q.clear("ses_b");
      expect(q.listSessionsWithQueued()).toEqual([]);
    });
  });
}

sharedQueueSuite("InMemoryQueueStore", () => new InMemoryStore().queue);

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "queue-store-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

sharedQueueSuite("SqliteQueueStore", () => {
  const path = join(tmpDir, "shared.db");
  return new SqliteStore(path).queue;
});

describe("SqliteQueueStore — durability", () => {
  it("round-trips queued events across a store close+reopen", () => {
    const path = join(tmpDir, "durable.db");
    const first = new SqliteStore(path);
    first.queue.enqueue("ses_restart", {
      content: "survive me",
      model: "moonshot/kimi-k2.5",
      enqueuedAt: 1234,
    });
    first.queue.enqueue("ses_restart", { content: "me too", enqueuedAt: 1235 });
    first.close();

    // This mirrors the real restart path: a fresh orchestrator process
    // opens the same SQLite file and finds the events waiting. The
    // durability guarantee is what lets src/index.ts drain committed work
    // on startup instead of silently dropping accepted POSTs.
    const second = new SqliteStore(path);
    expect(second.queue.listSessionsWithQueued()).toEqual(["ses_restart"]);
    expect(second.queue.size("ses_restart")).toBe(2);

    const first_ = second.queue.shift("ses_restart");
    expect(first_?.content).toBe("survive me");
    expect(first_?.model).toBe("moonshot/kimi-k2.5");
    expect(first_?.enqueuedAt).toBe(1234);

    const second_ = second.queue.shift("ses_restart");
    expect(second_?.content).toBe("me too");
    expect(second_?.model).toBeUndefined();

    expect(second.queue.shift("ses_restart")).toBeUndefined();
    second.close();
  });
});

describe("SqliteSecretStore — durability", () => {
  it("survives close+reopen so ParentTokenMinter keeps its secret", () => {
    const path = join(tmpDir, "secrets.db");
    const first = new SqliteStore(path);
    first.secrets.set("parent_token_hmac_secret", Buffer.from("super-secret-bytes"));
    first.close();

    const second = new SqliteStore(path);
    const restored = second.secrets.get("parent_token_hmac_secret");
    expect(restored?.toString("utf8")).toBe("super-secret-bytes");
    second.close();
  });

  it("overwrites on set (rotation semantics)", () => {
    const store = new SqliteStore(join(tmpDir, "rotate.db"));
    store.secrets.set("k", Buffer.from("first"));
    store.secrets.set("k", Buffer.from("second"));
    expect(store.secrets.get("k")?.toString("utf8")).toBe("second");
    store.close();
  });
});
