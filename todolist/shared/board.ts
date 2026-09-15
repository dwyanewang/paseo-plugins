import type { StatusReason, WorkItem, WorkItemStatus } from "./schema";

export const WORK_ITEM_STATUS_LABELS: Record<WorkItemStatus, string> = {
  backlog: "Backlog",
  todo: "To do",
  in_progress: "In progress",
  in_review: "In review",
  done: "Done",
  cancelled: "Cancelled",
};

/** Columns an automatic move may pull into In progress. Done and Cancelled only change by hand. */
const BEFORE_PROGRESS: ReadonlySet<WorkItemStatus> = new Set(["backlog", "todo", "in_review"]);

export type AutoMoveTrigger =
  | { kind: "launch_started" }
  | {
      kind: "agent_observed";
      /** Any linked agent initializing, running or waiting for permission, stale or not. */
      busyBefore: boolean;
      busyAfter: boolean;
      /** This write settled an agent: an active link went idle, or a new link was first seen idle. */
      agentFinished: boolean;
      /** No pending claim and no attempt with an unknown outcome remain after the write. */
      launchSettled: boolean;
    };

export interface AutoMove {
  from: WorkItemStatus;
  to: WorkItemStatus;
  reason: Extract<StatusReason, "launch_started" | "agent_active" | "agent_finished">;
}

/**
 * The automatic board moves. They fire only on the write that changes the underlying fact, so a
 * replayed snapshot changes nothing and a manual move stands until the next real transition.
 */
export function deriveAutoMove(status: WorkItemStatus, trigger: AutoMoveTrigger): AutoMove | null {
  if (trigger.kind === "launch_started") {
    return BEFORE_PROGRESS.has(status) ? { from: status, to: "in_progress", reason: "launch_started" } : null;
  }
  if (!trigger.busyBefore && trigger.busyAfter) {
    return BEFORE_PROGRESS.has(status) ? { from: status, to: "in_progress", reason: "agent_active" } : null;
  }
  if (!trigger.busyAfter && trigger.agentFinished && trigger.launchSettled && status === "in_progress") {
    return { from: status, to: "in_review", reason: "agent_finished" };
  }
  return null;
}

/** Applies a status change without bumping `version`, so an open editor never conflicts with a move. */
export function withStatus(item: WorkItem, status: WorkItemStatus, reason: StatusReason, now: string): WorkItem {
  const next: WorkItem = { ...item, status, statusReason: reason, statusChangedAt: now };
  if (status === "done") next.completedAt = now;
  else delete next.completedAt;
  return next;
}
