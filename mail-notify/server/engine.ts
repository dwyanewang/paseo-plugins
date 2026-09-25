import type { PluginHookAgent } from "@getpaseo/plugin/server";
import {
  BACKGROUND_RECHECK_MS,
  MERGE_WINDOW_MS,
  NUDGE_DEBOUNCE_MS,
  PERMISSION_DELAY_MS,
  WAKE_GRACE_MS,
} from "./constants";
import { describeError, describePermission, describeTurn, type TurnDetail } from "./details";
import { firstErrorLine, formatBody, formatMerged, formatSubject } from "./format";
import { renderHtml } from "./html";
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
  /** Null when the turn started before this plugin was loaded, so its duration is unknown. */
  startedAt: number | null;
  generation: number;
  completionNotified: boolean;
  /** Snapshot of the finished turn, taken at turn end so later rechecks report the same turn. */
  turn?: TurnDetail;
  recheck?: unknown;
  /** The pending background-work check, callable early when a live update arrives. */
  check?: () => void;
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
  private nudgeTimer: unknown;
  private recheckMs = BACKGROUND_RECHECK_MS;

  constructor(private readonly deps: NotificationEngineDeps) {
    this.clock = deps.clock ?? realClock;
  }

  /** Live updates now drive background waits; the interval becomes a slower safety net. */
  setRecheckInterval(recheckMs: number): void {
    this.recheckMs = recheckMs;
  }

  /**
   * An agent or workspace changed somewhere. Agents waiting on background work recheck now
   * instead of at their next interval; a burst of updates collapses into one check.
   */
  nudge(): void {
    if (this.nudgeTimer !== undefined) return;
    if (![...this.agents.values()].some((state) => state.check)) return;
    this.nudgeTimer = this.clock.setTimeout(() => {
      this.nudgeTimer = undefined;
      for (const state of this.agents.values()) state.check?.();
    }, NUDGE_DEBOUNCE_MS);
  }

  onTurnStarted(agent: PluginHookAgent): void {
    if (agent.parentAgentId) return;
    const current = this.agents.get(agent.id);
    if (current) {
      // A turn that starts while the last one still waits on background work is the agent waking
      // to handle those results, so the task's duration keeps running; any other turn starts anew.
      const waking = current.recheck !== undefined || current.grace !== undefined;
      this.clearAgentTimers(current);
      current.generation += 1;
      current.completionNotified = false;
      if (!waking) current.startedAt = this.clock.now();
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
      startedAt: null,
      generation: 1,
      completionNotified: false,
    };
    this.agents.set(agent.id, state);
    const durationMs = this.durationOf(state);
    const turn = event.timeline ? describeTurn(event.timeline) : undefined;
    if (outcome.kind === "failed") {
      this.clearAgentTimers(state);
      this.enqueue({
        kind: "failed",
        agentId: agent.id,
        workspaceId: agent.workspaceId,
        workspace: null,
        provider: agent.provider,
        ...(durationMs !== undefined ? { durationMs } : {}),
        errorFirstLine: firstErrorLine(outcome.error.message),
        error: describeError(outcome.error.message),
        agentTitle: agent.title,
        cwd: agent.cwd,
        ...(turn ? { turn } : {}),
      }, agent);
      return;
    }
    // Every completed turn counts, however short: a task sent from the phone often finishes after
    // the phone is locked. Presence, checked at send time, keeps quick turns quiet while watched.
    if (state.completionNotified) return;
    state.turn = turn;
    const generation = state.generation;
    this.considerCompletion(agent, state, generation).catch((error: unknown) => {
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
            agentTitle: agent.title,
            cwd: agent.cwd,
            permission: describePermission(request),
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
    // Checked at send time, as Paseo's own push does: the user may have come back since the event.
    if (await this.userPresent()) {
      this.deps.log?.("用户正在使用 Paseo，跳过邮件通知", { count: records.length });
      return;
    }
    try {
      await this.deps.sender.send({
        subject: formatSubject(records),
        summary: formatMerged(records),
        body: formatBody(records),
        html: renderHtml(records),
      });
    } catch (error) {
      this.deps.log?.("邮件通知发送失败", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  dispose(): void {
    for (const state of this.agents.values()) this.clearAgentTimers(state);
    for (const requestId of this.permissions.keys()) this.clearPermission(requestId);
    if (this.mergeTimer !== undefined) this.clock.clearTimeout(this.mergeTimer);
    if (this.nudgeTimer !== undefined) this.clock.clearTimeout(this.nudgeTimer);
    this.nudgeTimer = undefined;
    this.agents.clear();
    this.permissions.clear();
    this.queued = [];
  }

  private async considerCompletion(agent: PluginHookAgent, state: AgentState, generation: number) {
    if (!this.isCurrent(agent.id, state, generation)) return;
    const durationMs = this.durationOf(state);
    const inspection = await this.inspect(agent);
    if (!this.isCurrent(agent.id, state, generation)) return;
    if (hasBackgroundWork(agent, inspection)) {
      this.scheduleRecheck(agent, state, generation);
      return;
    }
    this.enqueueCompletion(agent, state, inspection, durationMs);
  }

  private durationOf(state: AgentState): number | undefined {
    return state.startedAt === null ? undefined : this.clock.now() - state.startedAt;
  }

  private scheduleRecheck(agent: PluginHookAgent, state: AgentState, generation: number): void {
    if (!this.isCurrent(agent.id, state, generation)) return;
    if (state.recheck !== undefined) return;
    const check = () => {
      // Runs once per scheduling: from the interval or early from a nudge, whichever comes first.
      if (state.check !== check) return;
      state.check = undefined;
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
            this.scheduleRecheck(agent, state, generation);
            return;
          }
          state.grace = this.clock.setTimeout(() => {
            state.grace = undefined;
            if (!this.isCurrent(agent.id, state, generation)) return;
            this.inspect(agent)
              .then((latest) => {
                if (!this.isCurrent(agent.id, state, generation)) return;
                if (!hasBackgroundWork(agent, latest)) {
                  this.enqueueCompletion(agent, state, latest, this.durationOf(state));
                } else {
                  this.scheduleRecheck(agent, state, generation);
                }
              })
              .catch((error: unknown) => this.deps.log?.("后台工作复查失败", { error: String(error) }));
          }, WAKE_GRACE_MS);
        })
        .catch((error: unknown) => {
          if (!this.isCurrent(agent.id, state, generation)) return;
          this.deps.log?.("后台工作复查失败", { error: String(error) });
          this.scheduleRecheck(agent, state, generation);
        });
    };
    state.check = check;
    state.recheck = this.clock.setInterval(check, this.recheckMs);
  }

  private isCurrent(agentId: string, state: AgentState, generation: number): boolean {
    return this.agents.get(agentId) === state && state.generation === generation && !state.completionNotified;
  }

  private enqueueCompletion(
    agent: PluginHookAgent,
    state: AgentState,
    inspection: RuntimeInspection,
    durationMs: number | undefined,
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
      ...(durationMs !== undefined ? { durationMs } : {}),
      runningRootCount,
      agentTitle: agent.title,
      cwd: agent.cwd,
      ...(state.turn ? { turn: state.turn } : {}),
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

  private async userPresent(): Promise<boolean> {
    if (!this.deps.isUserPresent) return false;
    try {
      return await this.deps.isUserPresent();
    } catch (error) {
      this.deps.log?.("读取在场状态失败，照常发送", {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  private inspect(agent: PluginHookAgent): Promise<RuntimeInspection> {
    return this.deps.inspect(agent);
  }

  private clearAgentTimers(state: AgentState): void {
    if (state.recheck !== undefined) this.clock.clearInterval(state.recheck);
    if (state.grace !== undefined) this.clock.clearTimeout(state.grace);
    state.recheck = undefined;
    state.check = undefined;
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
