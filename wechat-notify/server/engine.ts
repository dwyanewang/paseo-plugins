import type { PluginHookAgent } from "@getpaseo/plugin/server";
import {
  BACKGROUND_RECHECK_MS,
  COMPLETE_THRESHOLD_MS,
  MERGE_WINDOW_MS,
  PERMISSION_DELAY_MS,
  WAKE_GRACE_MS,
} from "./constants";
import { firstErrorLine, formatMerged } from "./format";
import type {
  Clock,
  NotificationEngineDeps,
  NotificationRecord,
  PermissionEvent,
  RuntimeInspection,
  TurnEndedEvent,
} from "./types";

const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
  setInterval: (callback, delay) => setInterval(callback, delay),
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
};

interface AgentState {
  startedAt: number;
  generation: number;
  completionNotified: boolean;
  recheck?: unknown;
  grace?: unknown;
}

interface PermissionState {
  agentId: string;
  timer: unknown;
}

export class NotificationEngine {
  private readonly clock: Clock;
  private readonly agents = new Map<string, AgentState>();
  private readonly permissions = new Map<string, PermissionState>();
  private queued: NotificationRecord[] = [];
  private mergeTimer: unknown;

  constructor(private readonly deps: NotificationEngineDeps) {
    this.clock = deps.clock ?? realClock;
  }

  onTurnStarted(agent: PluginHookAgent): void {
    if (agent.parentAgentId) return;
    const current = this.agents.get(agent.id);
    if (current) {
      this.clearAgentTimers(current);
      current.generation += 1;
      current.completionNotified = false;
      return;
    }
    this.agents.set(agent.id, {
      startedAt: this.clock.now(),
      generation: 1,
      completionNotified: false,
    });
  }

  onTurnEnded(event: TurnEndedEvent): void {
    const { agent, outcome } = event;
    if (agent.parentAgentId) return;
    if (outcome.kind === "canceled") {
      this.clearAgent(agent.id);
      return;
    }
    const state = this.agents.get(agent.id) ?? {
      startedAt: this.clock.now(),
      generation: 1,
      completionNotified: false,
    };
    this.agents.set(agent.id, state);
    const durationMs = this.clock.now() - state.startedAt;
    if (outcome.kind === "failed") {
      this.clearAgentTimers(state);
      this.enqueue({
        kind: "failed",
        agentId: agent.id,
        workspaceId: agent.workspaceId,
        workspace: null,
        provider: agent.provider,
        durationMs,
        errorFirstLine: firstErrorLine(outcome.error.message),
      }, agent);
      return;
    }
    if (state.completionNotified || durationMs < COMPLETE_THRESHOLD_MS) return;
    const generation = state.generation;
    this.considerCompletion(agent, state, durationMs, generation).catch((error: unknown) => {
      this.deps.log?.("完成状态检查失败", {
        agentId: agent.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  onPermissionRequested(event: PermissionEvent): void {
    const { agent, request } = event;
    if (agent.parentAgentId) return;
    this.clearPermission(request.id);
    const timer = this.clock.setTimeout(() => {
      this.permissions.delete(request.id);
      this.inspect(agent)
        .then(({ workspace }) => {
          this.enqueue({
            kind: "permission",
            agentId: agent.id,
            workspaceId: agent.workspaceId,
            workspace,
            provider: agent.provider,
            toolName: request.name,
          }, agent);
        })
        .catch((error: unknown) => {
          this.deps.log?.("权限通知检查失败", {
            agentId: agent.id,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }, PERMISSION_DELAY_MS);
    this.permissions.set(request.id, { agentId: agent.id, timer });
  }

  onPermissionResolved(requestId: string): void {
    this.clearPermission(requestId);
  }

  clearAgent(agentId: string): void {
    const state = this.agents.get(agentId);
    if (state) this.clearAgentTimers(state);
    this.agents.delete(agentId);
    for (const [requestId, pending] of this.permissions) {
      if (pending.agentId === agentId) this.clearPermission(requestId);
    }
    this.queued = this.queued.filter((record) => record.agentId !== agentId);
    if (this.queued.length === 0 && this.mergeTimer !== undefined) {
      this.clock.clearTimeout(this.mergeTimer);
      this.mergeTimer = undefined;
    }
  }

  async flush(): Promise<void> {
    if (this.mergeTimer !== undefined) {
      this.clock.clearTimeout(this.mergeTimer);
      this.mergeTimer = undefined;
    }
    const records = this.queued;
    this.queued = [];
    if (records.length === 0) return;
    const message = formatMerged(records);
    try {
      await this.deps.sender.send(message);
    } catch (error) {
      this.deps.log?.("微信通知发送失败", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  dispose(): void {
    for (const state of this.agents.values()) this.clearAgentTimers(state);
    for (const requestId of this.permissions.keys()) this.clearPermission(requestId);
    if (this.mergeTimer !== undefined) this.clock.clearTimeout(this.mergeTimer);
    this.agents.clear();
    this.permissions.clear();
    this.queued = [];
  }

  private async considerCompletion(
    agent: PluginHookAgent,
    state: AgentState,
    durationMs: number,
    generation: number,
  ) {
    if (!this.isCurrent(agent.id, state, generation)) return;
    const inspection = await this.inspect(agent);
    if (!this.isCurrent(agent.id, state, generation)) return;
    if (hasBackgroundWork(agent, inspection)) {
      this.scheduleRecheck(agent, state, durationMs, generation);
      return;
    }
    this.enqueueCompletion(agent, state, inspection, durationMs);
  }

  private scheduleRecheck(agent: PluginHookAgent, state: AgentState, durationMs: number, generation: number): void {
    if (!this.isCurrent(agent.id, state, generation)) return;
    if (state.recheck !== undefined) return;
    const check = () => {
      const interval = state.recheck;
      if (interval !== undefined) {
        this.clock.clearInterval(interval);
        state.recheck = undefined;
      }
      if (!this.isCurrent(agent.id, state, generation)) return;
      this.inspect(agent)
        .then((inspection) => {
          if (!this.isCurrent(agent.id, state, generation)) return;
          if (hasBackgroundWork(agent, inspection)) {
            this.scheduleRecheck(agent, state, durationMs, generation);
            return;
          }
          state.grace = this.clock.setTimeout(() => {
            state.grace = undefined;
            if (!this.isCurrent(agent.id, state, generation)) return;
            this.inspect(agent)
              .then((latest) => {
                if (!this.isCurrent(agent.id, state, generation)) return;
                if (!hasBackgroundWork(agent, latest)) {
                  this.enqueueCompletion(agent, state, latest, this.clock.now() - state.startedAt);
                } else {
                  this.scheduleRecheck(agent, state, durationMs, generation);
                }
              })
              .catch((error: unknown) => this.deps.log?.("后台工作复查失败", { error: String(error) }));
          }, WAKE_GRACE_MS);
        })
        .catch((error: unknown) => {
          if (!this.isCurrent(agent.id, state, generation)) return;
          this.deps.log?.("后台工作复查失败", { error: String(error) });
          this.scheduleRecheck(agent, state, durationMs, generation);
        });
    };
    state.recheck = this.clock.setInterval(check, BACKGROUND_RECHECK_MS);
  }

  private isCurrent(agentId: string, state: AgentState, generation: number): boolean {
    return this.agents.get(agentId) === state && state.generation === generation && !state.completionNotified;
  }

  private enqueueCompletion(
    agent: PluginHookAgent,
    state: AgentState,
    inspection: RuntimeInspection,
    durationMs: number,
  ): void {
    state.completionNotified = true;
    this.clearAgentTimers(state);
    const runningRootCount = inspection.agents.filter(
      (entry) =>
        entry.workspaceId === agent.workspaceId &&
        entry.id !== agent.id &&
        entry.status === "running" &&
        !entry.labels?.["paseo.parent-agent-id"],
    ).length;
    this.enqueue({
      kind: "completed",
      agentId: agent.id,
      workspaceId: agent.workspaceId,
      workspace: inspection.workspace,
      provider: agent.provider,
      durationMs,
      runningRootCount,
    }, agent);
  }

  private enqueue(record: NotificationRecord, agent: PluginHookAgent): void {
    if (record.workspace === null) {
      void this.inspect(agent)
        .then(({ workspace }) => this.enqueue({ ...record, workspace }, agent))
        .catch((error: unknown) => this.deps.log?.("通知信息检查失败", { error: String(error) }));
      return;
    }
    this.queued.push(record);
    if (this.mergeTimer === undefined) {
      this.mergeTimer = this.clock.setTimeout(() => {
        this.mergeTimer = undefined;
        void this.flush();
      }, MERGE_WINDOW_MS);
    }
  }

  private inspect(agent: PluginHookAgent): Promise<RuntimeInspection> {
    return this.deps.inspect(agent);
  }

  private clearAgentTimers(state: AgentState): void {
    if (state.recheck !== undefined) this.clock.clearInterval(state.recheck);
    if (state.grace !== undefined) this.clock.clearTimeout(state.grace);
    state.recheck = undefined;
    state.grace = undefined;
  }

  private clearPermission(requestId: string): void {
    const state = this.permissions.get(requestId);
    if (!state) return;
    this.clock.clearTimeout(state.timer);
    this.permissions.delete(requestId);
  }
}

export function hasBackgroundWork(agent: PluginHookAgent, inspection: RuntimeInspection): boolean {
  const children = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of inspection.agents) {
      const parent = entry.labels?.["paseo.parent-agent-id"];
      if (parent && (parent === agent.id || children.has(parent)) && !children.has(entry.id)) {
        children.add(entry.id);
        changed = true;
      }
    }
  }
  if (inspection.agents.some((entry) => children.has(entry.id) && entry.status === "running")) return true;
  if (inspection.workspace?.status === "running") {
    return !inspection.agents.some(
      (entry) => entry.workspaceId === agent.workspaceId && entry.status === "running",
    );
  }
  return false;
}
