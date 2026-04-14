// In-memory per-session event queue.
//
// When a POST /v1/sessions/:id/events arrives while the session is already
// running AND the caller did not pass `interrupt: true`, the event is
// pushed onto this queue instead of returning 409. The router pops the
// queue from its background task on each successful run and feeds the
// next event back through the run pipeline. Session status stays
// "running" while the queue is non-empty.
//
// In-memory only — restart drops the queue, consistent with Item 3's
// rehydration semantics (sessions left "running" become "failed" on
// startup; queued events that hadn't been processed yet are gone with
// them). A persistent queue would require the router to atomically move
// a queued entry to "in-flight" and back, which is more complexity than
// the MVP needs.

export type QueuedEvent = {
  content: string;
  /** Per-event model override; passed to WS sessions.patch before the run. */
  model?: string;
  enqueuedAt: number;
};

export class SessionEventQueue {
  private readonly bySession = new Map<string, QueuedEvent[]>();

  enqueue(sessionId: string, event: QueuedEvent): void {
    const existing = this.bySession.get(sessionId);
    if (existing) {
      existing.push(event);
    } else {
      this.bySession.set(sessionId, [event]);
    }
  }

  /** Pop the head event for a session; returns undefined when empty. */
  shift(sessionId: string): QueuedEvent | undefined {
    const queue = this.bySession.get(sessionId);
    if (!queue || queue.length === 0) return undefined;
    const next = queue.shift();
    if (queue.length === 0) {
      this.bySession.delete(sessionId);
    }
    return next;
  }

  size(sessionId: string): number {
    return this.bySession.get(sessionId)?.length ?? 0;
  }

  /** Drop all queued events for a session. Returns the number dropped. */
  clear(sessionId: string): number {
    const dropped = this.bySession.get(sessionId)?.length ?? 0;
    this.bySession.delete(sessionId);
    return dropped;
  }
}
