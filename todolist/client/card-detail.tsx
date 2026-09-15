import type { PluginTheme } from "@getpaseo/plugin";
import { Modal } from "@getpaseo/plugin/client/react-native";
import { Text, View } from "react-native";
import { isAttemptNotSubmitted, isAttemptOutcomeUnknown, isAttemptSettled, stageCertainty } from "../shared/attempt";
import { STATUS_REASON_LABELS, formatRelativeTime, resolveInProgressIntent } from "../shared/board";
import type { AgentLink, Attempt, WorkItemPriority, WorkItemStatus } from "../shared/schema";
import { Badge, Button } from "./components";
import type { WorkItemView } from "./data";
import { getKnownClientInstanceId } from "./launch";
import { PriorityPicker, StatusPicker } from "./move-menu";
import type { TodoStyles } from "./styles";
import { AGGREGATE_PRESENTATION, DISPLAY_STATE_PRESENTATION, TEXT } from "./text";

export interface CardActions {
  execute: (view: WorkItemView) => void;
  resume: (view: WorkItemView, attempt: Attempt) => void;
  retryAnyway: (view: WorkItemView) => void;
  abandon: (view: WorkItemView, attempt: Attempt, certainty: "not_submitted" | "outcome_unknown_confirmed") => void;
  forget: (view: WorkItemView, attempt: Attempt) => void;
  check: (view: WorkItemView) => void;
  edit: (view: WorkItemView) => void;
  /** Moving into In progress may open a dialog instead of moving at once; see `requestMove`. */
  move: (view: WorkItemView, status: WorkItemStatus) => void;
  continueAgent: (view: WorkItemView) => void;
  setPriority: (view: WorkItemView, priority: WorkItemPriority) => void;
  setArchived: (view: WorkItemView, archived: boolean) => void;
  purge: (view: WorkItemView) => void;
  rebind: (view: WorkItemView) => void;
  openAgent: ((agentId: string) => void) | null;
  openWorkspace: ((workspaceId: string) => void) | null;
  /** Work item whose manual check is in flight, so only that card shows the busy state. */
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
  actions: CardActions;
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

/** Everything about one card. Actions that open another dialog close this one first. */
export function CardDetail(props: {
  styles: TodoStyles;
  theme: PluginTheme;
  view: WorkItemView | null;
  onClose: () => void;
  actions: CardActions;
  canLaunch: boolean;
  projectAvailable: boolean;
  now: number;
}) {
  const { view } = props;
  const item = view?.item;
  return (
    <Modal title={item ? `#${item.number} ${item.title}` : "Work item"} open={view !== null} onOpenChange={(open) => !open && props.onClose()}>
      <Modal.Content>
        {view ? (
          <DetailBody
            styles={props.styles}
            theme={props.theme}
            view={view}
            actions={props.actions}
            canLaunch={props.canLaunch}
            projectAvailable={props.projectAvailable}
            now={props.now}
          />
        ) : null}
      </Modal.Content>
    </Modal>
  );
}

function DetailBody(props: {
  styles: TodoStyles;
  theme: PluginTheme;
  view: WorkItemView;
  actions: CardActions;
  canLaunch: boolean;
  projectAvailable: boolean;
  now: number;
}) {
  const { styles, theme, view, actions } = props;
  const { item, aggregate } = view;
  const presentation = AGGREGATE_PRESENTATION[aggregate.state];
  const archived = Boolean(item.archivedAt);
  const closed = item.status === "done" || item.status === "cancelled";
  const blocked = aggregate.blockedReason;
  const executeDisabled = blocked !== null || !props.projectAvailable;
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
  const canContinue = !archived && resolveInProgressIntent(view).kind === "continue";
  return (
    <>
      <StatusPicker styles={styles} theme={theme} value={item.status} onChange={(status) => actions.move(view, status)} />
      {!archived ? <PriorityPicker styles={styles} theme={theme} value={item.priority} onChange={(priority) => actions.setPriority(view, priority)} /> : null}
      <View style={styles.rowWrap}>
        <Badge styles={styles} theme={theme} label={presentation.label} icon={presentation.icon} tone={presentation.tone} />
        <Text style={styles.mono}>
          {STATUS_REASON_LABELS[item.statusReason]} · {formatRelativeTime(item.statusChangedAt, props.now)}
        </Text>
      </View>
      {archived ? <Text style={styles.warning}>Archived {formatTime(item.archivedAt)}. It is hidden from the board until restored.</Text> : null}
      {!props.projectAvailable ? (
        <Text style={styles.warning}>Project unavailable ({item.projectNameSnapshot}{item.projectRootSnapshot ? ` at ${item.projectRootSnapshot}` : ""}). {TEXT.rebindNotice}</Text>
      ) : null}
      {item.details ? <Text style={styles.body}>{item.details}</Text> : <Text style={styles.muted}>No details.</Text>}
      <Text style={styles.mono}>Default prompt: {item.defaultPrompt ? item.defaultPrompt.slice(0, 200) : "(empty)"}</Text>
      {aggregate.pendingClaim ? <Text style={styles.muted}>Launch prepared by {aggregate.pendingClaim.initiatorLabel}</Text> : null}
      <View style={styles.rowWrap}>
        {canContinue ? (
          <Button styles={styles} theme={theme} label="Continue agent" icon="Send" variant="primary" onPress={() => actions.continueAgent(view)} accessibilityHint="Send a follow-up message to the agent that last worked on this item" />
        ) : null}
        {!archived && !closed ? (
          <Button styles={styles} theme={theme} label="Execute" icon="Play" variant={canContinue ? "secondary" : "primary"} disabled={executeDisabled} accessibilityHint={executeHint} onPress={() => actions.execute(view)} />
        ) : null}
        {unknownPending ? (
          <Button styles={styles} theme={theme} label="Retry anyway" icon="AlertTriangle" variant="danger" disabled={!props.projectAvailable} onPress={() => actions.retryAnyway(view)} accessibilityHint={TEXT.retryAnywayWarning} />
        ) : null}
        {!archived ? <Button styles={styles} theme={theme} label="Edit" icon="Pencil" onPress={() => actions.edit(view)} /> : null}
        <Button styles={styles} theme={theme} label="Rebind project" icon="FolderSync" onPress={() => actions.rebind(view)} />
        {archived ? (
          <>
            <Button styles={styles} theme={theme} label="Restore" icon="ArchiveRestore" onPress={() => actions.setArchived(view, false)} />
            <Button styles={styles} theme={theme} label="Purge" icon="Trash2" variant="danger" onPress={() => actions.purge(view)} accessibilityHint={blocked ? `Blocked: ${blocked.replace("_", " ")}` : TEXT.purgeWarning} />
          </>
        ) : (
          <Button styles={styles} theme={theme} label="Archive" icon="Archive" onPress={() => actions.setArchived(view, true)} />
        )}
      </View>
      {archived && blocked ? <Text style={styles.warning}>Purge is disabled: {blocked.replace("_", " ")}.</Text> : null}
      {view.attempts.length > 0 ? (
        <View style={styles.rowWrap}>
          <Text style={styles.sectionTitle}>Attempts ({view.attempts.length})</Text>
          <Button styles={styles} theme={theme} label={checking ? "Checking…" : "Check status"} icon="RefreshCw" disabled={checking} onPress={() => actions.check(view)} accessibilityHint={TEXT.checkNotice} />
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
    </>
  );
}
