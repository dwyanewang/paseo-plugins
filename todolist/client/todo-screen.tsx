import type { PluginTheme } from "@getpaseo/plugin";
import { usePaseo, useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { ScrollView, useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { documentStatus } from "../shared/contracts";
import type { Attempt, TodoDocument } from "../shared/schema";
import { Button, ConfirmModal, Notice } from "./components";
import { useTodoDocument, useWorkItemViews, type WorkItemView } from "./data";
import { ExecuteModal, type ExecuteSubmit } from "./execute-modal";
import { executeWorkItem, openForAttempt, type ExecuteResult } from "./launch";
import { resolveLaunchCapability } from "./launch-guard";
import { useProjectCache } from "./projects";
import { RecoveryScreen } from "./recovery";
import { runWorkItemNow } from "./run";
import { useTodoStyles } from "./styles";
import { TEXT } from "./text";
import { TodoList } from "./todo-list";
import { useTodoActions } from "./use-todo-actions";
import { RebindModal, WorkItemEditor } from "./work-item-editor";
import type { RowActions } from "./work-item-row";

type Navigation = PluginSurfaceProps["navigation"];

function initiatorLabel(platform: string, hostLabel: string): string {
  const device = platform === "ios" ? "iPhone/iPad" : platform === "android" ? "Android" : "Desktop/Web";
  return `${device} · ${hostLabel}`.slice(0, 80);
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
  quickAdd?: boolean;
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
  quickAdd?: boolean;
  styles: ReturnType<typeof useTodoStyles>;
  todo: TodoDocument;
  reload: () => Promise<void>;
}) {
  const { theme, styles, todo, reload } = props;
  const paseo = usePaseo();
  const toast = useToast();
  const projectCache = useProjectCache(paseo);
  const views = useWorkItemViews(todo);
  const actions = useTodoActions({ incarnationId: todo.incarnationId, reload });
  const capability = resolveLaunchCapability(props.navigation);
  const status = useRpc(documentStatus);
  const health = useQuery({ queryKey: ["todo", "status", props.host.id], queryFn: () => status({}), refetchInterval: 60_000 });
  const [editor, setEditor] = useState<{ open: boolean; view: WorkItemView | null }>({ open: false, view: null });
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

  const rowActions = useMemo<RowActions>(
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
      edit: (view) => setEditor({ open: true, view }),
      setStatus: (view, statusValue) => void actions.setStatus(view.item, statusValue),
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
      moveUp: () => undefined,
      moveDown: () => undefined,
      openAgent: props.navigation ? (agentId) => props.navigation?.openAgent({ agentId }) : null,
      openWorkspace: props.navigation ? (workspaceId) => props.navigation?.openWorkspace({ workspaceId }) : null,
      checkingId: checking,
    }),
    [actions, capability, checking, todo.incarnationId, handleLaunchResult, props.navigation, reload, runCheck],
  );

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

  const degraded = health.data && health.data.status === "ok" ? health.data.degraded : null;
  const initialProjectId = props.projectFilter ?? [...projectCache.projects.keys()][0] ?? null;
  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }} contentContainerStyle={styles.scrollContent}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>{props.title}</Text>
        <View style={styles.rowWrap}>
          <Button styles={styles} theme={theme} label="Reload" icon="RefreshCw" onPress={() => void reload()} accessibilityHint="Re-reads Todo data from the daemon" />
          <Button styles={styles} theme={theme} label="New" icon="Plus" variant="primary" onPress={() => setEditor({ open: true, view: null })} disabled={projectCache.projects.size === 0 && projectCache.status === "ready"} />
        </View>
      </View>
      {degraded ? (
        <Notice styles={styles} kind="warning" title="Daemon-side reconciliation is degraded">
          {`${degraded.reason} since ${degraded.since}. Status may be stale until the plugin recovers or is reloaded.`}
        </Notice>
      ) : null}
      {projectCache.status === "error" ? <Notice styles={styles} kind="warning">{projectCache.error ?? "Projects unavailable."}</Notice> : null}
      <TodoList
        styles={styles}
        theme={theme}
        compact={props.compact}
        views={views}
        projects={projectCache.projects}
        projectsReady={projectCache.status === "ready"}
        projectFilter={props.projectFilter}
        projectOrderVersions={todo.projectOrderVersions}
        actions={rowActions}
        canLaunch={capability.available}
        onReorder={({ view, expectedProjectOrderVersion, beforeId, afterId }) =>
          void actions.reorder({ item: view.item, expectedProjectOrderVersion, ...(beforeId ? { beforeId } : {}), ...(afterId ? { afterId } : {}) })
        }
      />
      <Text style={styles.mono}>{TEXT.trustNotice}</Text>
      <WorkItemEditor
        styles={styles}
        theme={theme}
        open={editor.open}
        onOpenChange={(open) => setEditor((current) => ({ ...current, open }))}
        projects={projectCache.projects}
        initialProjectId={initialProjectId}
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
