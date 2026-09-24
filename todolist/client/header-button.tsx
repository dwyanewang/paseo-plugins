import type { PluginButtonContentProps, PluginButtonIconProps } from "@getpaseo/plugin/client";
import { usePaseo, useWorkspace } from "@getpaseo/plugin/client";
import { Icon, ScrollView as HostScrollView, useToast } from "@getpaseo/plugin/client/react-native";
import { useCallback, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { WORK_ITEM_STATUS_LABELS } from "../shared/board";
import type { WorkItemStatus } from "../shared/schema";
import type { WorkItem } from "../shared/schema";
import { useTodoDocument, useWorkItemViews, type WorkItemView } from "./data";
import type { ExecuteSubmit } from "./execute-form";
import { ExecuteModal } from "./execute-modal";
import { openExecuteOverlay } from "./overlay-entries";
import { TextAction } from "./overlay-parts";
import { persistCardImages, useTodoImageStore } from "./images";
import { resolveDraftIdentity, type DraftIdentity } from "./identity";
import { resolveLaunchCapability } from "./launch-guard";
import { useProjectCache } from "./projects";
import { useSidebarBadge } from "./sidebar-badge";
import { buildPanelContents, needsYou, summarizeProject } from "./summary";
import { useTodoStyles, type TodoStyles } from "./styles";
import { AGGREGATE_PRESENTATION, PRIORITY_PRESENTATION, STATUS_PRESENTATION } from "./text";
import { initiatorLabel, useLaunchWorkItem } from "./use-launch";
import { useTodoActions } from "./use-todo-actions";
import { EmbeddedNewItem, type EditorSubmit } from "./work-item-editor";

/**
 * The list's share of the panel on wide layouts: the host caps a popover at 440 points, less the
 * padding and the footer. The embedded box takes what it needs above.
 */
const PANEL_MAX_HEIGHT = 368;

/** The project a workspace belongs to; every panel is that project's, never the whole host. */
function useWorkspaceProject(workspaceId: string): { projectId: string; projectDisplayName: string; projectRootPath: string } | null {
  return (
    useWorkspace(workspaceId, (snapshot) => ({
      projectId: snapshot.projectId,
      projectDisplayName: snapshot.projectDisplayName,
      projectRootPath: snapshot.projectRootPath,
    })) ?? null
  );
}

/**
 * Header glyph: how much is written down here, and whether anything is waiting on you.
 *
 * The count lives in the icon rather than the button's label because a label change re-registers
 * the button, which would close the panel while it is open. This component re-renders on its own.
 */
export function TodoHeaderIcon({ workspaceId, size, color, theme }: PluginButtonIconProps) {
  const project = useWorkspaceProject(workspaceId);
  const state = useTodoDocument();
  const views = useWorkItemViews(state.status === "ready" ? state.todo : null);
  const summary = useMemo(
    () => summarizeProject(views.values(), project?.projectId ?? null),
    [views, project?.projectId],
  );
  // The sidebar item is host-wide, so its count is too: everything waiting on you, any project.
  useSidebarBadge(useMemo(() => [...views.values()].filter(needsYou).length, [views]));
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
      <View>
        <Icon name="ListChecks" size={size} color={color} />
        {summary.needsYouCount > 0 ? (
          <View
            style={{
              position: "absolute",
              top: -2,
              right: -3,
              width: 7,
              height: 7,
              borderRadius: 4,
              backgroundColor: theme.colors.statusSuccess,
            }}
          />
        ) : null}
      </View>
      {summary.todoCount > 0 ? (
        <Text style={{ color: theme.colors.foreground, fontSize: 12.5, fontWeight: "600" }}>{summary.todoCount}</Text>
      ) : null}
    </View>
  );
}

function PanelRow(props: {
  styles: TodoStyles;
  theme: PluginButtonContentProps["theme"];
  view: WorkItemView;
  onPress: () => void;
  onRun?: (() => void) | undefined;
}) {
  const { styles, theme, view } = props;
  const priority = PRIORITY_PRESENTATION[view.item.priority];
  const aggregate = AGGREGATE_PRESENTATION[view.aggregate.state];
  return (
    // The row is not itself a button: it holds one, and a button inside a button is invalid HTML.
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 5 }}>
      <Pressable
        onPress={props.onPress}
        accessibilityRole="button"
        accessibilityLabel={`#${view.item.number} ${view.item.title}`}
        style={({ hovered }: { hovered?: boolean; pressed: boolean }) => [
          { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 10, borderRadius: 7, marginHorizontal: -6, paddingHorizontal: 6, paddingVertical: 3 },
          hovered ? { backgroundColor: theme.colors.surface2 } : null,
        ]}
      >
        <Icon name={priority.icon} size={14} color={theme.colors[priority.color]} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text numberOfLines={1} style={[styles.body, { fontSize: 13.5 }]}>
            {`#${view.item.number} ${view.item.title}`}
          </Text>
          {view.aggregate.state === "idle" ? null : (
            <Text numberOfLines={1} style={styles.metaText}>
              {aggregate.label}
            </Text>
          )}
        </View>
      </Pressable>
      {props.onRun ? <TextAction theme={theme} label="Run" icon="Play" kind="accent" small onPress={props.onRun} /> : null}
    </View>
  );
}

/**
 * The panel behind the header button: write something down without leaving the agent you are in,
 * and see what this project is waiting on you for.
 *
 * It deliberately shows only In review, In progress and To do — the board is where Backlog, Done
 * and Cancelled live. Rows open the agent that is working on them; a panel cannot open a plugin
 * surface, so nothing here pretends to link to the board.
 *
 * Adding and running continue in boxes the host mounts over the page (`openOverlay`), which stay
 * open after this popover closes. Hosts without that keep both inside the popover: an inline entry
 * and the host-dialog execute form.
 */
export function TodoHeaderPanel(props: PluginButtonContentProps) {
  const { theme } = props;
  const styles = useTodoStyles(theme, props.layout.compact);
  const project = useWorkspaceProject(props.workspaceId);
  const state = useTodoDocument();
  const views = useWorkItemViews(state.status === "ready" ? state.todo : null);
  const incarnationId = state.status === "ready" ? state.todo.incarnationId : "";
  const reload = state.reload;
  const actions = useTodoActions({ incarnationId, reload });
  const [execute, setExecute] = useState<WorkItem | null>(null);
  const draft = useRef<DraftIdentity | null>(null);
  const paseo = usePaseo();
  const projectCache = useProjectCache(paseo);
  const imageStore = useTodoImageStore();
  const toast = useToast();
  const capability = resolveLaunchCapability(props.navigation);
  const launcher = useLaunchWorkItem({
    paseo,
    actions,
    incarnationId,
    reload,
    initiatorLabel: initiatorLabel(props.layout.platform, props.host.label),
    capability,
    openAgent: props.navigation?.openAgent,
  });
  const contents = useMemo(
    () => buildPanelContents(views.values(), project?.projectId ?? null),
    [views, project?.projectId],
  );

  const add = useCallback(
    async ({ execute: andExecute, images, ...input }: EditorSubmit): Promise<boolean> => {
      // A new card: nothing of its own to drop, and no other card uses these fresh ids.
      const refs = await persistCardImages(imageStore, images, [], new Set());
      if (!refs) {
        toast.error("Could not save the image data. Try again.");
        return false;
      }
      const identity = resolveDraftIdentity(draft.current, input);
      draft.current = identity;
      const created = await actions.create({ ...input, images: refs }, identity.identity);
      if (!created) return false;
      draft.current = null;
      if (andExecute) runRef.current(created);
      return true;
    },
    [actions, imageStore, toast],
  );

  // Newer hosts mount boxes that outlive this popover; older ones keep everything inside it.
  const openOverlay = props.navigation?.openOverlay;
  const openSurface = props.navigation?.openSurface;
  const run = (item: WorkItem) => {
    if (!openOverlay) {
      setExecute(item);
      return;
    }
    props.close();
    openExecuteOverlay(openOverlay, { item, workspaceId: props.workspaceId });
  };
  const runRef = useRef(run);
  // How tall the embedded box is now, so the list under it takes the rest of the panel.
  const [editorHeight, setEditorHeight] = useState(0);
  const ListScroll = props.layout.compact ? View : HostScrollView;
  runRef.current = run;

  const openAgent = useCallback(
    (view: WorkItemView) => {
      const agentId = view.aggregate.activeAgentIds[0] ?? view.links[0]?.agentId;
      if (!agentId || !props.navigation) return;
      props.close();
      props.navigation.openAgent({ agentId });
    },
    [props],
  );

  if (state.status !== "ready" || !project) {
    return (
      <View style={{ padding: 12 }}>
        <Text style={styles.muted}>{state.status === "ready" ? "Workspace unavailable." : "Loading Todo…"}</Text>
      </View>
    );
  }
  return (
    <View style={{ gap: 6, paddingVertical: 8 }}>
      {/* Hosts with overlays drop the phone sheet's title row; this small print says whose list it is. */}
      {props.layout.compact && openOverlay ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12, paddingBottom: 2 }}>
          <Text style={styles.metaText}>Todo ·</Text>
          <Icon name="Folder" size={11} color={theme.colors.foregroundMuted} />
          <Text style={[styles.metaText, { flexShrink: 1 }]} numberOfLines={1}>
            {project.projectDisplayName}
          </Text>
        </View>
      ) : null}
      <View style={{ paddingHorizontal: 10 }} onLayout={(event) => setEditorHeight(event.nativeEvent.layout.height)}>
        <EmbeddedNewItem
          styles={styles}
          theme={theme}
          phone={props.layout.compact}
          project={project}
          onSubmit={add}
        />
      </View>
      {/* On wide layouts the list scrolls under the box, which stays in view; the host caps the
          popover's height. A phone sheet scrolls its body itself, and a second vertical scroller
          inside it would fight the sheet's drag. */}
      <ListScroll {...(props.layout.compact ? {} : { style: { maxHeight: Math.max(140, PANEL_MAX_HEIGHT - editorHeight) } })}>
        {contents.groups.length === 0 ? (
          <Text style={[styles.muted, { paddingHorizontal: 12, paddingVertical: 10 }]}>Nothing written down for this project yet.</Text>
        ) : null}
        {contents.groups.map((group) => (
          <View key={group.status} style={{ paddingTop: 6 }}>
            <GroupHeader styles={styles} theme={theme} status={group.status} count={group.views.length + group.overflow} />
            {group.views.map((view) => (
              <PanelRow
                key={view.item.id}
                styles={styles}
                theme={theme}
                view={view}
                onPress={() => openAgent(view)}
                onRun={group.status === "todo" ? () => run(view.item) : undefined}
              />
            ))}
            {group.overflow > 0 ? (
              <Text style={[styles.metaText, { paddingHorizontal: 12, paddingBottom: 4 }]}>{`+${group.overflow} more on the board`}</Text>
            ) : null}
          </View>
        ))}
      </ListScroll>
      {contents.backlogCount > 0 || openSurface ? (
        <View style={{ flexDirection: "row", alignItems: "center", borderTopWidth: 1, borderTopColor: theme.colors.border, marginHorizontal: 10, paddingTop: 6, paddingHorizontal: 2 }}>
          <Text style={[styles.metaText, { flex: 1 }]}>{contents.backlogCount > 0 ? `${contents.backlogCount} in Backlog` : ""}</Text>
          {openSurface ? (
            <TextAction
              theme={theme}
              small
              kind="ghost"
              label="Open board ›"
              onPress={() => {
                props.close();
                openSurface("todo");
              }}
            />
          ) : null}
        </View>
      ) : null}
      {/* Hosts without `openOverlay` run from here, in the host's own dialog. */}
      <ExecuteModal
        styles={styles}
        theme={theme}
        item={execute}
        onClose={() => setExecute(null)}
        project={execute ? projectCache.projects.get(execute.projectId) : undefined}
        defaultWorkspaceId={props.workspaceId}
        canOpenComposer={capability.available}
        onSubmit={async (input: ExecuteSubmit) => {
          if (!execute) return false;
          const started = await launcher.launch(execute, input);
          // A direct run navigates to its agent, so the panel must not stay open on top of it.
          if (started) props.close();
          return started;
        }}
      />
    </View>
  );
}

function GroupHeader(props: { styles: TodoStyles; theme: PluginButtonContentProps["theme"]; status: WorkItemStatus; count: number }) {
  const presentation = STATUS_PRESENTATION[props.status];
  return (
    <View style={[props.styles.row, { paddingHorizontal: 12, paddingBottom: 2, gap: 6 }]}>
      <Icon name={presentation.icon} size={11} color={props.theme.colors[presentation.color]} />
      <Text style={[props.styles.metaText, { flex: 1, fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.4 }]}>
        {`${WORK_ITEM_STATUS_LABELS[props.status]} · ${props.count}`}
      </Text>
    </View>
  );
}
