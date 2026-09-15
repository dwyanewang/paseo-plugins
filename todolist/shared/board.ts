import { compareRanks } from "./rank";
import { WORK_ITEM_STATUSES, type AgentLink, type StatusReason, type WorkItem, type WorkItemStatus } from "./schema";

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

/** One project's cards split into the filter's columns, each in rank order. */
export function buildBoard<View extends { item: WorkItem }>(
  views: Iterable<View>,
  input: { projectId: string; filter: BoardFilter; query: string },
): Board<View> {
  const statuses = input.filter === "archived" ? [] : FILTER_COLUMNS[input.filter];
  const columns = statuses.map((status) => ({ status, views: [] as View[] }));
  const archived: View[] = [];
  for (const view of views) {
    const { item } = view;
    if (item.projectId !== input.projectId || !matchesSearch(item, input.query)) continue;
    if (item.archivedAt) {
      if (input.filter === "archived") archived.push(view);
      continue;
    }
    columns.find((column) => column.status === item.status)?.views.push(view);
  }
  for (const column of columns) column.views.sort((left, right) => compareRanks(left.item.rank, right.item.rank));
  archived.sort((left, right) => (right.item.archivedAt ?? "").localeCompare(left.item.archivedAt ?? ""));
  return { columns, archived };
}

/** Drop neighbours for moving `id` to index `to` of an ordered column (indexes exclude `id`). */
export function neighboursAt(ids: readonly string[], id: string, to: number): { beforeId?: string; afterId?: string } {
  const without = ids.filter((entry) => entry !== id);
  const index = Math.max(0, Math.min(without.length, to));
  const beforeId = index > 0 ? without[index - 1] : undefined;
  const afterId = without[index];
  return { ...(beforeId ? { beforeId } : {}), ...(afterId ? { afterId } : {}) };
}

/** Narrow enough that the four active columns fit beside the host sidebar on a laptop screen. */
export const BOARD_COLUMN_WIDTH = 240;

/**
 * `columns` when every column fits side by side, `scroll` when at least two fit and the row scrolls
 * horizontally, `tabs` (one column at a time) below that.
 */
export function boardLayout(width: number, columnCount: number, gap: number): "columns" | "scroll" | "tabs" {
  if (columnCount <= 1) return "columns";
  const needed = (count: number) => count * BOARD_COLUMN_WIDTH + (count - 1) * gap;
  if (width >= needed(columnCount)) return "columns";
  return width >= needed(2) ? "scroll" : "tabs";
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

/** Applies a status change without bumping `version`, so an open editor never conflicts with a move. */
export function withStatus(item: WorkItem, status: WorkItemStatus, reason: StatusReason, now: string): WorkItem {
  const next: WorkItem = { ...item, status, statusReason: reason, statusChangedAt: now };
  if (status === "done") next.completedAt = now;
  else delete next.completedAt;
  return next;
}
