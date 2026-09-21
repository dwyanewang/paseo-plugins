import { compareCards } from "../shared/board";
import type { WorkItemStatus } from "../shared/schema";
import type { WorkItemView } from "./data";

/** A card needs you when an agent is blocked on you, or its work is waiting to be accepted. */
export function needsYou(view: WorkItemView): boolean {
  if (view.item.archivedAt) return false;
  if (view.aggregate.state === "permission") return true;
  return view.item.status === "in_review";
}

export interface TodoSummary {
  /** Cards in To do for this project: what is written down and not started. */
  todoCount: number;
  /** Cards waiting on you, which the dot reports and the panel lists first. */
  needsYouCount: number;
}

export function summarizeProject(views: Iterable<WorkItemView>, projectId: string | null): TodoSummary {
  let todoCount = 0;
  let needsYouCount = 0;
  for (const view of views) {
    if (view.item.archivedAt) continue;
    if (projectId !== null && view.item.projectId !== projectId) continue;
    if (view.item.status === "todo") todoCount += 1;
    if (needsYou(view)) needsYouCount += 1;
  }
  return { todoCount, needsYouCount };
}

export interface PanelGroup {
  status: WorkItemStatus;
  views: WorkItemView[];
  /** How many more the group holds than the panel shows. */
  overflow: number;
}

/** The panel is a short list, not the board: only the columns that mean "now", in that order. */
export const PANEL_GROUPS: readonly WorkItemStatus[] = ["in_review", "in_progress", "todo"];
const PANEL_GROUP_LIMIT = 5;

export interface PanelContents {
  groups: PanelGroup[];
  backlogCount: number;
}

export function buildPanelContents(views: Iterable<WorkItemView>, projectId: string | null): PanelContents {
  const byStatus = new Map<WorkItemStatus, WorkItemView[]>();
  let backlogCount = 0;
  for (const view of views) {
    if (view.item.archivedAt) continue;
    if (projectId !== null && view.item.projectId !== projectId) continue;
    if (view.item.status === "backlog") backlogCount += 1;
    if (!PANEL_GROUPS.includes(view.item.status)) continue;
    const list = byStatus.get(view.item.status) ?? [];
    list.push(view);
    byStatus.set(view.item.status, list);
  }
  const groups: PanelGroup[] = [];
  for (const status of PANEL_GROUPS) {
    const all = (byStatus.get(status) ?? []).sort((left, right) => compareCards(left.item, right.item));
    if (all.length === 0) continue;
    groups.push({ status, views: all.slice(0, PANEL_GROUP_LIMIT), overflow: Math.max(0, all.length - PANEL_GROUP_LIMIT) });
  }
  return { groups, backlogCount };
}
