import type { PluginTheme } from "@getpaseo/plugin";
import { usePaseo, useRpc, useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { FlatList, Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import {
  WORK_ITEM_STATUS_LABELS,
  boardLayout,
  buildBoard,
  columnAddAction,
  resolveInProgressIntent,
  type BoardFilter,
} from "../shared/board";
import { canResumeAttempt } from "../shared/attempt";
import { documentStatus } from "../shared/contracts";
import { todoPrefs } from "../shared/prefs";
import type { Attempt, TodoDocument, WorkItem, WorkItemStatus } from "../shared/schema";
import { aggregateWorkItem } from "../shared/state";
import { TodoBoard, resolveActiveTab, type RenderCard } from "./board";
import { BoardCard } from "./board-card";
import { BoardToolbar, ProjectPicker, type ProjectOption } from "./board-toolbar";
import { CardDetail, type CardActions } from "./card-detail";
import { CardPicker, type PickRequest } from "./card-picker";
import { Button, ConfirmModal, Notice } from "./components";
import { ContinueModal, type StartRequest } from "./continue-modal";
import { useTodoDocument, useWorkItemViews, type WorkItemView } from "./data";
import { ExecuteModal, type ExecuteSubmit } from "./execute-modal";
import { sendFollowUp } from "./follow-up";
import { openForAttempt } from "./launch";
import { resolveLaunchCapability } from "./launch-guard";
import { MoveMenu } from "./move-menu";
import { useProjectCache } from "./projects";
import { resolveDraftIdentity, type DraftIdentity } from "./identity";
import { RecoveryScreen } from "./recovery";
import { useSidebarBadge } from "./sidebar-badge";
import { needsYou } from "./summary";
import { useTodoStyles } from "./styles";
import { TEXT } from "./text";
import { initiatorLabel, useLaunchWorkItem } from "./use-launch";
import { useTodoActions } from "./use-todo-actions";
import { RebindModal, WorkItemEditor, type StartingStatus } from "./work-item-editor";

type Navigation = PluginSurfaceProps["navigation"];

/** Re-renders on an interval so relative times ("5 min ago") stay current. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** Shared body for the global surface and the workspace panel. */
export function TodoScreen(props: {
  theme: PluginTheme;
  compact: boolean;
  platform: string;
  host: { id: string; label: string };
  navigation: Navigation;
  projectFilter: string | null;
  /** The workspace panel's project name, shown before the project list has loaded. */
  projectFilterName: string | null;
  defaultWorkspaceId: string | null;
}) {
  const { theme, compact } = props;
  const styles = useTodoStyles(theme, compact);
  const state = useTodoDocument();
  if (state.status === "loading") {
    return (
      <View style={styles.screen}>
        <Text style={styles.muted}>Loading Todo…</Text>
      </View>
    );
  }
  if (state.status === "error") {
    return (
      <View style={styles.screen}>
        <Notice styles={styles} theme={theme} kind="danger" title="Todo is unavailable">
          {state.error}
        </Notice>
        <Button styles={styles} theme={theme} label="Reload" icon="RefreshCw" onPress={() => void state.reload()} />
      </View>
    );
  }
  if (state.status === "invalid") {
    return <RecoveryScreen styles={styles} theme={theme} error={state.error} revision={state.revision} reload={state.reload} onReset={state.reload} />;
  }
  return <TodoReady {...props} styles={styles} todo={state.todo} reload={state.reload} />;
}

function TodoReady(props: {
  theme: PluginTheme;
  compact: boolean;
  platform: string;
  host: { id: string; label: string };
  navigation: Navigation;
  projectFilter: string | null;
  /** The workspace panel's project name, shown before the project list has loaded. */
  projectFilterName: string | null;
  defaultWorkspaceId: string | null;
  styles: ReturnType<typeof useTodoStyles>;
  todo: TodoDocument;
  reload: () => Promise<void>;
}) {
  const { theme, styles, todo, reload } = props;
  const paseo = usePaseo();
  const toast = useToast();
  const now = useNow(60_000);
  const prefs = useSettings(todoPrefs);
  const projectCache = useProjectCache(paseo);
  const views = useWorkItemViews(todo);
  // Any open Todo surface keeps the sidebar count fresh, not just a workspace header glyph.
  useSidebarBadge(useMemo(() => [...views.values()].filter(needsYou).length, [views]));
  const actions = useTodoActions({ incarnationId: todo.incarnationId, reload });
  const capability = resolveLaunchCapability(props.navigation);
  const launcher = useLaunchWorkItem({
    paseo,
    actions,
    incarnationId: todo.incarnationId,
    reload,
    initiatorLabel: initiatorLabel(props.platform, props.host.label),
    capability,
    openAgent: props.navigation?.openAgent,
  });
  const status = useRpc(documentStatus);
  const health = useQuery({ queryKey: ["todo", "status", props.host.id], queryFn: () => status({}), refetchInterval: 60_000 });
  const [filter, setFilter] = useState<BoardFilter>("active");
  const [query, setQuery] = useState("");
  const [pickedProjectId, setPickedProjectId] = useState<string | null>(null);
  const [pickingProject, setPickingProject] = useState(false);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [tab, setTab] = useState<WorkItemStatus | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ open: boolean; view: WorkItemView | null; status: StartingStatus }>({ open: false, view: null, status: "todo" });
  const [pick, setPick] = useState<PickRequest | null>(null);
  const [rebind, setRebind] = useState<WorkItemView | null>(null);
  // `moveOnSubmit`: opened by moving the card into In progress, which happens once the user confirms.
  const [execute, setExecute] = useState<{ view: WorkItemView; retryAnyway: boolean; moveOnSubmit?: boolean } | null>(null);
  const [start, setStart] = useState<StartRequest | null>(null);
  const [confirm, setConfirm] = useState<{ title: string; message: string; label: string; requireDouble: boolean; run: () => Promise<unknown> } | null>(null);
  const [armed, setArmed] = useState(false);
  const [checking, setChecking] = useState<string | null>(null);
  // Kept across submissions so a retry after a lost reply recreates nothing; cleared once created.
  const draftIdentity = useRef<DraftIdentity | null>(null);

  // An empty incarnation means the todo is fresh or was just reset: initialize it explicitly.
  useEffect(() => {
    if (todo.incarnationId) return;
    void actions.ensure().then(() => reload());
  }, [todo.incarnationId, actions, reload]);

  // Projects Paseo knows, plus projects that only survive in Todo items. While the project list is
  // still loading nothing is marked unavailable.
  const projectOptions = useMemo<ProjectOption[]>(() => {
    const ready = projectCache.status === "ready";
    const options = new Map<string, ProjectOption>();
    for (const project of projectCache.projects.values()) {
      options.set(project.projectId, { value: project.projectId, label: project.projectDisplayName, hint: project.projectRootPath, available: true });
    }
    for (const { item } of views.values()) {
      if (options.has(item.projectId)) continue;
      options.set(item.projectId, {
        value: item.projectId,
        label: ready ? `Unavailable · ${item.projectNameSnapshot}` : item.projectNameSnapshot,
        ...(item.projectRootSnapshot ? { hint: item.projectRootSnapshot } : {}),
        available: !ready,
      });
    }
    const counts = new Map<string, number>();
    for (const { item } of views.values()) if (!item.archivedAt) counts.set(item.projectId, (counts.get(item.projectId) ?? 0) + 1);
    const sorted = [...options.values()]
      .sort((left, right) => Number(right.available) - Number(left.available) || left.label.localeCompare(right.label))
      .map((option) => ({ ...option, hint: `${counts.get(option.value) ?? 0} open · ${option.hint ?? ""}` }));
    const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
    return [{ value: "", label: "All projects", hint: `${total} open`, available: true }, ...sorted];
  }, [projectCache, views]);
  // The global board shows every project unless a filter is saved; "" in prefs means all of them.
  const savedProjectId = prefs.status === "ready" ? prefs.values.boardProjectId : "";
  const chosenProjectId = pickedProjectId ?? savedProjectId;
  const projectId: string | null =
    props.projectFilter ?? (chosenProjectId && projectOptions.some((option) => option.value === chosenProjectId) ? chosenProjectId : null);
  const projectLabel = projectOptions.find((option) => option.value === (projectId ?? ""))?.label ?? props.projectFilterName ?? "All projects";
  const isProjectAvailable = (id: string) => projectCache.status !== "ready" || projectCache.projects.has(id);
  const noProjects = projectCache.status === "ready" && projectOptions.length === 1;
  const canCreate = projectCache.status === "ready" && projectCache.projects.size > 0 && (projectId === null || isProjectAvailable(projectId));

  const board = useMemo(() => buildBoard(views.values(), { projectId, filter, query }), [views, projectId, filter, query]);
  const detailView = detailId ? (views.get(detailId) ?? null) : null;
  const menuView = menuId ? (views.get(menuId) ?? null) : null;

  function pickProject(id: string) {
    setPickedProjectId(id);
    if (prefs.status === "ready" && prefs.values.boardProjectId !== id) {
      void prefs.save({ ...prefs.values, boardProjectId: id }, prefs.revision);
    }
  }

  const moveCard = useCallback(
    async (view: WorkItemView, next: WorkItemStatus) => {
      const result = await actions.move(view.item, next);
      if (result && result.previousStatus !== view.item.status) {
        toast.show(`#${view.item.number} had already moved to ${WORK_ITEM_STATUS_LABELS[result.previousStatus]}.`, { variant: "info" });
      }
    },
    [actions, toast],
  );

  /**
   * Every manual move goes through here. Moving into In progress also gets an agent working: the
   * card only moves right away when an agent is already running or a launch is in flight;
   * otherwise a dialog asks to continue an agent, answer its approval, or start a new run, and the
   * card moves when the user confirms.
   */
  const requestMove = useCallback(
    (view: WorkItemView, next: WorkItemStatus) => {
      if (next !== "in_progress" || view.item.status === "in_progress") {
        void moveCard(view, next);
        return;
      }
      const intent = resolveInProgressIntent(view);
      if (intent.kind === "move_only") {
        void moveCard(view, next);
        toast.show(
          intent.reason === "agent_active" ? "An agent is already running, so nothing new was started." : "A launch is still in flight, so nothing new was started.",
          { variant: "info" },
        );
        return;
      }
      if (intent.kind === "execute") {
        setExecute({ view, retryAnyway: false, moveOnSubmit: true });
        return;
      }
      setStart({ viewId: view.item.id, intent, move: true });
    },
    [moveCard, toast],
  );

  /**
   * A column's "+": Backlog and To do create a card there; In progress and Done pull existing cards
   * in, from every matching card under the current project filter and search.
   */
  function addToColumn(status: WorkItemStatus) {
    const action = columnAddAction(status);
    if (!action) return;
    if (action.kind === "create") {
      openEditor(status as StartingStatus);
      return;
    }
    const everything = buildBoard(views.values(), { projectId, filter: "all", query });
    const groups = action.sources.map((source) => everything.columns.find((column) => column.status === source) ?? { status: source, views: [] });
    setPick({ target: status, groups, multiple: action.multiple });
  }

  async function confirmPick(target: WorkItemStatus, picked: WorkItemView[]) {
    setPick(null);
    if (target === "in_progress") {
      // One card; the move opens the execute or continue dialog once the picker has closed.
      if (picked[0]) requestMove(picked[0], "in_progress");
      return;
    }
    let moved = 0;
    for (const view of picked) if (await actions.move(view.item, target)) moved += 1;
    if (moved > 0) toast.show(`Marked ${moved} ${moved === 1 ? "card" : "cards"} ${WORK_ITEM_STATUS_LABELS[target]}.`, { variant: "success" });
  }

  const runCheck = useCallback(
    async (view: WorkItemView) => {
      setChecking(view.item.id);
      try {
        const summary = await actions.check(view.item.id);
        if (!summary) return;
        toast.show(
          summary.checkedAgentCount === 0
            ? "No agent is linked to this item yet."
            : `Re-checked ${summary.checkedAgentCount} agent${summary.checkedAgentCount === 1 ? "" : "s"}.`,
          { variant: "info" },
        );
      } finally {
        setChecking(null);
      }
    },
    [actions, toast],
  );

  const cardActions = useMemo<CardActions>(
    () => ({
      execute: (view) => setExecute({ view, retryAnyway: false }),
      retryAnyway: (view) =>
        setConfirm({
          title: "Retry anyway?",
          message: TEXT.retryAnywayWarning,
          label: "Abandon and start a new attempt",
          requireDouble: true,
          run: async () => {
            const pending = view.claim?.state === "pending" ? view.claim : null;
            if (pending) {
              const ok = await actions.abandon({ workItemId: view.item.id, attemptId: pending.attemptId, generation: pending.generation, certainty: "outcome_unknown_confirmed" });
              if (!ok) return;
            }
            setExecute({ view, retryAnyway: true });
          },
        }),
      resume: (view, attempt) => {
        if (!capability.available || !view.claim || !canResumeAttempt(attempt)) return;
        void openForAttempt({
          attempt,
          claim: view.claim,
          incarnationId: todo.incarnationId,
          target: attempt.workspaceIdHint ? { kind: "existing", workspaceId: attempt.workspaceIdHint } : { kind: "new" },
          rpcs: actions.launchRpcs,
          openAgentLaunch: capability.openAgentLaunch,
          onChange: () => void reload(),
          ...(attempt.initiatorClientInstanceId ? { expectedClientInstanceId: attempt.initiatorClientInstanceId } : {}),
        }).then(launcher.describeResult);
      },
      abandon: (view, attempt: Attempt, certainty) => {
        // The attempt's own claim generation, so history entries stay actionable after a newer
        // attempt has taken the claim.
        const run = () => actions.abandon({ workItemId: view.item.id, attemptId: attempt.id, generation: attempt.claimGeneration, certainty });
        if (certainty === "not_submitted") {
          void run();
          return;
        }
        setConfirm({ title: "Abandon unknown outcome?", message: TEXT.unknownNotice, label: "Abandon", requireDouble: false, run });
      },
      forget: (view, attempt) =>
        setConfirm({
          title: "Remove this attempt?",
          message: TEXT.forgetAttemptWarning,
          label: "Remove from history",
          requireDouble: false,
          run: () => actions.forget({ workItemId: view.item.id, attemptId: attempt.id }),
        }),
      check: (view) => void runCheck(view),
      // The column only matters when creating; an edit keeps the card where it is.
      edit: (view) => setEditor({ open: true, view, status: "todo" }),
      move: (view, next) => requestMove(view, next),
      continueAgent: (view) => {
        const intent = resolveInProgressIntent(view);
        if (intent.kind === "continue") setStart({ viewId: view.item.id, intent, move: view.item.status !== "in_progress" });
      },
      setPriority: (view, priority) => void actions.update(view.item, { priority }),
      setArchived: (view, archived) => void actions.setArchived(view.item, archived),
      purge: (view) => {
        const force = view.attempts.some((attempt) => attempt.userDisposition === "abandoned") && view.aggregate.unknownAttemptIds.length > 0;
        setConfirm({
          title: "Purge work item?",
          message: force ? `${TEXT.purgeWarning}\n\n${TEXT.forcePurgeWarning}` : TEXT.purgeWarning,
          label: force ? "Force purge" : "Purge",
          requireDouble: true,
          run: () => actions.purge(view.item, force),
        });
      },
      rebind: (view) => setRebind(view),
      openAgent: props.navigation ? (agentId) => props.navigation?.openAgent({ agentId }) : null,
      openWorkspace: props.navigation ? (workspaceId) => props.navigation?.openWorkspace({ workspaceId }) : null,
      checkingId: checking,
    }),
    [actions, capability, checking, todo.incarnationId, launcher, requestMove, props.navigation, reload, runCheck],
  );

  // The detail dialog closes before anything that opens another dialog or leaves the board, so
  // two sheets are never stacked.
  const detailActions = useMemo<CardActions>(() => {
    const closing =
      <Args extends unknown[]>(run: (...args: Args) => void) =>
      (...args: Args) => {
        setDetailId(null);
        run(...args);
      };
    return {
      ...cardActions,
      move: (view, next) => {
        // Moving into In progress may open the continue or execute dialog; close the detail first.
        const opensDialog = next === "in_progress" && view.item.status !== "in_progress" && resolveInProgressIntent(view).kind !== "move_only";
        if (opensDialog) setDetailId(null);
        cardActions.move(view, next);
      },
      execute: closing(cardActions.execute),
      resume: closing(cardActions.resume),
      retryAnyway: closing(cardActions.retryAnyway),
      abandon: closing(cardActions.abandon),
      forget: closing(cardActions.forget),
      edit: closing(cardActions.edit),
      continueAgent: closing(cardActions.continueAgent),
      purge: closing(cardActions.purge),
      rebind: closing(cardActions.rebind),
      openAgent: cardActions.openAgent ? closing(cardActions.openAgent) : null,
      openWorkspace: cardActions.openWorkspace ? closing(cardActions.openWorkspace) : null,
    };
  }, [cardActions]);

  async function submitExecute(input: ExecuteSubmit): Promise<boolean> {
    if (!execute) return false;
    let item = execute.view.item;
    if (execute.moveOnSubmit && item.status !== "in_progress") {
      // The user moved the card here and confirmed; it stays in In progress even if the launch fails.
      const moved = await actions.move(item, "in_progress");
      if (!moved) return false;
      item = { ...item, status: "in_progress" };
    }
    return launcher.launch(item, input);
  }

  function openEditor(next: StartingStatus) {
    if (!canCreate) {
      toast.show(projectCache.status === "ready" && projectId !== null ? "This project is unavailable. Rebind its items first." : "Projects are still loading.", { variant: "info" });
      return;
    }
    setEditor({ open: true, view: null, status: next });
  }

  /** "Create and execute": the new card has no claim or agents yet, so its view is built directly. */
  function executeNewItem(item: WorkItem) {
    setExecute({ view: { item, claim: undefined, attempts: [], links: [], aggregate: aggregateWorkItem({ claim: undefined, attempts: [], links: [] }) }, retryAnyway: false });
  }

  const card = (view: WorkItemView, options: { dragHandle?: ReactNode; placeholder?: boolean; showStatus?: boolean }) => (
    <BoardCard
      styles={styles}
      theme={theme}
      view={view}
      now={now}
      showStatus={options.showStatus ?? false}
      showProject={projectId === null}
      dragHandle={options.dragHandle}
      placeholder={options.placeholder ?? false}
      onOpen={(entry) => setDetailId(entry.item.id)}
      // An archived card has nothing to move; its menu is the detail with Restore and Purge.
      onMenu={(entry) => (entry.item.archivedAt ? setDetailId(entry.item.id) : setMenuId(entry.item.id))}
      onOpenAgent={cardActions.openAgent}
    />
  );

  const renderCard: RenderCard = (view, dragHandle, placeholder) => card(view, { dragHandle, placeholder: placeholder ?? false });

  // Before the first layout pass, guess from the host layout instead of flashing tabs.
  const boardWidth = size.width || (props.compact ? 0 : Number.MAX_SAFE_INTEGER);
  const phoneBoard = filter !== "archived" && boardLayout(boardWidth, board.columns.length, styles.gap) === "tabs";
  // Phones and tablets pull to refresh; elsewhere the toolbar keeps its Reload button.
  const refresh =
    props.platform === "ios" || props.platform === "android"
      ? {
          refreshing,
          onRefresh: () => {
            setRefreshing(true);
            void reload().finally(() => setRefreshing(false));
          },
        }
      : undefined;

  const degraded = health.data && health.data.status === "ok" ? health.data.degraded : null;
  return (
    <View style={styles.page}>
      <BoardToolbar
        styles={styles}
        theme={theme}
        compact={props.compact}
        projectLabel={projectLabel}
        projectFiltered={projectId !== null}
        onPickProject={props.projectFilter ? null : () => setPickingProject(true)}
        filter={filter}
        onFilter={setFilter}
        query={query}
        onQuery={setQuery}
        // Phones pull to refresh, except on the empty state, which has no list to pull.
        onReload={refresh && props.compact && !noProjects ? null : () => void reload()}
        // New creates in the column a phone board shows, when that column takes new cards.
        onCreate={() => openEditor(phoneBoard && resolveActiveTab(board.columns, tab)?.status === "backlog" ? "backlog" : "todo")}
        canCreate={canCreate}
      />
      {degraded ? (
        <Notice styles={styles} theme={theme} kind="warning" title="Daemon-side reconciliation is degraded">
          {`${degraded.reason} since ${degraded.since}. Status may be stale until the plugin recovers or is reloaded.`}
        </Notice>
      ) : null}
      {projectCache.status === "error" ? <Notice styles={styles} theme={theme} kind="warning">{projectCache.error ?? "Projects unavailable."}</Notice> : null}
      {projectId && !isProjectAvailable(projectId) ? (
        <Notice styles={styles} theme={theme} kind="warning" title="Project unavailable">
          {`${TEXT.rebindNotice} Open a card and choose Rebind project.`}
        </Notice>
      ) : null}
      {/* The board takes whatever height is left and scrolls inside its columns, never the page. */}
      <View style={styles.board} onLayout={(event) => setSize({ width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height })}>
        {noProjects ? (
          <EmptyState styles={styles} theme={theme} icon="FolderOpen" title="No projects yet" message="Open a project in Paseo to start the board." />
        ) : filter === "archived" ? (
          <FlatList
            data={board.archived}
            keyExtractor={(view) => view.item.id}
            style={{ flex: 1 }}
            contentContainerStyle={{ gap: 8, maxWidth: 640, paddingBottom: 16 }}
            renderItem={({ item: view }) => card(view, { showStatus: true })}
            {...(refresh ?? {})}
            ListEmptyComponent={<EmptyState styles={styles} theme={theme} icon="Archive" title="Nothing archived" message="Archived cards are hidden from the board until restored." />}
          />
        ) : (
          <TodoBoard
            styles={styles}
            theme={theme}
            columns={board.columns}
            width={boardWidth}
            height={size.height}
            renderCard={renderCard}
            onAdd={addToColumn}
            onDrop={(view, status) => requestMove(view, status)}
            tab={tab}
            onTab={setTab}
            {...(refresh ? { refresh } : {})}
          />
        )}
      </View>
      <WorkItemEditor
        styles={styles}
        theme={theme}
        open={editor.open}
        onOpenChange={(open) => setEditor((current) => ({ ...current, open }))}
        projects={projectCache.projects}
        // A filtered board creates in its project; the full board asks, unless only one project exists.
        initialProjectId={projectId !== null && isProjectAvailable(projectId) ? projectId : projectCache.projects.size === 1 ? ([...projectCache.projects.keys()][0] ?? null) : null}
        initialStatus={editor.status}
        item={editor.view?.item ?? null}
        onSubmit={async ({ execute: andExecute, ...input }) => {
          if (editor.view) {
            return actions.update(editor.view.item, { title: input.title, details: input.details, defaultPrompt: input.defaultPrompt, priority: input.priority });
          }
          const draft = resolveDraftIdentity(draftIdentity.current, input);
          draftIdentity.current = draft;
          const created = await actions.create(input, draft.identity);
          if (!created) return false;
          draftIdentity.current = null;
          if (andExecute) executeNewItem(created);
          return true;
        }}
      />
      <RebindModal
        styles={styles}
        theme={theme}
        open={rebind !== null}
        onOpenChange={(open) => !open && setRebind(null)}
        projects={projectCache.projects}
        item={rebind?.item ?? null}
        onSubmit={(project) => (rebind ? actions.rebind(rebind.item, project) : Promise.resolve(false))}
      />
      <ExecuteModal
        styles={styles}
        theme={theme}
        open={execute !== null}
        onOpenChange={(open) => !open && setExecute(null)}
        item={execute?.view.item ?? null}
        project={execute ? projectCache.projects.get(execute.view.item.projectId) : undefined}
        defaultWorkspaceId={props.defaultWorkspaceId}
        canOpenComposer={capability.available}
        onSubmit={submitExecute}
        {...(execute?.moveOnSubmit
          ? {
              onMoveOnly: () => {
                const current = execute;
                setExecute(null);
                void moveCard(current.view, "in_progress");
              },
            }
          : {})}
      />
      <ContinueModal
        styles={styles}
        theme={theme}
        request={start}
        view={start ? (views.get(start.viewId) ?? null) : null}
        onClose={() => setStart(null)}
        onMoveOnly={(view) => {
          setStart(null);
          void moveCard(view, "in_progress");
        }}
        onOpenAgent={
          props.navigation
            ? (view, agentId) => {
                const current = start;
                setStart(null);
                if (current?.move && view.item.status !== "in_progress") void moveCard(view, "in_progress");
                props.navigation?.openAgent({ agentId });
              }
            : null
        }
        onExecuteInstead={(view) => {
          const current = start;
          setStart(null);
          setExecute({ view, retryAnyway: false, ...(current?.move ? { moveOnSubmit: true } : {}) });
        }}
        onSend={async ({ view, agentId, text, messageId }) => {
          if (start?.move && view.item.status !== "in_progress") {
            const moved = await actions.move(view.item, "in_progress");
            if (!moved) return null;
          }
          const result = await sendFollowUp({ paseo, agentId, text, messageId });
          await reload();
          if (result.status === "sent") {
            setStart(null);
            toast.show("Message sent. The card follows the agent.", { variant: "success" });
          }
          return result;
        }}
        onCheck={runCheck}
      />
      <ProjectPicker
        styles={styles}
        theme={theme}
        open={pickingProject}
        onOpenChange={setPickingProject}
        options={projectOptions}
        value={projectId ?? ""}
        onChange={pickProject}
      />
      <CardPicker
        styles={styles}
        theme={theme}
        request={pick}
        showProject={projectId === null}
        onClose={() => setPick(null)}
        onConfirm={(target, picked) => void confirmPick(target, picked)}
      />
      <MoveMenu
        styles={styles}
        theme={theme}
        view={menuView}
        onClose={() => setMenuId(null)}
        onMove={(view, next) => requestMove(view, next)}
        onOpenDetails={(view) => {
          setMenuId(null);
          setDetailId(view.item.id);
        }}
      />
      <CardDetail
        styles={styles}
        theme={theme}
        view={detailView}
        onClose={() => setDetailId(null)}
        actions={detailActions}
        canLaunch={capability.available}
        projectAvailable={detailView ? isProjectAvailable(detailView.item.projectId) : true}
        now={now}
      />
      <ConfirmModal
        styles={styles}
        theme={theme}
        open={confirm !== null}
        title={confirm?.title ?? ""}
        message={confirm?.message ?? ""}
        confirmLabel={confirm?.label ?? "Confirm"}
        danger
        requireDouble={confirm?.requireDouble ?? false}
        armed={armed}
        onArm={() => setArmed(true)}
        onOpenChange={(open) => {
          if (!open) {
            setConfirm(null);
            setArmed(false);
          }
        }}
        onConfirm={() => {
          const current = confirm;
          setConfirm(null);
          setArmed(false);
          if (current) void current.run();
        }}
      />
    </View>
  );
}

function EmptyState(props: { styles: ReturnType<typeof useTodoStyles>; theme: PluginTheme; icon: string; title: string; message: string }) {
  const { styles, theme } = props;
  return (
    <View style={{ alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 48, paddingHorizontal: 16 }}>
      <Icon name={props.icon} size={28} color={theme.colors.foregroundMuted} />
      <Text style={[styles.body, { fontWeight: "600" }]}>{props.title}</Text>
      <Text style={[styles.muted, { textAlign: "center" }]}>{props.message}</Text>
    </View>
  );
}
