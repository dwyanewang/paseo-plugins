/** Correlation labels. Names are frozen for v1; the marker is the directory filter entry. */
export const TODO_LABEL_MARKER = "paseo.plugin.todo";
export const TODO_LABEL_MARKER_VALUE = "v1";
export const TODO_LABEL_WORK_ITEM_ID = "paseo.plugin.todo.work-item-id";
export const TODO_LABEL_ATTEMPT_ID = "paseo.plugin.todo.attempt-id";

export const TODO_MARKER_FILTER: Readonly<Record<string, string>> = {
  [TODO_LABEL_MARKER]: TODO_LABEL_MARKER_VALUE,
};

export function buildTodoLabels(workItemId: string, attemptId: string): Record<string, string> {
  return {
    [TODO_LABEL_MARKER]: TODO_LABEL_MARKER_VALUE,
    [TODO_LABEL_WORK_ITEM_ID]: workItemId,
    [TODO_LABEL_ATTEMPT_ID]: attemptId,
  };
}

export interface TodoCorrelation {
  workItemId: string;
  attemptId: string;
}

/** All three v1 labels are required; anything else is not a Todo correlation. */
export function parseTodoLabels(
  labels: Readonly<Record<string, string>> | undefined,
): TodoCorrelation | null {
  if (!labels) return null;
  if (labels[TODO_LABEL_MARKER] !== TODO_LABEL_MARKER_VALUE) return null;
  const workItemId = labels[TODO_LABEL_WORK_ITEM_ID];
  const attemptId = labels[TODO_LABEL_ATTEMPT_ID];
  if (!workItemId || !attemptId) return null;
  return { workItemId, attemptId };
}
