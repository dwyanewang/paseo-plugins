import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, Modal } from "@getpaseo/plugin/client/react-native";
import { useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import { isAttemptNotSubmitted, isAttemptOutcomeUnknown, isAttemptSettled, stageCertainty } from "../shared/attempt";
import { STATUS_REASON_LABELS, formatRelativeTime, resolveInProgressIntent } from "../shared/board";
import type { AgentLink, Attempt, WorkItemPriority, WorkItemStatus } from "../shared/schema";
import { Badge, Button, Notice, toneColor } from "./components";
import type { WorkItemView } from "./data";
import { getKnownClientInstanceId } from "./launch";
import { PriorityPicker, StatusPicker } from "./move-menu";
import type { TodoStyles } from "./styles";
import { AGGREGATE_PRESENTATION, DISPLAY_STATE_COLOR, DISPLAY_STATE_PRESENTATION, TEXT } from "./text";

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

/** Attempts beyond this many stay folded until asked for; the newest come first. */
const VISIBLE_ATTEMPTS = 2;

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

function Property(props: { styles: TodoStyles; label: string; children: ReactNode }) {
  return (
    <View style={props.styles.propertyRow}>
      <Text style={props.styles.propertyLabel}>{props.label}</Text>
      <View style={{ flex: 1, minWidth: 0 }}>{props.children}</View>
    </View>
  );
}

function Section(props: { styles: TodoStyles; title: string; trailing?: ReactNode; children: ReactNode }) {
  const { styles } = props;
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Text style={[styles.sectionTitle, { flex: 1 }]}>{props.title}</Text>
        {props.trailing}
      </View>
      {props.children}
    </View>
  );
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
    <View style={[styles.card, { gap: 8 }]}>
      <View style={[styles.rowWrap, { gap: 6 }]}>
        <Text style={[styles.body, { fontWeight: "500", flexShrink: 1 }]}>{summarize(attempt, links)}</Text>
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
      {pending && !initiatedHere ? <Text style={styles.mono}>{TEXT.offlineJournalNotice}</Text> : null}
      {links.map((link) => {
        const presentation = DISPLAY_STATE_PRESENTATION[link.displayState];
        const duplicate = view.aggregate.duplicateAttemptIds.includes(link.attemptId);
        return (
          <View key={link.agentId} style={[styles.rowWrap, { gap: 6 }]}>
            <View style={[styles.dot, { backgroundColor: theme.colors[DISPLAY_STATE_COLOR[link.displayState]] }]} />
            <Text style={[styles.body, { fontSize: 12 }]}>{presentation.label}</Text>
            <Text style={[styles.mono, { flexShrink: 1 }]} numberOfLines={1}>
              {link.provider}
              {link.model ? ` · ${link.model}` : ""}
            </Text>
            {link.staleSince ? <Badge styles={styles} theme={theme} label={`Stale since ${formatTime(link.staleSince)}`} icon="CloudOff" tone="warning" /> : null}
            {duplicate ? <Badge styles={styles} theme={theme} label="Duplicate agent" icon="Copy" tone="warning" /> : null}
            <View style={{ flex: 1 }} />
            {/* One way in: the agent view already sits inside its workspace. */}
            {actions.openAgent ? <Button styles={styles} theme={theme} label="Open agent" icon="Bot" onPress={() => actions.openAgent?.(link.agentId)} /> : null}
          </View>
        );
      })}
      <View style={[styles.rowWrap, { gap: 6, justifyContent: "flex-end" }]}>
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
            variant="ghost"
            onPress={() => actions.abandon(view, attempt, abandonCertainty)}
            accessibilityHint={abandonCertainty === "not_submitted" ? "Nothing was submitted for this attempt" : "Marks the attempt abandoned; a late workspace or agent may still appear"}
          />
        ) : (
          <Button styles={styles} theme={theme} label="Remove" icon="Trash2" variant="ghost" onPress={() => actions.forget(view, attempt)} accessibilityHint={TEXT.forgetAttemptWarning} />
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
    <Modal title={item ? `#${item.number}` : "Work item"} open={view !== null} onOpenChange={(open) => !open && props.onClose()}>
      <Modal.Content>
        {view ? (
          <DetailBody
            // Remounts per card, so folded attempts start folded again.
            key={view.item.id}
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
  const [allAttempts, setAllAttempts] = useState(false);
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
  const attempts = allAttempts ? view.attempts : view.attempts.slice(0, VISIBLE_ATTEMPTS);
  const folded = view.attempts.length - attempts.length;
  return (
    <>
      <View style={{ gap: 6 }}>
        <Text style={styles.detailTitle} selectable>
          {item.title}
        </Text>
        <View style={[styles.row, { gap: 6 }]}>
          <Icon name={props.projectAvailable ? "Folder" : "FolderX"} size={12} color={props.projectAvailable ? theme.colors.foregroundMuted : theme.colors.statusWarning} />
          <Text style={[styles.mono, { flexShrink: 1 }]} numberOfLines={1}>
            {item.projectNameSnapshot}
            {item.projectRootSnapshot ? ` · ${item.projectRootSnapshot}` : ""}
          </Text>
        </View>
      </View>

      <View style={[styles.rowWrap, { gap: 8 }]}>
        {canContinue ? (
          <Button styles={styles} theme={theme} label="Continue agent" icon="Send" variant="primary" onPress={() => actions.continueAgent(view)} accessibilityHint="Send a follow-up message to the agent that last worked on this item" />
        ) : null}
        {!archived && !closed ? (
          <Button styles={styles} theme={theme} label="Execute" icon="Play" variant={canContinue ? "secondary" : "primary"} disabled={executeDisabled} accessibilityHint={executeHint} onPress={() => actions.execute(view)} />
        ) : null}
        {unknownPending ? (
          <Button styles={styles} theme={theme} label="Retry anyway" icon="TriangleAlert" variant="danger" disabled={!props.projectAvailable} onPress={() => actions.retryAnyway(view)} accessibilityHint={TEXT.retryAnywayWarning} />
        ) : null}
        {!archived ? <Button styles={styles} theme={theme} label="Edit" icon="Pencil" onPress={() => actions.edit(view)} /> : null}
        {archived ? <Button styles={styles} theme={theme} label="Restore" icon="ArchiveRestore" variant="primary" onPress={() => actions.setArchived(view, false)} /> : null}
      </View>

      {archived ? <Notice styles={styles} theme={theme} kind="warning">{`Archived ${formatTime(item.archivedAt)}. It is hidden from the board until restored.`}</Notice> : null}
      {archived && blocked ? <Text style={styles.warning}>Purge is disabled: {blocked.replace("_", " ")}.</Text> : null}
      {!props.projectAvailable ? (
        <Notice styles={styles} theme={theme} kind="warning" title="Project unavailable">
          {TEXT.rebindNotice}
        </Notice>
      ) : null}

      <View style={[styles.card, { gap: 12 }]}>
        <Property styles={styles} label="Status">
          <StatusPicker styles={styles} theme={theme} value={item.status} onChange={(status) => actions.move(view, status)} />
          <Text style={[styles.mono, { paddingTop: 6 }]}>
            {STATUS_REASON_LABELS[item.statusReason]} · {formatRelativeTime(item.statusChangedAt, props.now)}
          </Text>
        </Property>
        {!archived ? (
          <Property styles={styles} label="Priority">
            <PriorityPicker styles={styles} theme={theme} value={item.priority} onChange={(priority) => actions.setPriority(view, priority)} />
          </Property>
        ) : null}
        <Property styles={styles} label="Agent">
          <View style={[styles.row, { gap: 6, minHeight: 26 }]}>
            <Icon name={presentation.icon} size={13} color={toneColor(theme, presentation.tone)} />
            <Text style={[styles.body, presentation.tone !== "default" ? { color: toneColor(theme, presentation.tone) } : null]}>{presentation.label}</Text>
          </View>
          {aggregate.pendingClaim ? <Text style={styles.mono}>Launch prepared by {aggregate.pendingClaim.initiatorLabel}</Text> : null}
        </Property>
      </View>

      <Section styles={styles} title="Details">
        {item.details ? (
          <Text style={styles.body} selectable>
            {item.details}
          </Text>
        ) : (
          <Text style={styles.muted}>No details.</Text>
        )}
      </Section>

      <Section styles={styles} title="Default prompt">
        {item.defaultPrompt ? (
          <Text style={styles.code} numberOfLines={12} selectable>
            {item.defaultPrompt}
          </Text>
        ) : (
          <Text style={styles.muted}>Empty. Executing starts from the title and details.</Text>
        )}
      </Section>

      {view.attempts.length > 0 ? (
        <Section
          styles={styles}
          title={`Attempts · ${view.attempts.length}`}
          trailing={
            <Button styles={styles} theme={theme} label={checking ? "Checking…" : "Check status"} icon="RefreshCw" variant="ghost" disabled={checking} onPress={() => actions.check(view)} accessibilityHint={TEXT.checkNotice} />
          }
        >
          {attempts.map((attempt) => (
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
          {view.attempts.length > VISIBLE_ATTEMPTS ? (
            <Button
              styles={styles}
              theme={theme}
              label={allAttempts ? "Show fewer" : `Show ${folded} earlier ${folded === 1 ? "attempt" : "attempts"}`}
              icon={allAttempts ? "ChevronUp" : "ChevronDown"}
              variant="ghost"
              onPress={() => setAllAttempts((current) => !current)}
            />
          ) : null}
        </Section>
      ) : null}

      {/* Housekeeping, kept apart from the actions that move work forward. */}
      <View style={styles.divider} />
      <View style={[styles.rowWrap, { gap: 4 }]}>
        <Button styles={styles} theme={theme} label="Rebind project" icon="FolderSync" variant="ghost" onPress={() => actions.rebind(view)} />
        {archived ? (
          <Button styles={styles} theme={theme} label="Purge" icon="Trash2" variant="danger" onPress={() => actions.purge(view)} accessibilityHint={blocked ? `Blocked: ${blocked.replace("_", " ")}` : TEXT.purgeWarning} />
        ) : (
          <Button styles={styles} theme={theme} label="Archive" icon="Archive" variant="ghost" onPress={() => actions.setArchived(view, true)} />
        )}
      </View>
    </>
  );
}
