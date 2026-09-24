import type { PluginClientContext, PluginWorkspaceCommandContext } from "@getpaseo/plugin/client";
import { createWorkItem, ensureDocument } from "../shared/contracts";
import { WORK_ITEM_PRIORITY_LABELS } from "../shared/board";
import { resolveDraftIdentity } from "./identity";
import { openNewItemOverlay } from "./overlay-entries";
import { requestNewItem } from "./pending-new";
import { parseQuickAdd } from "./quick-add";

/**
 * `/todo <what needs to happen>`: the capture that does not interrupt anything.
 *
 * The command is handled here, not sent to the agent, so a running turn is untouched. The card
 * lands in the To do column of the project this workspace belongs to; where it eventually runs is
 * still chosen at launch time.
 */
async function captureFromCommand(context: PluginWorkspaceCommandContext, text: string): Promise<void> {
  const draft = parseQuickAdd(text);
  if (!draft.title) {
    // Nothing to name the card after: show the full editor instead of writing an empty card, over
    // the page the user is on where the host can; otherwise on the board.
    if (context.openOverlay) {
      openNewItemOverlay(context.openOverlay, { projectId: context.workspace.projectId, workspaceId: context.workspace.id });
      return;
    }
    requestNewItem(context.workspace.projectId);
    context.openSurface("todo");
    return;
  }
  const ensured = await context.rpc(ensureDocument, {});
  if (ensured.status !== "ok") {
    context.notify?.error(ensured.message);
    return;
  }
  const request = {
    projectId: context.workspace.projectId,
    projectNameSnapshot: context.workspace.projectDisplayName,
    projectRootSnapshot: context.workspace.projectRootPath,
    title: draft.title,
    details: draft.details,
    defaultPrompt: "",
    status: "todo" as const,
    priority: draft.priority,
  };
  const { identity } = resolveDraftIdentity(null, request);
  const created = await context.rpc(createWorkItem, {
    expectedIncarnationId: ensured.incarnationId,
    id: identity.id,
    creationFingerprint: identity.creationFingerprint,
    ...request,
  });
  if (created.status !== "ok") {
    context.notify?.error(created.message);
    return;
  }
  const priority = draft.priority === "none" ? "" : ` · ${WORK_ITEM_PRIORITY_LABELS[draft.priority]}`;
  // The composer has already cleared by now, so without this the capture leaves no trace at all.
  context.notify?.success(`Added #${created.workItem.number} to To do${priority}`);
}

/** Every way into Todo that is not the board: the composer, and the Command Center. */
export function addTodoCommands(client: PluginClientContext): () => void {
  const cleanups = [
    // One registration, in the workspace context: a name can only be claimed once, and the host
    // offers workspace commands inside an agent conversation too, while an agent-context command
    // would be missing from a new agent's draft.
    client.addSlashCommand({
      name: "todo",
      description: "Add a todo to this project",
      argumentHint: "<what needs to happen>",
      context: "workspace",
      onSubmit: (context) => captureFromCommand(context, context.args),
    }),
    client.addCommandCenterItem({
      id: "new-todo",
      title: "New todo…",
      icon: "Plus",
      context: "global",
      keywords: ["todo", "capture", "new", "add", "work item"],
      // Mod+Shift+N is free: the built-ins hold A, B, D, E, F, G, P, T and W on Mod+Shift.
      shortcut: "Mod+Shift+N",
      onSelect({ openSurface, openOverlay }) {
        if (openOverlay) {
          openNewItemOverlay(openOverlay, { projectId: null, workspaceId: null });
          return;
        }
        requestNewItem(null);
        openSurface("todo");
      },
    }),
  ];
  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}
