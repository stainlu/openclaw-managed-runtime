import { customAlphabet } from "nanoid";
import type {
  AgentConfig,
  CreateAgentRequest,
  Event,
  Session,
} from "../orchestrator/types.js";
import type {
  AgentStore,
  AppendEventInput,
  EventStore,
  RunUsage,
  SessionStore,
  Store,
} from "./types.js";

const nanoid = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 12);

// ---------- Agents ----------

class InMemoryAgentStore implements AgentStore {
  private readonly agents = new Map<string, AgentConfig>();

  create(req: CreateAgentRequest): AgentConfig {
    const agent: AgentConfig = {
      agentId: `agt_${nanoid()}`,
      model: req.model,
      tools: req.tools,
      instructions: req.instructions,
      name: req.name,
      createdAt: Date.now(),
    };
    this.agents.set(agent.agentId, agent);
    return agent;
  }

  get(agentId: string): AgentConfig | undefined {
    return this.agents.get(agentId);
  }

  list(): AgentConfig[] {
    return Array.from(this.agents.values());
  }

  delete(agentId: string): boolean {
    return this.agents.delete(agentId);
  }
}

// ---------- Sessions ----------

class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, Session>();

  create(args: { agentId: string; sessionId?: string }): Session {
    const sessionId = args.sessionId ?? `ses_${nanoid()}`;
    const session: Session = {
      sessionId,
      agentId: args.agentId,
      status: "idle",
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      error: null,
      createdAt: Date.now(),
      lastEventAt: null,
    };
    this.sessions.set(sessionId, session);
    return session;
  }

  get(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  list(): Session[] {
    return Array.from(this.sessions.values());
  }

  delete(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  beginRun(sessionId: string): Session | undefined {
    const s = this.sessions.get(sessionId);
    if (!s) return undefined;
    s.status = "running";
    s.error = null;
    s.lastEventAt = Date.now();
    return s;
  }

  endRunSuccess(sessionId: string, usage: RunUsage): Session | undefined {
    const s = this.sessions.get(sessionId);
    if (!s) return undefined;
    s.status = "idle";
    s.tokensIn += usage.tokensIn;
    s.tokensOut += usage.tokensOut;
    s.costUsd += usage.costUsd;
    s.lastEventAt = Date.now();
    return s;
  }

  endRunFailure(sessionId: string, error: string): Session | undefined {
    const s = this.sessions.get(sessionId);
    if (!s) return undefined;
    s.status = "failed";
    s.error = error;
    s.lastEventAt = Date.now();
    return s;
  }

  failRunningSessions(reason: string): number {
    let count = 0;
    for (const s of this.sessions.values()) {
      if (s.status === "running") {
        s.status = "failed";
        s.error = reason;
        s.lastEventAt = Date.now();
        count++;
      }
    }
    return count;
  }
}

// ---------- Events ----------

class InMemoryEventStore implements EventStore {
  private readonly bySession = new Map<string, Event[]>();

  append(input: AppendEventInput): Event {
    const event: Event = {
      eventId: `evt_${nanoid()}`,
      sessionId: input.sessionId,
      type: input.type,
      content: input.content,
      createdAt: Date.now(),
      tokensIn: input.tokensIn,
      tokensOut: input.tokensOut,
      costUsd: input.costUsd,
      model: input.model,
    };
    const existing = this.bySession.get(input.sessionId) ?? [];
    existing.push(event);
    this.bySession.set(input.sessionId, existing);
    return event;
  }

  listBySession(sessionId: string): Event[] {
    return this.bySession.get(sessionId) ?? [];
  }

  latestAgentMessage(sessionId: string): Event | undefined {
    const events = this.bySession.get(sessionId);
    if (!events) return undefined;
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e && e.type === "agent.message") return e;
    }
    return undefined;
  }

  deleteBySession(sessionId: string): void {
    this.bySession.delete(sessionId);
  }
}

// ---------- Bundle ----------

export class InMemoryStore implements Store {
  readonly agents: AgentStore;
  readonly sessions: SessionStore;
  readonly events: EventStore;

  constructor() {
    this.agents = new InMemoryAgentStore();
    this.sessions = new InMemorySessionStore();
    this.events = new InMemoryEventStore();
  }

  close(): void {
    // no-op — nothing to release.
  }
}
