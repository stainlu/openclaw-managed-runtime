import { customAlphabet } from "nanoid";
import type {
  AgentConfig,
  CreateAgentRequest,
  Session,
} from "../orchestrator/types.js";
import type { AgentStore, RunUsage, SessionStore, Store } from "./types.js";

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
      callableAgents: req.callableAgents,
      maxSubagentDepth: req.maxSubagentDepth,
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

  create(args: {
    agentId: string;
    sessionId?: string;
    ephemeral?: boolean;
    remainingSubagentDepth?: number;
  }): Session {
    const sessionId = args.sessionId ?? `ses_${nanoid()}`;
    const session: Session = {
      sessionId,
      agentId: args.agentId,
      status: "idle",
      ephemeral: args.ephemeral ?? false,
      remainingSubagentDepth: args.remainingSubagentDepth ?? 0,
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

  endRunCancelled(sessionId: string): Session | undefined {
    const s = this.sessions.get(sessionId);
    if (!s) return undefined;
    s.status = "idle";
    s.error = null;
    s.lastEventAt = Date.now();
    return s;
  }

  addUsage(sessionId: string, usage: RunUsage): Session | undefined {
    const s = this.sessions.get(sessionId);
    if (!s) return undefined;
    s.tokensIn += usage.tokensIn;
    s.tokensOut += usage.tokensOut;
    s.costUsd += usage.costUsd;
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

// ---------- Bundle ----------

export class InMemoryStore implements Store {
  readonly agents: AgentStore;
  readonly sessions: SessionStore;

  constructor() {
    this.agents = new InMemoryAgentStore();
    this.sessions = new InMemorySessionStore();
  }

  close(): void {
    // no-op — nothing to release.
  }
}
