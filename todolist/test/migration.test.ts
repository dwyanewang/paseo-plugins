import { describe, expect, it } from "vitest";
import { applyAgentSnapshotMutation, canonicalizeAgentSnapshot } from "../server/apply";
import { reportLaunchProgressMutation } from "../server/mutations";
import { buildTodoLabels } from "../shared/labels";
import { migrateTodoDocument } from "../shared/migrate";
import { TODO_SETTINGS_VERSION, TodoDocumentSchema, todoData, type TodoDocument } from "../shared/schema";
import { fakeAgent } from "./helpers/fake-paseo";
import { NOW, baseDocument, withClaim, withWorkItem } from "./helpers/setup";

function commit(outcome: { status: string; values?: TodoDocument }): TodoDocument {
  if (outcome.status !== "commit" || !outcome.values) throw new Error(`expected commit, got ${outcome.status}`);
  return outcome.values;
}

function link(document: TodoDocument, workItemId: string, agentId: string, status: "running" | "idle") {
  return commit(
    applyAgentSnapshotMutation(
      document,
      {
        projection: canonicalizeAgentSnapshot({
          agent: fakeAgent({ id: agentId, labels: buildTodoLabels(workItemId, `att-${workItemId}`), status, workspaceId: "wks-1" }),
          projectId: "project-1",
        }),
        allowProjection: true,
        promptObserved: false,
      },
      NOW,
    ),
  );
}

/** Rewrites a current document into the version 1 shape: open/done, no numbers, no status history. */
function toVersion1(document: TodoDocument, done: readonly string[], createdAt: Record<string, string>) {
  const workItems = Object.fromEntries(
    Object.values(document.workItems).map((item) => {
      const { number: _number, statusChangedAt: _changed, statusReason: _reason, status: _status, priority: _priority, ...rest } = item;
      return [
        item.id,
        { ...rest, rank: `r${item.id}`, status: done.includes(item.id) ? "done" : "open", createdAt: createdAt[item.id] ?? item.createdAt, updatedAt: `updated-${item.id}` },
      ];
    }),
  );
  const { nextWorkItemNumber: _next, ...rest } = document;
  return JSON.parse(JSON.stringify({ ...rest, projectOrderVersions: { "project-1": 6 }, workItems }));
}

function fixture() {
  let document = baseDocument();
  for (const id of ["never", "pending", "unknown", "running", "finished", "done"]) document = withWorkItem(document, id);
  document = withClaim(document, "pending", "att-pending");
  document = withClaim(document, "unknown", "att-unknown");
  document = commit(
    reportLaunchProgressMutation(
      document,
      {
        expectedIncarnationId: "inc-1",
        attemptId: "att-unknown",
        generation: 1,
        facet: "agent-request",
        factVersion: 1,
        facts: { agentRequestStartedAt: NOW, agentOutcomeUnknownObservedAt: NOW },
      },
      NOW,
    ),
  );
  // Only the unknown outcome keeps this one busy: its claim no longer holds the launch.
  document = { ...document, claims: { ...document.claims, unknown: { ...document.claims.unknown!, state: "abandoned" } } };
  for (const [id, agentStatus] of [["running", "running"], ["finished", "idle"], ["done", "running"]] as const) {
    document = withClaim(document, id, `att-${id}`);
    document = link(document, id, `agent-${id}`, agentStatus);
  }
  return toVersion1(document, ["done"], {
    never: "2026-01-06T00:00:00.000Z",
    pending: "2026-01-01T00:00:00.000Z",
    unknown: "2026-01-02T00:00:00.000Z",
    running: "2026-01-02T00:00:00.000Z",
    finished: "2026-01-04T00:00:00.000Z",
    done: "2026-01-05T00:00:00.000Z",
  });
}

describe("todo-data migrations", () => {
  it("is wired into the settings definition", () => {
    expect(TODO_SETTINGS_VERSION).toBe(3);
    expect(todoData.migrate).toBe(migrateTodoDocument);
  });

  it("places each open item in the column its agents imply and keeps Done", () => {
    const migrated = TodoDocumentSchema.parse(migrateTodoDocument(fixture(), 1));
    const statuses = Object.fromEntries(Object.values(migrated.workItems).map((item) => [item.id, item.status]));
    expect(statuses).toEqual({
      never: "todo",
      pending: "in_progress",
      unknown: "in_progress",
      running: "in_progress",
      finished: "in_review",
      done: "done",
    });
    expect(migrated.workItems.finished).toMatchObject({ statusReason: "migration", statusChangedAt: "updated-finished", priority: "none" });
  });

  it("drops manual ordering and gives every item an unset priority, from version 1 or 2", () => {
    const fromV1 = migrateTodoDocument(fixture(), 1) as Record<string, unknown> & { workItems: Record<string, Record<string, unknown>> };
    expect(fromV1.projectOrderVersions).toBeUndefined();
    expect(Object.values(fromV1.workItems).every((item) => !("rank" in item) && item.priority === "none")).toBe(true);

    const current = TodoDocumentSchema.parse(migrateTodoDocument(fixture(), 1));
    const version2 = JSON.parse(
      JSON.stringify({
        ...current,
        projectOrderVersions: { "project-1": 4 },
        workItems: Object.fromEntries(
          Object.values(current.workItems).map(({ priority: _priority, ...item }) => [item.id, { ...item, rank: `r${item.number}` }]),
        ),
      }),
    );
    const fromV2 = migrateTodoDocument(version2, 2) as Record<string, unknown> & { workItems: Record<string, Record<string, unknown>> };
    expect(fromV2.projectOrderVersions).toBeUndefined();
    expect(Object.values(fromV2.workItems).every((item) => !("rank" in item) && item.priority === "none")).toBe(true);
    expect(TodoDocumentSchema.parse(fromV2)).toEqual(current);
  });

  it("numbers items by creation time, then by ID, and continues from there", () => {
    const migrated = TodoDocumentSchema.parse(migrateTodoDocument(fixture(), 1));
    const numbers = Object.fromEntries(Object.values(migrated.workItems).map((item) => [item.id, item.number]));
    expect(numbers).toEqual({ pending: 1, running: 2, unknown: 3, finished: 4, done: 5, never: 6 });
    expect(migrated.nextWorkItemNumber).toBe(7);
  });

  it("migrates an empty document", () => {
    expect(TodoDocumentSchema.parse(migrateTodoDocument({}, 1))).toMatchObject({ workItems: {}, nextWorkItemNumber: 1 });
  });

  it("throws on an unknown source version or a malformed document, so the stored file is kept", () => {
    expect(() => migrateTodoDocument({}, 3)).toThrow();
    expect(() => migrateTodoDocument({ workItems: { a: { id: "a" }, b: { id: "b" } } }, 1)).toThrow();
  });
});
