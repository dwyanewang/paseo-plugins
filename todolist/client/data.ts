import { useSettings } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import type { TodoError } from "../shared/contracts";
import { todoData, type AgentLink, type Attempt, type LaunchClaim, type TodoDocument, type WorkItem } from "../shared/schema";
import { aggregateWorkItem, type WorkItemAggregate } from "../shared/state";
import { compareRanks } from "../shared/rank";

/**
 * Plugin-local read-only adapter over the host Settings todo. Business components never see
 * `save` or `reset`; the only writers are typed Todo RPCs. Reset lives solely in the recovery
 * screen. A mount does not refetch: explicit checks call `reload()`.
 */
export type TodoDocumentState =
  | { status: "loading"; reload: () => Promise<void> }
  | { status: "error"; error: string; reload: () => Promise<void> }
  | { status: "invalid"; error: string; revision: string; reload: () => Promise<void> }
  | { status: "ready"; todo: TodoDocument; revision: string; reload: () => Promise<void> };

export function useTodoDocument(): TodoDocumentState {
  const settings = useSettings(todoData);
  const reload = settings.reload;
  if (settings.status === "loading") return { status: "loading", reload };
  if (settings.status === "error") return { status: "error", error: settings.error, reload };
  if (settings.status === "invalid") {
    return { status: "invalid", error: settings.error, revision: settings.revision, reload };
  }
  return { status: "ready", todo: settings.values, revision: settings.revision, reload };
}

/** The recovery screen is the only consumer of reset; it must confirm twice before calling it. */
export function useTodoRecovery(): { reset: () => Promise<boolean>; saving: boolean; saveError: string | null } {
  const settings = useSettings(todoData);
  return { reset: settings.reset, saving: settings.saving, saveError: settings.saveError };
}

export interface WorkItemView {
  item: WorkItem;
  claim: LaunchClaim | undefined;
  attempts: Attempt[];
  links: AgentLink[];
  aggregate: WorkItemAggregate;
}

export function buildWorkItemViews(todo: TodoDocument): Map<string, WorkItemView> {
  const attemptsByItem = new Map<string, Attempt[]>();
  for (const attempt of Object.values(todo.attempts)) {
    const list = attemptsByItem.get(attempt.workItemId) ?? [];
    list.push(attempt);
    attemptsByItem.set(attempt.workItemId, list);
  }
  const linksByItem = new Map<string, AgentLink[]>();
  for (const link of Object.values(todo.agentLinks)) {
    const list = linksByItem.get(link.workItemId) ?? [];
    list.push(link);
    linksByItem.set(link.workItemId, list);
  }
  const views = new Map<string, WorkItemView>();
  for (const item of Object.values(todo.workItems)) {
    const attempts = (attemptsByItem.get(item.id) ?? []).sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt),
    );
    const links = (linksByItem.get(item.id) ?? []).sort((left, right) =>
      right.firstObservedAt.localeCompare(left.firstObservedAt),
    );
    const claim = todo.claims[item.id];
    views.set(item.id, { item, claim, attempts, links, aggregate: aggregateWorkItem({ item, claim, attempts, links }) });
  }
  return views;
}

export interface ProjectGroup {
  projectId: string;
  open: WorkItemView[];
  done: WorkItemView[];
  archived: WorkItemView[];
}

export function groupByProject(views: Iterable<WorkItemView>): Map<string, ProjectGroup> {
  const groups = new Map<string, ProjectGroup>();
  for (const view of views) {
    const group = groups.get(view.item.projectId) ?? {
      projectId: view.item.projectId,
      open: [],
      done: [],
      archived: [],
    };
    if (view.item.archivedAt) group.archived.push(view);
    else if (view.item.status === "done" || view.item.status === "cancelled") group.done.push(view);
    else group.open.push(view);
    groups.set(view.item.projectId, group);
  }
  for (const group of groups.values()) {
    group.open.sort((left, right) => compareRanks(left.item.rank, right.item.rank));
    group.done.sort((left, right) => (right.item.completedAt ?? "").localeCompare(left.item.completedAt ?? ""));
    group.archived.sort((left, right) => (right.item.archivedAt ?? "").localeCompare(left.item.archivedAt ?? ""));
  }
  return groups;
}

export function useWorkItemViews(todo: TodoDocument | null): Map<string, WorkItemView> {
  return useMemo(() => (todo ? buildWorkItemViews(todo) : new Map()), [todo]);
}

export function isTodoError(value: { status: string }): value is TodoError {
  return value.status !== "ok";
}

export function describeTodoError(error: TodoError): string {
  switch (error.status) {
    case "stale_document":
      return "The Todo data was reset elsewhere. Reload to continue.";
    case "conflict":
    case "order_conflict":
      return "This item changed on another client. Reload and try again.";
    case "capacity_exceeded":
      return error.message;
    default:
      return error.message;
  }
}

/** Invalidates the settings replica after a Todo write so every open surface re-reads. */
export function useTodoInvalidate(): () => Promise<void> {
  const client = useQueryClient();
  return useCallback(async () => {
    await client.invalidateQueries({ queryKey: ["plugin-settings", todoData.id] });
  }, [client]);
}

export { useRpc };
