import type { PluginButtonContentProps, PluginButtonIconProps } from "@getpaseo/plugin/client";
import { usePaseo, useWorkspace } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useCallback, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { WORK_ITEM_STATUS_LABELS } from "../shared/board";
import type { WorkItemStatus } from "../shared/schema";
import { Button } from "./components";
import { useTodoDocument, useWorkItemViews, type WorkItemView } from "./data";
import { ExecuteModal, type ExecuteSubmit } from "./execute-modal";
import { useTodoImageStore } from "./images";
import { resolveDraftIdentity, type DraftIdentity } from "./identity";
import { resolveLaunchCapability } from "./launch-guard";
import { useProjectCache } from "./projects";
import { parseQuickAdd } from "./quick-add";
import { useSidebarBadge } from "./sidebar-badge";
import { buildPanelContents, needsYou, summarizeProject } from "./summary";
import { useTodoStyles, type TodoStyles } from "./styles";
import { AGGREGATE_PRESENTATION, PRIORITY_PRESENTATION, STATUS_PRESENTATION } from "./text";
import { initiatorLabel, useLaunchWorkItem } from "./use-launch";
import { useTodoActions } from "./use-todo-actions";

/** The project a workspace belongs to; every panel is that project's, never the whole host. */
function useWorkspaceProject(workspaceId: string): { projectId: string; projectDisplayName: string } | null {
  return (
    useWorkspace(workspaceId, (snapshot) => ({
      projectId: snapshot.projectId,
      projectDisplayName: snapshot.projectDisplayName,
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

function QuickAdd(props: {
  styles: TodoStyles;
  placeholder: string;
  busy: boolean;
  onSubmit: (text: string) => void;
  theme: PluginButtonContentProps["theme"];
}) {
  const [text, setText] = useState("");
  const submit = () => {
    if (props.busy || parseQuickAdd(text).title.length === 0) return;
    props.onSubmit(text);
    setText("");
  };
  return (
    <View style={{ gap: 4 }}>
      <TextInput
        value={text}
        onChangeText={setText}
        onSubmitEditing={submit}
        placeholder={props.placeholder}
        placeholderTextColor={props.theme.colors.foregroundMuted}
        autoFocus
        blurOnSubmit={false}
        editable={!props.busy}
        style={[props.styles.input, { minHeight: 36 }]}
      />
      <Text style={[props.styles.mono, { fontSize: 11 }]}>Enter adds it · !1–!4 sets priority</Text>
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
    <View style={[styles.listRow, { gap: 8 }]}>
      <Pressable
        onPress={props.onPress}
        accessibilityRole="button"
        accessibilityLabel={`#${view.item.number} ${view.item.title}`}
        style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 8 }}
      >
        <Icon name={priority.icon} size={14} color={theme.colors[priority.color]} />
        <Text style={[styles.metaText, { minWidth: 24 }]}>{`#${view.item.number}`}</Text>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text numberOfLines={1} style={styles.body}>
            {view.item.title}
          </Text>
          {view.aggregate.state === "idle" ? null : (
            <Text numberOfLines={1} style={styles.metaText}>
              {aggregate.label}
            </Text>
          )}
        </View>
      </Pressable>
      {props.onRun ? (
        <Button styles={styles} theme={theme} label="Run" icon="Play" variant="primary" onPress={props.onRun} />
      ) : null}
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
  const [busy, setBusy] = useState(false);
  const [execute, setExecute] = useState<WorkItemView | null>(null);
  const draft = useRef<DraftIdentity | null>(null);
  const paseo = usePaseo();
  const projectCache = useProjectCache(paseo);
  const imageStore = useTodoImageStore();
  const capability = resolveLaunchCapability(props.navigation);
  const launcher = useLaunchWorkItem({
    paseo,
    actions,
    incarnationId,
    reload,
    initiatorLabel: initiatorLabel(props.layout.platform, props.host.label),
    capability,
    openAgent: props.navigation?.openAgent,
    resolveImages: (refs) => imageStore.resolve(refs).map((image) => ({ data: image.data, mimeType: image.mimeType })),
  });
  const contents = useMemo(
    () => buildPanelContents(views.values(), project?.projectId ?? null),
    [views, project?.projectId],
  );

  const add = useCallback(
    async (text: string) => {
      if (!project) return;
      const parsed = parseQuickAdd(text);
      setBusy(true);
      try {
        const request = {
          projectId: project.projectId,
          projectNameSnapshot: project.projectDisplayName,
          title: parsed.title,
          details: parsed.details,
          defaultPrompt: "",
          status: "todo" as const,
          priority: parsed.priority,
        };
        const identity = resolveDraftIdentity(draft.current, request);
        draft.current = identity;
        const created = await actions.create(request, identity.identity);
        if (created) draft.current = null;
      } finally {
        setBusy(false);
      }
    },
    [actions, project],
  );

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
    <View style={{ gap: 8, paddingVertical: 8 }}>
      <View style={{ paddingHorizontal: 10 }}>
        <QuickAdd
          styles={styles}
          theme={theme}
          busy={busy}
          placeholder={`Add a todo to ${project.projectDisplayName}…`}
          onSubmit={(text) => void add(text)}
        />
      </View>
      <ScrollView style={{ maxHeight: 260 }}>
        {contents.groups.length === 0 ? (
          <Text style={[styles.muted, { paddingHorizontal: 12, paddingVertical: 8 }]}>
            Nothing written down for this project yet.
          </Text>
        ) : null}
        {contents.groups.map((group) => (
          <View key={group.status} style={{ paddingTop: 4 }}>
            <GroupHeader styles={styles} theme={theme} status={group.status} count={group.views.length + group.overflow} />
            {group.views.map((view) => (
              <PanelRow
                key={view.item.id}
                styles={styles}
                theme={theme}
                view={view}
                onPress={() => openAgent(view)}
                onRun={group.status === "todo" ? () => setExecute(view) : undefined}
              />
            ))}
            {group.overflow > 0 ? (
              <Text style={[styles.metaText, { paddingHorizontal: 12, paddingBottom: 4 }]}>{`+${group.overflow} more on the board`}</Text>
            ) : null}
          </View>
        ))}
      </ScrollView>
      {contents.backlogCount > 0 ? (
        <Text style={[styles.metaText, { paddingHorizontal: 12 }]}>{`${contents.backlogCount} in Backlog`}</Text>
      ) : null}
      <ExecuteModal
        styles={styles}
        theme={theme}
        open={execute !== null}
        onOpenChange={(open) => !open && setExecute(null)}
        item={execute?.item ?? null}
        project={execute ? projectCache.projects.get(execute.item.projectId) : undefined}
        defaultWorkspaceId={props.workspaceId}
        canOpenComposer={capability.available}
        onSubmit={async (input: ExecuteSubmit) => {
          if (!execute) return false;
          const started = await launcher.launch(execute.item, input);
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
      <Icon name={presentation.icon} size={12} color={props.theme.colors[presentation.color]} />
      <Text style={[props.styles.metaText, { flex: 1, textTransform: "uppercase", letterSpacing: 0.4 }]}>
        {WORK_ITEM_STATUS_LABELS[props.status]}
      </Text>
      <Text style={props.styles.metaText}>{props.count}</Text>
    </View>
  );
}
