import type { AgentLink, Attempt, LaunchClaim, WorkItem, WorkItemStatus } from "./schema";
import { aggregateWorkItem } from "./state";

type V1WorkItem = Omit<WorkItem, "status" | "number" | "statusChangedAt" | "statusReason"> & {
  status: "open" | "done";
};

interface V1Document {
  workItems?: Record<string, V1WorkItem>;
  claims?: Record<string, LaunchClaim>;
  attempts?: Record<string, Attempt>;
  agentLinks?: Record<string, AgentLink>;
}

/**
 * Settings migration, run on the host before schema validation. Version 1 only knew open/done:
 * each open item lands in the column its agents imply (at work or launching → In progress, ran
 * before → In review, never ran → To do), and every item gets a number in creation order. A
 * malformed document throws here, which keeps the stored file untouched.
 */
export function migrateTodoDocument(values: unknown, fromVersion: number): unknown {
  if (fromVersion !== 1) throw new Error(`Unsupported Todo document version ${fromVersion}.`);
  const document = (values ?? {}) as V1Document;
  const attempts = Object.values(document.attempts ?? {});
  const links = Object.values(document.agentLinks ?? {});
  const ordered = Object.values(document.workItems ?? {}).sort(
    (left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );
  const workItems: Record<string, WorkItem> = {};
  ordered.forEach((item, index) => {
    const base: WorkItem = {
      ...item,
      number: index + 1,
      status: "todo",
      statusChangedAt: item.updatedAt,
      statusReason: "migration",
    };
    const itemLinks = links.filter((link) => link.workItemId === item.id);
    const aggregate = aggregateWorkItem({
      item: base,
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
