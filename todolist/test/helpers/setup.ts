import { createTodoLogger, type TodoLogger } from "../../server/log";
import { TodoStore } from "../../server/store";
import { computeCreationFingerprint } from "../../shared/fingerprint";
import { TodoDocumentSchema, type TodoDocument } from "../../shared/schema";
import { createWorkItemMutation, acquireLaunchMutation } from "../../server/mutations";
import { computeRequestFingerprint } from "../../shared/fingerprint";
import { buildTodoLabels } from "../../shared/labels";
import { FakeSettingsDocument } from "./fake-document";

export const NOW = "2026-09-11T10:00:00.000Z";

export function silentLogger(): TodoLogger & { lines: string[] } {
  const lines: string[] = [];
  const logger = createTodoLogger({ log: (line) => lines.push(line), error: (line) => lines.push(line) });
  return Object.assign(logger, { lines });
}

export function createStore(options: { capacity?: TodoStore["mutate"] extends never ? never : ConstructorParameters<typeof TodoStore>[1]["capacity"] } = {}) {
  const document = new FakeSettingsDocument(TodoDocumentSchema);
  let counter = 0;
  const store = new TodoStore(document, {
    now: () => NOW,
    generateIncarnationId: () => `inc-${++counter}`,
    ...(options.capacity ? { capacity: options.capacity } : {}),
  });
  return { document, store };
}

export function baseDocument(overrides: Partial<TodoDocument> = {}): TodoDocument {
  return { ...TodoDocumentSchema.parse({ incarnationId: "inc-1", seq: 1 }), ...overrides };
}

export function createInput(id: string, projectId = "project-1", title = `Item ${id}`) {
  const content = { id, projectId, title, details: "details", defaultPrompt: "do it" };
  return {
    expectedIncarnationId: "inc-1",
    ...content,
    projectNameSnapshot: "Project",
    creationFingerprint: computeCreationFingerprint(content),
  };
}

export function withWorkItem(document: TodoDocument, id: string, projectId = "project-1"): TodoDocument {
  const outcome = createWorkItemMutation(document, createInput(id, projectId), NOW);
  if (outcome.status !== "commit") throw new Error(`create failed: ${outcome.status}`);
  return outcome.values;
}

export function launchInput(workItemId: string, attemptId: string, seedPrompt = "do it") {
  const labels = buildTodoLabels(workItemId, attemptId);
  const clientMessageId = `msg-${attemptId}`;
  return {
    expectedIncarnationId: "inc-1",
    workItemId,
    attemptId,
    clientMessageId,
    seedPrompt,
    seedPromptSource: "work-item-default" as const,
    initiatorLabel: "Desktop",
    requestFingerprint: computeRequestFingerprint({
      projectId: "project-1",
      workItemId,
      attemptId,
      clientMessageId,
      labels,
      seedPrompt,
    }),
    projectAvailable: true,
  };
}

export function withClaim(document: TodoDocument, workItemId: string, attemptId: string): TodoDocument {
  const outcome = acquireLaunchMutation(document, launchInput(workItemId, attemptId), NOW);
  if (outcome.status !== "commit") throw new Error(`acquire failed: ${outcome.status}`);
  return outcome.values;
}
