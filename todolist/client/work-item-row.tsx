import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { isAttemptNotSubmitted, isAttemptOutcomeUnknown, isAttemptSettled, stageCertainty } from "../shared/attempt";
import type { AgentLink, Attempt } from "../shared/schema";
import { Badge, Button } from "./components";
import type { WorkItemView } from "./data";
import { getKnownClientInstanceId } from "./launch";
import type { TodoStyles } from "./styles";
import { AGGREGATE_PRESENTATION, DISPLAY_STATE_PRESENTATION, TEXT } from "./text";

export interface RowActions {
  execute: (view: WorkItemView) => void;
  resume: (view: WorkItemView, attempt: Attempt) => void;
  retryAnyway: (view: WorkItemView) => void;
  abandon: (view: WorkItemView, attempt: Attempt, certainty: "not_submitted" | "outcome_unknown_confirmed") => void;
  forget: (view: WorkItemView, attempt: Attempt) => void;
  check: (view: WorkItemView) => void;
  edit: (view: WorkItemView) => void;
  setStatus: (view: WorkItemView, status: "open" | "done") => void;
  setArchived: (view: WorkItemView, archived: boolean) => void;
  purge: (view: WorkItemView) => void;
  rebind: (view: WorkItemView) => void;
  moveUp: (view: WorkItemView) => void;
  moveDown: (view: WorkItemView) => void;
  openAgent: ((agentId: string) => void) | null;
  openWorkspace: ((workspaceId: string) => void) | null;
  /** Work item whose manual check is in flight, so only that row shows the busy state. */
  checkingId: string | null;
}

function formatTime(iso: string | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

/** One sentence for the whole attempt instead of one line per launch stage. */
function summarize(attempt: Attempt, links: readonly AgentLink[]): string {
  if (links.length > 0) return `Agent started ${formatTime(attempt.firstAgentObservedAt ?? attempt.createdAt)}`;
  if (isAttemptOutcomeUnknown(attempt)) return "The request was sent but its result is unknown";
  if (stageCertainty(attempt, "agent") === "in_flight") return "The agent request is in flight";
  if (attempt.userDisposition === "abandoned") return "Abandoned before an agent was created";
  if (isAttemptNotSubmitted(attempt)) return "Prepared, nothing submitted yet";
  return "Waiting for the agent to appear";
}

function AttemptCard(props: {
  styles: TodoStyles;
  theme: PluginTheme;
  view: WorkItemView;
  attempt: Attempt;
  links: AgentLink[];
  actions: RowActions;
  canResume: boolean;
}) {
  const { styles, theme, attempt, view, actions, links } = props;
  const claim = view.claim?.attemptId === attempt.id ? view.claim : undefined;
  const unknown = isAttemptOutcomeUnknown(attempt);
  const settled = isAttemptSettled(attempt);
  const pending = claim?.state === "pending";
  const localDevice = getKnownClientInstanceId();
  const initiatedHere =
    !attempt.initiatorClientInstanceId || (localDevice !== null && attempt.initiatorClientInstanceId === localDevice);
  // Abandon is driven by the attempt's own generation, not by whoever holds the claim now, so an
  // older attempt never becomes unactionable just because a newer one took over.
  const canAbandon = !settled;
  const abandonCertainty = isAttemptNotSubmitted(attempt) ? "not_submitted" : "outcome_unknown_confirmed";
  const orphanWorkspace = links.length === 0 && attempt.workspaceIdHint;
  return (
    <View style={[styles.card, { backgroundColor: theme.colors.surface2 }]}>
      <View style={styles.rowWrap}>
        <Text style={styles.body}>{summarize(attempt, links)}</Text>
        {attempt.userDisposition === "abandoned" ? <Badge styles={styles} theme={theme} label="Abandoned" icon="Ban" /> : null}
        {pending && !unknown ? (
          <Badge styles={styles} theme={theme} label={initiatedHere ? "Preparing here" : "Preparing elsewhere"} icon="Hourglass" />
        ) : null}
        {unknown ? <Badge styles={styles} theme={theme} label="Outcome unknown" icon="CircleHelp" tone="warning" /> : null}
      </View>
      <Text style={styles.mono}>
        {formatTime(attempt.createdAt)} · {attempt.initiatorLabel} · {attempt.id.slice(-6)}
      </Text>
      {attempt.lastLaunchErrorCode ? <Text style={styles.warning}>Last launch error: {attempt.lastLaunchErrorCode}</Text> : null}
      {unknown && !settled ? <Text style={styles.warning}>{TEXT.unknownNotice}</Text> : null}
      {pending && !initiatedHere ? <Text style={styles.muted}>{TEXT.offlineJournalNotice}</Text> : null}
      {links.map((link) => {
        const presentation = DISPLAY_STATE_PRESENTATION[link.displayState];
        const duplicate = view.aggregate.duplicateAttemptIds.includes(link.attemptId);
        return (
          <View key={link.agentId} style={styles.rowWrap}>
            <Badge styles={styles} theme={theme} label={presentation.label} icon={presentation.icon} tone={link.displayState === "error" ? "danger" : link.displayState === "permission" ? "warning" : "default"} />
            {link.staleSince ? <Badge styles={styles} theme={theme} label={`Stale since ${formatTime(link.staleSince)}`} icon="CloudOff" tone="warning" /> : null}
            {duplicate ? <Badge styles={styles} theme={theme} label="Duplicate agent" icon="Copy" tone="warning" /> : null}
            <Text style={styles.mono}>{link.provider}{link.model ? ` · ${link.model}` : ""}</Text>
            {/* One way in: the agent view already sits inside its workspace. */}
            {actions.openAgent ? <Button styles={styles} theme={theme} label="Open agent" icon="Bot" onPress={() => actions.openAgent?.(link.agentId)} /> : null}
          </View>
        );
      })}
      <View style={styles.rowWrap}>
        {pending && initiatedHere && !unknown && props.canResume ? (
          <Button styles={styles} theme={theme} label="Resume launch" icon="Play" onPress={() => actions.resume(view, attempt)} />
        ) : null}
        {orphanWorkspace && actions.openWorkspace ? (
          <Button styles={styles} theme={theme} label="Open workspace" icon="FolderOpen" onPress={() => actions.openWorkspace?.(attempt.workspaceIdHint!)} accessibilityHint="No agent is linked to this attempt yet; this opens the workspace it named" />
        ) : null}
        {canAbandon ? (
          <Button
            styles={styles}
            theme={theme}
            label={abandonCertainty === "not_submitted" ? "Discard" : "Abandon"}
            icon="Ban"
            variant="danger"
            onPress={() => actions.abandon(view, attempt, abandonCertainty)}
            accessibilityHint={abandonCertainty === "not_submitted" ? "Nothing was submitted for this attempt" : "Marks the attempt abandoned; a late workspace or agent may still appear"}
          />
        ) : (
          <Button styles={styles} theme={theme} label="Remove" icon="Trash2" variant="danger" onPress={() => actions.forget(view, attempt)} accessibilityHint={TEXT.forgetAttemptWarning} />
        )}
      </View>
    </View>
  );
}

export function WorkItemRow(props: {
  styles: TodoStyles;
  theme: PluginTheme;
  view: WorkItemView;
  actions: RowActions;
  canLaunch: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  compact: boolean;
  dragHandle?: React.ReactNode;
  projectAvailable: boolean;
}) {
  const { styles, theme, view, actions } = props;
  const [expanded, setExpanded] = useState(false);
  const [more, setMore] = useState(false);
  const { item, aggregate } = view;
  const presentation = AGGREGATE_PRESENTATION[aggregate.state];
  const archived = Boolean(item.archivedAt);
  const done = item.status === "done";
  const blocked = aggregate.blockedReason;
  const executeDisabled = archived || done || blocked !== null || !props.projectAvailable;
  const executeHint =
    blocked === "claim_held"
      ? "Another launch is pending"
      : blocked === "active_agent"
        ? "A linked agent is still active"
        : blocked === "stale_agent"
          ? "A linked agent was last seen active; check status first"
          : !props.projectAvailable
            ? "Rebind the project first"
            : "Choose the prompt, workspace and model, then start";
  const unknownPending = aggregate.unknownAttemptIds.length > 0 && aggregate.pendingClaim !== null;
  const checking = actions.checkingId === item.id;
  return (
    <View style={styles.card} accessibilityLabel={`Work item ${item.title}, ${presentation.label}`}>
      <View style={styles.row}>
        {props.dragHandle}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${expanded ? "Collapse" : "Expand"} ${item.title}`}
          accessibilityState={{ expanded }}
          onPress={() => setExpanded((value) => !value)}
          style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 8 }}
        >
          <Icon name={expanded ? "ChevronDown" : "ChevronRight"} size={16} color={theme.colors.foregroundMuted} />
          <Text style={[styles.title, done ? { textDecorationLine: "line-through" } : null]} numberOfLines={expanded ? undefined : 2}>
            {item.title}
          </Text>
        </Pressable>
        <Badge styles={styles} theme={theme} label={presentation.label} icon={presentation.icon} tone={presentation.tone} />
      </View>
      {!expanded && aggregate.pendingClaim ? (
        <Text style={styles.muted}>Launch prepared by {aggregate.pendingClaim.initiatorLabel}</Text>
      ) : null}
      {expanded ? (
        <View style={styles.detail}>
          {item.details ? <Text style={styles.body}>{item.details}</Text> : <Text style={styles.muted}>No details.</Text>}
          <Text style={styles.mono}>Default prompt: {item.defaultPrompt ? item.defaultPrompt.slice(0, 200) : "(empty)"}</Text>
          {!props.projectAvailable ? (
            <Text style={styles.warning}>Project unavailable ({item.projectNameSnapshot}{item.projectRootSnapshot ? ` at ${item.projectRootSnapshot}` : ""}). {TEXT.rebindNotice}</Text>
          ) : null}
          <View style={styles.rowWrap}>
            {!archived && !done ? (
              <Button styles={styles} theme={theme} label="Execute" icon="Play" variant="primary" disabled={executeDisabled} accessibilityHint={executeHint} onPress={() => actions.execute(view)} />
            ) : null}
            {!archived ? (
              <Button styles={styles} theme={theme} label={done ? "Reopen" : "Mark done"} icon={done ? "RotateCcw" : "Check"} onPress={() => actions.setStatus(view, done ? "open" : "done")} accessibilityHint="Manual completion; agents and workspaces are not changed" />
            ) : (
              <Button styles={styles} theme={theme} label="Restore" icon="ArchiveRestore" onPress={() => actions.setArchived(view, false)} />
            )}
            {unknownPending ? (
              <Button styles={styles} theme={theme} label="Retry anyway" icon="AlertTriangle" variant="danger" disabled={!props.projectAvailable} onPress={() => actions.retryAnyway(view)} accessibilityHint={TEXT.retryAnywayWarning} />
            ) : null}
            <Button
              styles={styles}
              theme={theme}
              label="More"
              icon={more ? "ChevronUp" : "Ellipsis"}
              accessibilityLabel={`${more ? "Hide" : "Show"} more actions for ${item.title}`}
              onPress={() => setMore((value) => !value)}
            />
          </View>
          {more ? (
            <View style={styles.rowWrap}>
              {!archived ? <Button styles={styles} theme={theme} label="Edit" icon="Pencil" onPress={() => actions.edit(view)} /> : null}
              <Button styles={styles} theme={theme} label="Rebind project" icon="FolderSync" onPress={() => actions.rebind(view)} />
              {!archived && !done ? (
                <>
                  <Button styles={styles} theme={theme} label="Move up" icon="ArrowUp" disabled={!props.canMoveUp} onPress={() => actions.moveUp(view)} accessibilityLabel={`Move ${item.title} up`} />
                  <Button styles={styles} theme={theme} label="Move down" icon="ArrowDown" disabled={!props.canMoveDown} onPress={() => actions.moveDown(view)} accessibilityLabel={`Move ${item.title} down`} />
                </>
              ) : null}
              {!archived ? <Button styles={styles} theme={theme} label="Archive" icon="Archive" onPress={() => actions.setArchived(view, true)} /> : null}
              {archived ? (
                <Button styles={styles} theme={theme} label="Purge" icon="Trash2" variant="danger" onPress={() => actions.purge(view)} accessibilityHint={blocked ? `Blocked: ${blocked.replace("_", " ")}` : TEXT.purgeWarning} />
              ) : null}
            </View>
          ) : null}
          {archived && blocked ? <Text style={styles.warning}>Purge is disabled: {blocked.replace("_", " ")}.</Text> : null}
          {view.attempts.length > 0 ? (
            <View style={styles.rowWrap}>
              <Text style={styles.sectionTitle}>Attempts ({view.attempts.length})</Text>
              <Button
                styles={styles}
                theme={theme}
                label={checking ? "Checking…" : "Check status"}
                icon="RefreshCw"
                disabled={checking}
                onPress={() => actions.check(view)}
                accessibilityHint={TEXT.checkNotice}
              />
            </View>
          ) : null}
          {view.attempts.map((attempt) => (
            <AttemptCard
              key={attempt.id}
              styles={styles}
              theme={theme}
              view={view}
              attempt={attempt}
              links={view.links.filter((link) => link.attemptId === attempt.id)}
              actions={actions}
              canResume={props.canLaunch}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}
