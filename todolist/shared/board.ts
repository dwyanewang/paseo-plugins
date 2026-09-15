import {
  WORK_ITEM_PRIORITIES,
  WORK_ITEM_STATUSES,
  type AgentLink,
  type StatusReason,
  type TodoAgentDisplayState,
  type WorkItem,
  type WorkItemPriority,
  type WorkItemStatus,
} from "./schema";
import type { WorkItemAggregate } from "./state";

export const WORK_ITEM_STATUS_LABELS: Record<WorkItemStatus, string> = {
  backlog: "Backlog",
  todo: "To do",
  in_progress: "In progress",
  in_review: "In review",
  done: "Done",
  cancelled: "Cancelled",
};

export const STATUS_REASON_LABELS: Record<StatusReason, string> = {
  created: "Created here",
  manual: "Moved by hand",
  launch_started: "Moved when a launch started",
  agent_active: "Moved when an agent started",
  agent_finished: "Moved when the agent finished",
  migration: "Placed by the board upgrade",
};

export const WORK_ITEM_PRIORITY_LABELS: Record<WorkItemPriority, string> = {
  urgent: "Urgent",
  high: "High",
  medium: "Medium",
  low: "Low",
  none: "No priority",
};

export type BoardFilter = "active" | "all" | "backlog" | "cancelled" | "archived";

export const BOARD_FILTERS: readonly { value: BoardFilter; label: string }[] = [
  { value: "active", label: "Active" },
  { value: "all", label: "All" },
  { value: "backlog", label: "Backlog" },
  { value: "cancelled", label: "Cancelled" },
  { value: "archived", label: "Archived" },
];

const FILTER_COLUMNS: Record<Exclude<BoardFilter, "archived">, readonly WorkItemStatus[]> = {
  active: ["todo", "in_progress", "in_review", "done"],
  all: WORK_ITEM_STATUSES,
  backlog: ["backlog"],
  cancelled: ["cancelled"],
};

export interface BoardColumn<View> {
  status: WorkItemStatus;
  views: View[];
}

export interface Board<View> {
  columns: BoardColumn<View>[];
  /** Filled only for the Archived filter, newest first. */
  archived: View[];
}

/** Case-insensitive match on the title and details; `#12` (or `12`) also matches the number. */
export function matchesSearch(item: WorkItem, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  if (String(item.number) === needle.replace(/^#/, "")) return true;
  return item.title.toLowerCase().includes(needle) || item.details.toLowerCase().includes(needle);
}

/** Highest priority first; equal priorities keep creation order, so cards never jump around. */
export function compareCards(left: WorkItem, right: WorkItem): number {
  return (
    WORK_ITEM_PRIORITIES.indexOf(left.priority) - WORK_ITEM_PRIORITIES.indexOf(right.priority) ||
    left.number - right.number
  );
}

/** Cards split into the filter's columns; `projectId: null` shows every project. */
export function buildBoard<View extends { item: WorkItem }>(
  views: Iterable<View>,
  input: { projectId: string | null; filter: BoardFilter; query: string },
): Board<View> {
  const statuses = input.filter === "archived" ? [] : FILTER_COLUMNS[input.filter];
  const columns = statuses.map((status) => ({ status, views: [] as View[] }));
  const archived: View[] = [];
  for (const view of views) {
    const { item } = view;
    if ((input.projectId !== null && item.projectId !== input.projectId) || !matchesSearch(item, input.query)) continue;
    if (item.archivedAt) {
      if (input.filter === "archived") archived.push(view);
      continue;
    }
    columns.find((column) => column.status === item.status)?.views.push(view);
  }
  for (const column of columns) column.views.sort((left, right) => compareCards(left.item, right.item));
  archived.sort((left, right) => (right.item.archivedAt ?? "").localeCompare(left.item.archivedAt ?? ""));
  return { columns, archived };
}

/**
 * What a column's "+" does. Work starts in Backlog or To do; later columns only receive cards that
 * already exist: In progress takes one card that has not started, Done accepts reviewed cards.
 * In review and Cancelled have no "+": the agent fills the first, the move menu covers the second.
 */
export type ColumnAddAction =
  | { kind: "create" }
  | { kind: "pick"; sources: readonly WorkItemStatus[]; multiple: boolean };

export function columnAddAction(status: WorkItemStatus): ColumnAddAction | null {
  switch (status) {
    case "backlog":
    case "todo":
      return { kind: "create" };
    case "in_progress":
      return { kind: "pick", sources: ["todo", "backlog"], multiple: false };
    case "done":
      return { kind: "pick", sources: ["in_review"], multiple: true };
    default:
      return null;
  }
}

/** Narrow enough that the four active columns fit beside the host sidebar on a laptop screen. */
export const BOARD_COLUMN_WIDTH = 240;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MeasuredColumn {
  status: WorkItemStatus;
  rect: Rect;
}

/**
 * The column under a pointer, by horizontal position, with a vertical margin so dropping just
 * below a short column still counts.
 */
export function dropColumnAt(
  point: { x: number; y: number },
  columns: readonly MeasuredColumn[],
  margin = 24,
): WorkItemStatus | null {
  const column = columns.find(
    ({ rect }) =>
      point.x >= rect.x &&
      point.x <= rect.x + rect.width &&
      point.y >= rect.y - margin &&
      point.y <= rect.y + rect.height + margin,
  );
  return column?.status ?? null;
}

/**
 * `tabs` (one column at a time) whenever two columns would not fit, even when a filter leaves a
 * single column, so a phone board looks the same under every filter. Wider boards show `columns`
 * when every column fits side by side and `scroll` when the row has to scroll horizontally.
 */
export function boardLayout(width: number, columnCount: number, gap: number): "columns" | "scroll" | "tabs" {
  const needed = (count: number) => count * BOARD_COLUMN_WIDTH + (count - 1) * gap;
  if (width < needed(2)) return "tabs";
  return width >= needed(columnCount) ? "columns" : "scroll";
}

/** The agent whose state changed last; the card shows it and counts the rest. */
export function latestLink(links: readonly AgentLink[]): AgentLink | undefined {
  return links.reduce<AgentLink | undefined>(
    (latest, link) => (!latest || link.stateChangedAt > latest.stateChangedAt ? link : latest),
    undefined,
  );
}

export function formatRelativeTime(iso: string, now: number): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "";
  const minutes = Math.floor(Math.max(0, now - time) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return days < 30 ? `${days} d ago` : new Date(time).toLocaleDateString();
}

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

export type InProgressIntent =
  | { kind: "move_only"; reason: "agent_active" | "launch_in_flight" }
  | { kind: "permission"; agentId: string }
  /** Agents that can take a follow-up, latest state change first. */
  | { kind: "continue"; agentIds: string[] }
  | { kind: "execute" };

/** Settled states a follow-up can resume; sending reopens a closed or archived agent. */
const CONTINUABLE: ReadonlySet<TodoAgentDisplayState> = new Set(["waiting_confirmation", "error", "closed"]);

/**
 * What moving a card into In progress by hand should do. A running agent or a launch in flight
 * means the card only moves: a follow-up would interrupt the running turn. An agent waiting for
 * permission needs its own page. Otherwise the most recently settled agent can take a follow-up,
 * and with none left a new run starts. Stale links are never trusted to be idle.
 */
export function resolveInProgressIntent(view: {
  links: readonly AgentLink[];
  aggregate: Pick<WorkItemAggregate, "pendingClaim" | "unknownAttemptIds">;
}): InProgressIntent {
  const links = [...view.links].sort((left, right) => right.stateChangedAt.localeCompare(left.stateChangedAt));
  const running = links.some(
    (link) =>
      link.displayState === "initializing" ||
      link.displayState === "running" ||
      (link.displayState === "permission" && link.staleSince),
  );
  if (running) return { kind: "move_only", reason: "agent_active" };
  if (view.aggregate.pendingClaim || view.aggregate.unknownAttemptIds.length > 0) {
    return { kind: "move_only", reason: "launch_in_flight" };
  }
  const waiting = links.find((link) => link.displayState === "permission");
  if (waiting) return { kind: "permission", agentId: waiting.agentId };
  const continuable = links.filter((link) => !link.staleSince && CONTINUABLE.has(link.displayState));
  return continuable.length > 0 ? { kind: "continue", agentIds: continuable.map((link) => link.agentId) } : { kind: "execute" };
}

/** Applies a status change without bumping `version`, so an open editor never conflicts with a move. */
export function withStatus(item: WorkItem, status: WorkItemStatus, reason: StatusReason, now: string): WorkItem {
  const next: WorkItem = { ...item, status, statusReason: reason, statusChangedAt: now };
  if (status === "done") next.completedAt = now;
  else delete next.completedAt;
  return next;
}
