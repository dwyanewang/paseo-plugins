import type { PluginOverlayProps } from "@getpaseo/plugin/client";
import { usePaseo } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useEffect, useRef, useState, type ComponentType } from "react";
import type { WorkItem } from "../shared/schema";
import { useTodoDocument, useWorkItemViews } from "./data";
import { ExecuteBox } from "./execute-box";
import { resolveDraftIdentity, type DraftIdentity } from "./identity";
import { persistCardImages, useTodoImageStore } from "./images";
import { resolveLaunchCapability } from "./launch-guard";
import { OverlayInsets } from "./overlay";
import { useProjectCache } from "./projects";
import { useTodoStyles } from "./styles";
import { initiatorLabel, useLaunchWorkItem } from "./use-launch";
import { useTodoActions } from "./use-todo-actions";
import { WorkItemEditor } from "./work-item-editor";

/**
 * Boxes the host mounts with `openOverlay`, over whatever page the user is on. They outlive what
 * opened them — a header popover that closed itself, a command whose composer just cleared — so
 * each brings its own Todo data, actions and launcher instead of borrowing a board's.
 */

export type OpenOverlay = (Component: ComponentType<PluginOverlayProps>) => unknown;

function useDetachedTodo(props: PluginOverlayProps) {
  const paseo = usePaseo();
  const state = useTodoDocument();
  const todo = state.status === "ready" ? state.todo : null;
  const views = useWorkItemViews(todo);
  const incarnationId = todo?.incarnationId ?? "";
  const actions = useTodoActions({ incarnationId, reload: state.reload });
  const projectCache = useProjectCache(paseo);
  const capability = resolveLaunchCapability(props.navigation);
  const launcher = useLaunchWorkItem({
    paseo,
    actions,
    incarnationId,
    reload: state.reload,
    initiatorLabel: initiatorLabel(props.layout.platform, props.host.label),
    capability,
    openAgent: props.navigation?.openAgent,
  });
  // Without its data the box cannot do anything, and nothing behind it would say why.
  const toast = useToast();
  const failed = state.status === "error" || state.status === "invalid";
  const close = props.close;
  useEffect(() => {
    if (!failed) return;
    toast.error("Todo is unavailable. Open the Todo board to see why.");
    close();
  }, [failed, toast, close]);
  return { ready: todo !== null && projectCache.status === "ready", views, actions, projectCache, capability, launcher };
}

/**
 * Opens the new-item box, the project filled in when there is one. After "Create & run" the same
 * overlay goes on to the execute box for the new card.
 */
export function openNewItemOverlay(open: OpenOverlay, input: { projectId: string | null; workspaceId: string | null }): void {
  open(function NewTodoOverlay(props: PluginOverlayProps) {
    return <NewItemEntry {...props} {...input} />;
  });
}

/** Opens the execute box for one card. */
export function openExecuteOverlay(open: OpenOverlay, input: { item: WorkItem; workspaceId: string | null }): void {
  open(function ExecuteTodoOverlay(props: PluginOverlayProps) {
    return <ExecuteEntry {...props} {...input} />;
  });
}

function NewItemEntry(props: PluginOverlayProps & { projectId: string | null; workspaceId: string | null }) {
  const { theme } = props;
  const styles = useTodoStyles(theme, props.layout.compact);
  const todo = useDetachedTodo(props);
  const imageStore = useTodoImageStore();
  const toast = useToast();
  // Kept across submissions so a retry after a lost reply recreates nothing.
  const draftIdentity = useRef<DraftIdentity | null>(null);
  // Read by the editor's close, which runs in the same turn as a successful create.
  const created = useRef<WorkItem | null>(null);
  const [execute, setExecute] = useState<WorkItem | null>(null);
  const projects = todo.projectCache.projects;
  const initialProjectId = props.projectId ?? (projects.size === 1 ? ([...projects.keys()][0] ?? null) : null);
  return (
    <OverlayInsets insets={props.layout.insets}>
      <WorkItemEditor
        styles={styles}
        theme={theme}
        open={todo.ready && execute === null}
        onClose={() => {
          if (created.current) setExecute(created.current);
          else props.close();
        }}
        projects={projects}
        initialProjectId={initialProjectId}
        initialStatus="todo"
        onSubmit={async ({ execute: andExecute, images, ...input }) => {
          // A new card: nothing of its own to drop yet, and no other card uses fresh image ids.
          const refs = await persistCardImages(imageStore, images, [], new Set());
          if (!refs) {
            toast.error("Could not save the image data. Try again.");
            return false;
          }
          const draft = resolveDraftIdentity(draftIdentity.current, input);
          draftIdentity.current = draft;
          const item = await todo.actions.create({ ...input, images: refs }, draft.identity);
          if (!item) return false;
          draftIdentity.current = null;
          if (andExecute) created.current = item;
          return true;
        }}
      />
      <ExecuteBox
        styles={styles}
        theme={theme}
        item={execute ? (todo.views.get(execute.id)?.item ?? execute) : null}
        project={execute ? projects.get(execute.projectId) : undefined}
        defaultWorkspaceId={props.workspaceId}
        canOpenComposer={todo.capability.available}
        onClose={props.close}
        onSubmit={(input) => (execute ? todo.launcher.launch(todo.views.get(execute.id)?.item ?? execute, input) : Promise.resolve(false))}
      />
    </OverlayInsets>
  );
}

function ExecuteEntry(props: PluginOverlayProps & { item: WorkItem; workspaceId: string | null }) {
  const { theme } = props;
  const styles = useTodoStyles(theme, props.layout.compact);
  const todo = useDetachedTodo(props);
  // The live card, so a launch starts from what it is now rather than from when the box opened.
  const item = todo.views.get(props.item.id)?.item ?? props.item;
  return (
    <OverlayInsets insets={props.layout.insets}>
      <ExecuteBox
        styles={styles}
        theme={theme}
        item={todo.ready ? item : null}
        project={todo.projectCache.projects.get(item.projectId)}
        defaultWorkspaceId={props.workspaceId}
        canOpenComposer={todo.capability.available}
        onClose={props.close}
        onSubmit={(input) => todo.launcher.launch(item, input)}
      />
    </OverlayInsets>
  );
}
