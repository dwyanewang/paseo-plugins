import type { PluginTheme } from "@getpaseo/plugin";
import { usePaseo, useRpc, useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { ScrollView, useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { BOARD_COLUMN_WIDTH, WORK_ITEM_STATUS_LABELS, buildBoard, neighboursAt, type BoardFilter } from "../shared/board";
import { documentStatus } from "../shared/contracts";
import { todoPrefs } from "../shared/prefs";
import type { Attempt, TodoDocument, WorkItemStatus } from "../shared/schema";
import { TodoBoard } from "./board";
import { BoardCard } from "./board-card";
import { BoardToolbar, ProjectPicker, type ProjectOption } from "./board-toolbar";
import { CardDetail, type CardActions } from "./card-detail";
import { Button, ConfirmModal, Notice } from "./components";
import { useTodoDocument, useWorkItemViews, type WorkItemView } from "./data";
import { ExecuteModal, type ExecuteSubmit } from "./execute-modal";
import { executeWorkItem, openForAttempt, type ExecuteResult } from "./launch";
import { resolveChoice } from "./launch-defaults";
import { resolveLaunchCapability } from "./launch-guard";
import { MoveMenu } from "./move-menu";
import { useProjectCache } from "./projects";
import { RecoveryScreen } from "./recovery";
import { runWorkItemNow } from "./run";
import { useTodoStyles } from "./styles";
import { TEXT } from "./text";
import { useTodoActions } from "./use-todo-actions";
import { RebindModal, WorkItemEditor } from "./work-item-editor";

type Navigation = PluginSurfaceProps["navigation"];
type Placement = { expectedProjectOrderVersion: number; beforeId?: string; afterId?: string };

function initiatorLabel(platform: string, hostLabel: string): string {
  const device = platform === "ios" ? "iPhone/iPad" : platform === "android" ? "Android" : "Desktop/Web";
  return `${device} · ${hostLabel}`.slice(0, 80);
}

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
  defaultWorkspaceId: string | null;
  title: string;
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
        <Notice styles={styles} kind="danger" title="Todo is unavailable">
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
  defaultWorkspaceId: string | null;
  title: string;
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
  const actions = useTodoActions({ incarnationId: todo.incarnationId, reload });
  const capability = resolveLaunchCapability(props.navigation);
  const status = useRpc(documentStatus);
  const health = useQuery({ queryKey: ["todo", "status", props.host.id], queryFn: () => status({}), refetchInterval: 60_000 });
  const [filter, setFilter] = useState<BoardFilter>("active");
  const [query, setQuery] = useState("");
  const [pickedProjectId, setPickedProjectId] = useState<string | null>(null);
  const [pickingProject, setPickingProject] = useState(false);
  const [width, setWidth] = useState(0);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ open: boolean; view: WorkItemView | null; status: WorkItemStatus }>({ open: false, view: null, status: "todo" });
  const [rebind, setRebind] = useState<WorkItemView | null>(null);
  const [execute, setExecute] = useState<{ view: WorkItemView; retryAnyway: boolean } | null>(null);
  const [confirm, setConfirm] = useState<{ title: string; message: string; label: string; requireDouble: boolean; run: () => Promise<unknown> } | null>(null);
  const [armed, setArmed] = useState(false);
  const [checking, setChecking] = useState<string | null>(null);

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
    return [...options.values()].sort((left, right) => Number(right.available) - Number(left.available) || left.label.localeCompare(right.label));
  }, [projectCache, views]);
  const savedProjectId = prefs.status === "ready" ? prefs.values.boardProjectId : "";
  const projectId = props.projectFilter ?? (resolveChoice(projectOptions, pickedProjectId, savedProjectId, null) || null);
  const projectLabel = projectOptions.find((option) => option.value === projectId)?.label;
  const projectAvailable = projectId !== null && (projectCache.status !== "ready" || projectCache.projects.has(projectId));
  const canCreate = projectAvailable && projectCache.status === "ready";

  const board = useMemo(
    () => (projectId ? buildBoard(views.values(), { projectId, filter, query }) : { columns: [], archived: [] }),
    [views, projectId, filter, query],
  );
  const detailView = detailId ? (views.get(detailId) ?? null) : null;
  const menuView = menuId ? (views.get(menuId) ?? null) : null;
  const menuColumn = menuView ? board.columns.find((column) => column.status === menuView.item.status) : undefined;
  const menuIndex = menuColumn && menuView ? menuColumn.views.findIndex((entry) => entry.item.id === menuView.item.id) : -1;

  function pickProject(id: string) {
    setPickedProjectId(id);
    if (prefs.status === "ready" && prefs.values.boardProjectId !== id) {
      void prefs.save({ ...prefs.values, boardProjectId: id }, prefs.revision);
    }
  }

  const moveCard = useCallback(
    async (view: WorkItemView, next: WorkItemStatus, placement?: Placement) => {
      const result = await actions.move(view.item, next, placement);
      if (!result) return;
      if (result.previousStatus !== view.item.status) {
        toast.show(`#${view.item.number} had already moved to ${WORK_ITEM_STATUS_LABELS[result.previousStatus]}.`, { variant: "info" });
      } else if (placement && !result.placed) {
        toast.show("The order changed elsewhere, so the card kept its place. Try again.", { variant: "info" });
      }
    },
    [actions, toast],
  );

  function shiftCard(view: WorkItemView, offset: -1 | 1) {
    if (!menuColumn || menuIndex < 0) return;
    const ids = menuColumn.views.map((entry) => entry.item.id);
    void moveCard(view, view.item.status, {
      expectedProjectOrderVersion: todo.projectOrderVersions[view.item.projectId] ?? 0,
      ...neighboursAt(ids, view.item.id, menuIndex + offset),
    });
  }

  const handleLaunchResult = useCallback(
    (result: ExecuteResult) => {
      if (result.status === "error") return false;
      if (result.status === "rejected") {
        const code = result.open.code;
        toast.error(
          code === "wrong_device"
            ? "This launch draft belongs to another device. Check status or abandon it there."
            : code === "journal_invalid"
              ? "The local launch journal is invalid. Clear it from the workspace draft before retrying."
              : code === "launch_key_conflict"
                ? "This launch identity was already used with different inputs."
                : result.open.message,
        );
        return false;
      }
      if (result.status === "completed") {
        toast.show(result.open.terminalOutcome === "agent_known" ? "This launch already created an agent." : "This launch was discarded.", { variant: "info" });
      }
      return true;
    },
    [toast],
  );

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
        if (!capability.available || !view.claim) return;
        void openForAttempt({
          attempt,
          claim: view.claim,
          incarnationId: todo.incarnationId,
          target: attempt.workspaceIdHint ? { kind: "existing", workspaceId: attempt.workspaceIdHint } : { kind: "new" },
          rpcs: actions.launchRpcs,
          openAgentLaunch: capability.openAgentLaunch,
          onChange: () => void reload(),
          ...(attempt.initiatorClientInstanceId ? { expectedClientInstanceId: attempt.initiatorClientInstanceId } : {}),
        }).then(handleLaunchResult);
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
      edit: (view) => setEditor({ open: true, view, status: view.item.status }),
      move: (view, next) => void moveCard(view, next),
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
    [actions, capability, checking, todo.incarnationId, handleLaunchResult, moveCard, props.navigation, reload, runCheck],
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
      execute: closing(cardActions.execute),
      resume: closing(cardActions.resume),
      retryAnyway: closing(cardActions.retryAnyway),
      abandon: closing(cardActions.abandon),
      forget: closing(cardActions.forget),
      edit: closing(cardActions.edit),
      purge: closing(cardActions.purge),
      rebind: closing(cardActions.rebind),
      openAgent: cardActions.openAgent ? closing(cardActions.openAgent) : null,
      openWorkspace: cardActions.openWorkspace ? closing(cardActions.openWorkspace) : null,
    };
  }, [cardActions]);

  async function submitExecute(input: ExecuteSubmit): Promise<boolean> {
    if (!execute) return false;
    let item = execute.view.item;
    if (input.updateDefaultPrompt) {
      const ok = await actions.update(item, { defaultPrompt: input.seedPrompt });
      if (!ok) return false;
      item = { ...item, defaultPrompt: input.seedPrompt, version: item.version + 1 };
    }
    const shared = {
      item,
      incarnationId: todo.incarnationId,
      seedPrompt: input.seedPrompt,
      seedPromptSource: input.seedPromptSource,
      initiatorLabel: initiatorLabel(props.platform, props.host.label),
      rpcs: actions.launchRpcs,
      onChange: () => void reload(),
    };
    if (input.mode === "run") {
      const result = await runWorkItemNow({ ...shared, paseo, workspaceId: input.workspaceId, config: input.config });
      await reload();
      if (result.status === "error") {
        toast.error(result.message);
        return false;
      }
      toast.show("Agent started.", { variant: "success" });
      props.navigation?.openAgent({ agentId: result.agentId });
      return true;
    }
    if (!capability.available) return false;
    const result = await executeWorkItem({ ...shared, target: input.target, openAgentLaunch: capability.openAgentLaunch });
    if (result.status === "error") {
      toast.error(result.error.message);
      await reload();
      return false;
    }
    return handleLaunchResult(result);
  }

  function openEditor(next: WorkItemStatus) {
    if (!canCreate) {
      toast.show(projectAvailable ? "Projects are still loading." : "This project is unavailable. Rebind its items first.", { variant: "info" });
      return;
    }
    setEditor({ open: true, view: null, status: next });
  }

  const renderCard = (view: WorkItemView, showStatus = false) => (
    <BoardCard
      key={view.item.id}
      styles={styles}
      theme={theme}
      view={view}
      now={now}
      showStatus={showStatus}
      onOpen={(entry) => setDetailId(entry.item.id)}
      // An archived card has nothing to move; its menu is the detail with Restore and Purge.
      onMenu={(entry) => (entry.item.archivedAt ? setDetailId(entry.item.id) : setMenuId(entry.item.id))}
      onOpenAgent={cardActions.openAgent}
    />
  );

  const degraded = health.data && health.data.status === "ok" ? health.data.degraded : null;
  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }} contentContainerStyle={styles.scrollContent}>
      <View style={{ gap: styles.gap }} onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
        <BoardToolbar
          styles={styles}
          theme={theme}
          title={props.projectFilter ? props.title : (projectLabel ?? props.title)}
          onPickProject={props.projectFilter || projectOptions.length < 2 ? null : () => setPickingProject(true)}
          filter={filter}
          onFilter={setFilter}
          query={query}
          onQuery={setQuery}
          onReload={() => void reload()}
          onCreate={() => openEditor("todo")}
          canCreate={canCreate}
        />
        {degraded ? (
          <Notice styles={styles} kind="warning" title="Daemon-side reconciliation is degraded">
            {`${degraded.reason} since ${degraded.since}. Status may be stale until the plugin recovers or is reloaded.`}
          </Notice>
        ) : null}
        {projectCache.status === "error" ? <Notice styles={styles} kind="warning">{projectCache.error ?? "Projects unavailable."}</Notice> : null}
        {projectId && !projectAvailable ? (
          <Notice styles={styles} kind="warning" title="Project unavailable">
            {`${TEXT.rebindNotice} Open a card and choose Rebind project.`}
          </Notice>
        ) : null}
        {projectId === null ? (
          <Text style={styles.muted}>{projectCache.status === "loading" ? "Loading projects…" : "Open a project in Paseo to start its board."}</Text>
        ) : filter === "archived" ? (
          <View style={{ gap: styles.gap, maxWidth: BOARD_COLUMN_WIDTH * 2 }}>
            {board.archived.map((view) => renderCard(view, true))}
            {board.archived.length === 0 ? <Text style={styles.muted}>No archived items.</Text> : null}
          </View>
        ) : (
          <TodoBoard
            styles={styles}
            theme={theme}
            columns={board.columns}
            // Before the first layout pass, guess from the host layout instead of flashing tabs.
            width={width || (props.compact ? 0 : Number.MAX_SAFE_INTEGER)}
            renderCard={renderCard}
            onCreate={openEditor}
          />
        )}
        <Text style={styles.mono}>{TEXT.trustNotice}</Text>
      </View>
      <WorkItemEditor
        styles={styles}
        theme={theme}
        open={editor.open}
        onOpenChange={(open) => setEditor((current) => ({ ...current, open }))}
        projects={projectCache.projects}
        initialProjectId={projectAvailable ? projectId : ([...projectCache.projects.keys()][0] ?? null)}
        initialStatus={editor.status}
        item={editor.view?.item ?? null}
        onSubmit={async (input) => {
          if (editor.view) {
            return actions.update(editor.view.item, { title: input.title, details: input.details, defaultPrompt: input.defaultPrompt });
          }
          return (await actions.create(input)) !== null;
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
        defaultWorkspaceId={props.defaultWorkspaceId}
        canOpenComposer={capability.available}
        onSubmit={submitExecute}
      />
      <ProjectPicker
        styles={styles}
        theme={theme}
        open={pickingProject}
        onOpenChange={setPickingProject}
        options={projectOptions}
        value={projectId}
        onChange={pickProject}
      />
      <MoveMenu
        styles={styles}
        theme={theme}
        view={menuView}
        onClose={() => setMenuId(null)}
        canMoveUp={menuIndex > 0}
        canMoveDown={menuColumn !== undefined && menuIndex >= 0 && menuIndex < menuColumn.views.length - 1}
        onMove={(view, next) => void moveCard(view, next)}
        onMoveUp={(view) => shiftCard(view, -1)}
        onMoveDown={(view) => shiftCard(view, 1)}
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
        projectAvailable={projectAvailable}
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
    </ScrollView>
  );
}
