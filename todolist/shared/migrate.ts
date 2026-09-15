import type { AgentLink, Attempt, LaunchClaim, WorkItem, WorkItemStatus } from "./schema";
import { aggregateWorkItem } from "./state";

type V2WorkItem = Omit<WorkItem, "priority"> & { rank?: string };

type V1WorkItem = Omit<V2WorkItem, "status" | "number" | "statusChangedAt" | "statusReason"> & {
  status: "open" | "done";
};

interface Correlations {
  claims?: Record<string, LaunchClaim>;
  attempts?: Record<string, Attempt>;
  agentLinks?: Record<string, AgentLink>;
}

interface V1Document extends Correlations {
  workItems?: Record<string, V1WorkItem>;
}

interface V2Document extends Correlations {
  workItems?: Record<string, V2WorkItem>;
  projectOrderVersions?: unknown;
  nextWorkItemNumber?: number;
}

/**
 * Settings migration, run on the host before schema validation. Each step upgrades one version, so
 * a version 1 document passes through both. A malformed document throws, which keeps the stored
 * file untouched.
 */
export function migrateTodoDocument(values: unknown, fromVersion: number): unknown {
  if (fromVersion === 1) return toVersion3(toVersion2((values ?? {}) as V1Document));
  if (fromVersion === 2) return toVersion3((values ?? {}) as V2Document);
  throw new Error(`Unsupported Todo document version ${fromVersion}.`);
}

/**
 * Version 1 only knew open/done: each open item lands in the column its agents imply (at work or
 * launching → In progress, ran before → In review, never ran → To do), and every item gets a
 * number in creation order.
 */
function toVersion2(document: V1Document): V2Document {
  const attempts = Object.values(document.attempts ?? {});
  const links = Object.values(document.agentLinks ?? {});
  const ordered = Object.values(document.workItems ?? {}).sort(
    (left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );
  const workItems: Record<string, V2WorkItem> = {};
  ordered.forEach((item, index) => {
    const base: V2WorkItem = {
      ...item,
      number: index + 1,
      status: "todo",
      statusChangedAt: item.updatedAt,
      statusReason: "migration",
    };
    const itemLinks = links.filter((link) => link.workItemId === item.id);
    const aggregate = aggregateWorkItem({
      claim: document.claims?.[item.id],
      attempts: attempts.filter((attempt) => attempt.workItemId === item.id),
      links: itemLinks,
    });
    const busy =
      aggregate.activeAgentIds.length > 0 ||
      aggregate.pendingClaim !== null ||
      aggregate.unknownAttemptIds.length > 0;
    const status: WorkItemStatus =
      item.status === "done" ? "done" : busy ? "in_progress" : itemLinks.length > 0 ? "in_review" : "todo";
    workItems[item.id] = { ...base, status };
  });
  return { ...document, workItems, nextWorkItemNumber: ordered.length + 1 };
}

/** Manual ordering is gone (`rank`, `projectOrderVersions`); every item gets an unset priority. */
function toVersion3(document: V2Document): unknown {
  const { projectOrderVersions: _order, ...rest } = document;
  const workItems = Object.fromEntries(
    Object.entries(document.workItems ?? {}).map(([id, item]) => {
      const { rank: _rank, ...kept } = item;
      return [id, { ...kept, priority: "none" }];
    }),
  );
  return { ...rest, workItems };
}
