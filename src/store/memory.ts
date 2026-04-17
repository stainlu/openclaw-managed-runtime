import { customAlphabet } from "nanoid";
import type {
  AgentConfig,
  CreateAgentRequest,
  CreateEnvironmentRequest,
  EnvironmentConfig,
  McpServers,
  PermissionPolicy,
  Session,
  UpdateAgentRequest,
} from "../orchestrator/types.js";
import type {
  AgentStore,
  AuditRecord,
  AuditStore,
  EnvironmentStore,
  QueuedEvent,
  QueueStore,
  RunUsage,
  SecretStore,
  SessionStore,
  Store,
} from "./types.js";

const nanoid = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 12);

// ---------- Agents ----------

class InMemoryAgentStore implements AgentStore {
  private readonly agents = new Map<string, AgentConfig>();
  private readonly versions = new Map<string, AgentConfig[]>();

  create(req: CreateAgentRequest): AgentConfig {
    const now = Date.now();
    const agent: AgentConfig = {
      agentId: `agt_${nanoid()}`,
      model: req.model,
      tools: req.tools,
      instructions: req.instructions,
      permissionPolicy: req.permissionPolicy,
      name: req.name,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      version: 1,
      callableAgents: req.callableAgents,
      maxSubagentDepth: req.maxSubagentDepth,
      mcpServers: req.mcpServers,
      quota: req.quota,
    };
    this.agents.set(agent.agentId, agent);
    this.versions.set(agent.agentId, [{ ...agent }]);
    return agent;
  }

  get(agentId: string): AgentConfig | undefined {
    return this.agents.get(agentId);
  }

  list(): AgentConfig[] {
    return Array.from(this.agents.values());
  }

  delete(agentId: string): boolean {
    this.versions.delete(agentId);
    return this.agents.delete(agentId);
  }

  update(agentId: string, req: UpdateAgentRequest): AgentConfig | undefined {
    const current = this.agents.get(agentId);
    if (!current || current.version !== req.version) return undefined;
    const now = Date.now();
    const updated: AgentConfig = {
      ...current,
      model: req.model ?? current.model,
      tools: req.tools === null ? [] : (req.tools ?? current.tools),
      instructions: req.instructions === null ? "" : (req.instructions ?? current.instructions),
      permissionPolicy: req.permissionPolicy ?? current.permissionPolicy,
      name: req.name === null ? undefined : (req.name ?? current.name),
      callableAgents: req.callableAgents === null ? [] : (req.callableAgents ?? current.callableAgents),
      maxSubagentDepth: req.maxSubagentDepth ?? current.maxSubagentDepth,
      mcpServers: req.mcpServers === null ? {} : (req.mcpServers ?? current.mcpServers),
      quota: req.quota === null ? undefined : (req.quota ?? current.quota),
      updatedAt: now,
      version: current.version + 1,
    };
    if (
      updated.model === current.model &&
      JSON.stringify(updated.tools) === JSON.stringify(current.tools) &&
      updated.instructions === current.instructions &&
      JSON.stringify(updated.permissionPolicy) === JSON.stringify(current.permissionPolicy) &&
      updated.name === current.name &&
      JSON.stringify(updated.callableAgents) === JSON.stringify(current.callableAgents) &&
      updated.maxSubagentDepth === current.maxSubagentDepth &&
      JSON.stringify(updated.mcpServers) === JSON.stringify(current.mcpServers) &&
      JSON.stringify(updated.quota) === JSON.stringify(current.quota)
    ) {
      return current;
    }
    this.agents.set(agentId, updated);
    const history = this.versions.get(agentId) ?? [];
    history.push({ ...updated });
    this.versions.set(agentId, history);
    return updated;
  }

  listVersions(agentId: string): AgentConfig[] {
    return this.versions.get(agentId) ?? [];
  }

  archive(agentId: string): AgentConfig | undefined {
    const current = this.agents.get(agentId);
    if (!current) return undefined;
    current.archivedAt = Date.now();
    current.updatedAt = Date.now();
    return current;
  }
}

// ---------- Environments ----------

class InMemoryEnvironmentStore implements EnvironmentStore {
  private readonly environments = new Map<string, EnvironmentConfig>();

  create(req: CreateEnvironmentRequest): EnvironmentConfig {
    const env: EnvironmentConfig = {
      environmentId: `env_${nanoid()}`,
      name: req.name,
      packages: req.packages ?? null,
      networking: req.networking,
      createdAt: Date.now(),
    };
    this.environments.set(env.environmentId, env);
    return env;
  }

  get(environmentId: string): EnvironmentConfig | undefined {
    return this.environments.get(environmentId);
  }

  list(): EnvironmentConfig[] {
    return Array.from(this.environments.values());
  }

  delete(environmentId: string): boolean {
    return this.environments.delete(environmentId);
  }
}

// ---------- Sessions ----------

class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, Session>();

  create(args: {
    agentId: string;
    sessionId?: string;
    environmentId?: string;
    ephemeral?: boolean;
    remainingSubagentDepth?: number;
  }): Session {
    const sessionId = args.sessionId ?? `ses_${nanoid()}`;
    const session: Session = {
      sessionId,
      agentId: args.agentId,
      environmentId: args.environmentId ?? null,
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

// ---------- Secrets ----------

class InMemorySecretStore implements SecretStore {
  private readonly bytes = new Map<string, Buffer>();

  get(key: string): Buffer | undefined {
    return this.bytes.get(key);
  }

  set(key: string, value: Buffer): void {
    this.bytes.set(key, Buffer.from(value));
  }
}

// ---------- Queue ----------

class InMemoryQueueStore implements QueueStore {
  private readonly bySession = new Map<string, QueuedEvent[]>();

  enqueue(sessionId: string, event: QueuedEvent): void {
    const existing = this.bySession.get(sessionId);
    if (existing) {
      existing.push(event);
    } else {
      this.bySession.set(sessionId, [event]);
    }
  }

  shift(sessionId: string): QueuedEvent | undefined {
    const queue = this.bySession.get(sessionId);
    if (!queue || queue.length === 0) return undefined;
    const next = queue.shift();
    if (queue.length === 0) this.bySession.delete(sessionId);
    return next;
  }

  size(sessionId: string): number {
    return this.bySession.get(sessionId)?.length ?? 0;
  }

  clear(sessionId: string): number {
    const dropped = this.bySession.get(sessionId)?.length ?? 0;
    this.bySession.delete(sessionId);
    return dropped;
  }

  listSessionsWithQueued(): string[] {
    return Array.from(this.bySession.keys()).sort();
  }
}

// ---------- Audit ----------

class InMemoryAuditStore implements AuditStore {
  private readonly events: AuditRecord[] = [];
  private nextId = 1;

  record(event: Omit<AuditRecord, "id">): void {
    this.events.push({ ...event, id: this.nextId++ });
  }

  list(filters: {
    since?: number;
    until?: number;
    action?: string;
    target?: string;
    limit?: number;
  }): AuditRecord[] {
    const limit = Math.min(Math.max(filters.limit ?? 100, 1), 1000);
    let out: AuditRecord[] = [];
    for (const e of this.events) {
      if (filters.since !== undefined && e.ts < filters.since) continue;
      if (filters.until !== undefined && e.ts > filters.until) continue;
      if (filters.action !== undefined) {
        if (filters.action.includes("%")) {
          // Naïve LIKE: convert %...% to a regex.
          const re = new RegExp(
            `^${filters.action.replace(/[.+*?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*")}$`,
          );
          if (!re.test(e.action)) continue;
        } else if (e.action !== filters.action) {
          continue;
        }
      }
      if (filters.target !== undefined && e.target !== filters.target) continue;
      out.push(e);
    }
    // Newest first, cap to limit.
    out = out.sort((a, b) => (b.ts - a.ts) || (b.id - a.id)).slice(0, limit);
    return out;
  }

  deleteOlderThan(ts: number): number {
    const before = this.events.length;
    let i = 0;
    while (i < this.events.length) {
      if (this.events[i]!.ts < ts) {
        this.events.splice(i, 1);
      } else {
        i++;
      }
    }
    return before - this.events.length;
  }
}

// ---------- Bundle ----------

export class InMemoryStore implements Store {
  readonly agents: AgentStore;
  readonly environments: EnvironmentStore;
  readonly sessions: SessionStore;
  readonly secrets: SecretStore;
  readonly queue: QueueStore;
  readonly audit: AuditStore;

  constructor() {
    this.agents = new InMemoryAgentStore();
    this.environments = new InMemoryEnvironmentStore();
    this.sessions = new InMemorySessionStore();
    this.secrets = new InMemorySecretStore();
    this.queue = new InMemoryQueueStore();
    this.audit = new InMemoryAuditStore();
  }

  close(): void {
    // no-op — nothing to release.
  }
}
