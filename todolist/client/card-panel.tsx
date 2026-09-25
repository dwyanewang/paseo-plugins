import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { canResumeAttempt, isAttemptNotSubmitted, isAttemptOutcomeUnknown, isAttemptSettled, stageCertainty } from "../shared/attempt";
import { STATUS_REASON_LABELS, formatRelativeTime, latestLink, resolveInProgressIntent } from "../shared/board";
import { validateWorkItemFields } from "../shared/limits";
import type { AgentLink, Attempt, WorkItemPriority, WorkItemStatus } from "../shared/schema";
import { Badge, toneColor } from "./components";
import type { WorkItemView } from "./data";
import { MenuButton, PillSelect, PillStrip } from "./floating-menu";
import type { WorkItemFileInput } from "../shared/contracts";
import { AttachmentStrip, useDraftAttachments } from "./attachments";
import { draftToFileRef, refToDraftFile } from "./files";
import { useTodoImageStore, type DraftImage } from "./images";
import { getKnownClientInstanceId } from "./launch";
import { MetaLine, Overlay, OverlayBox, useOverlay } from "./overlay";
import { IconAction, InlineNote, KEYS, MetaText, TextAction } from "./overlay-parts";
import type { ProjectRecord } from "./projects";
import { parseQuickAdd } from "./quick-add";
import type { TodoStyles } from "./styles";
import { AGGREGATE_PRESENTATION, DISPLAY_STATE_COLOR, DISPLAY_STATE_PRESENTATION, TEXT } from "./text";
import {
  AttachButton,
  CardTextArea,
  DraftAttachmentRow,
  DropHint,
  PLACEHOLDER,
  PriorityPill,
  StatusPill,
  composeText,
  fieldProblem,
  projectItems,
  shortPath,
} from "./work-item-editor";

export interface CardEdit {
  title: string;
  details: string;
  defaultPrompt: string;
  priority: WorkItemPriority;
  /** The full desired image set with in-memory bytes, or null to leave stored images unchanged. */
  images: DraftImage[] | null;
  /** The full desired file set. */
  files: WorkItemFileInput[];
}

export interface CardActions {
  execute: (view: WorkItemView) => void;
  resume: (view: WorkItemView, attempt: Attempt) => void;
  retryAnyway: (view: WorkItemView) => void;
  abandon: (view: WorkItemView, attempt: Attempt, certainty: "not_submitted" | "outcome_unknown_confirmed") => void;
  forget: (view: WorkItemView, attempt: Attempt) => void;
  check: (view: WorkItemView) => void;
  save: (view: WorkItemView, edit: CardEdit) => Promise<boolean>;
  /** Moving into In progress may open another box instead of moving at once; see `requestMove`. */
  move: (view: WorkItemView, status: WorkItemStatus) => void;
  continueAgent: (view: WorkItemView) => void;
  setPriority: (view: WorkItemView, priority: WorkItemPriority) => void;
  setArchived: (view: WorkItemView, archived: boolean) => void;
  purge: (view: WorkItemView) => void;
  rebind: (view: WorkItemView, project: ProjectRecord) => void;
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

interface PanelProps {
  styles: TodoStyles;
  theme: PluginTheme;
  view: WorkItemView | null;
  /** Open straight into editing, as the card menu's Edit does. */
  editing: boolean;
  onClose: () => void;
  actions: CardActions;
  canLaunch: boolean;
  projectAvailable: boolean;
  projects: Map<string, ProjectRecord>;
  now: number;
}

/**
 * Everything about one card in one box. The text is shown as it reads and turns into the new-item
 * text area on a press; the column, priority and project are pills; the agent and every attempt
 * follow, with the actions that move the work forward in the footer.
 */
export function CardPanel(props: PanelProps) {
  return (
    <Overlay theme={props.theme} open={props.view !== null} onClose={props.onClose} variant="box">
      {/* Mounts per card, so folded attempts start folded and edits start from the card. */}
      {props.view ? <PanelBody key={props.view.item.id} {...props} view={props.view} /> : null}
    </Overlay>
  );
}

function PanelBody(props: PanelProps & { view: WorkItemView }) {
  const [editing, setEditing] = useState(props.editing && !props.view.item.archivedAt);
  return editing ? <EditBody {...props} onDone={() => setEditing(false)} /> : <ViewBody {...props} onEdit={() => setEditing(true)} />;
}

/** The card's small print: number, project and where it lives. */
function PanelMeta(props: { theme: PluginTheme; view: WorkItemView; projectAvailable: boolean; editing?: boolean }) {
  const { theme, view } = props;
  const muted = theme.colors.foregroundMuted;
  // Phones have no room for the path on the same line.
  const { phone } = useOverlay();
  return (
    <MetaLine theme={theme}>
      <MetaText
        theme={theme}
        parts={[
          <Text style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600", fontVariant: ["tabular-nums"] }}>{`#${view.item.number}`}</Text>,
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <Icon name={props.projectAvailable ? "Folder" : "FolderX"} size={12} color={props.projectAvailable ? muted : theme.colors.statusWarning} />
            <Text style={{ color: muted, fontSize: 12 }} numberOfLines={1}>
              {view.item.projectNameSnapshot}
            </Text>
          </View>,
          props.editing ? (
            <Text style={{ color: theme.colors.accent, fontSize: 12 }}>Editing</Text>
          ) : view.item.projectRootSnapshot && !phone ? (
            <Text style={{ color: muted, fontSize: 11.5, fontFamily: "monospace", flexShrink: 1 }} numberOfLines={1}>
              {shortPath(view.item.projectRootSnapshot)}
            </Text>
          ) : null,
        ]}
      />
    </MetaLine>
  );
}

function SectionHeading(props: { theme: PluginTheme; title: string; trailing?: ReactNode }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: 26, marginTop: 10, marginBottom: 4, marginHorizontal: 2 }}>
      <Text style={{ color: props.theme.colors.foregroundMuted, fontSize: 11, fontWeight: "600", letterSpacing: 0.4, textTransform: "uppercase" }}>{props.title}</Text>
      {props.trailing}
    </View>
  );
}

function ViewBody(props: PanelProps & { view: WorkItemView; onEdit: () => void }) {
  const { styles, theme, view, actions } = props;
  const { item, aggregate } = view;
  const imageStore = useTodoImageStore();
  const images = useMemo(() => imageStore.resolve(item.images), [imageStore, item.images]);
  const files = useMemo(() => item.files.map(refToDraftFile), [item.files]);
  const [allAttempts, setAllAttempts] = useState(false);
  const [hovered, setHovered] = useState(false);
  const presentation = AGGREGATE_PRESENTATION[aggregate.state];
  const archived = Boolean(item.archivedAt);
  const closed = item.status === "done" || item.status === "cancelled";
  const blocked = aggregate.blockedReason;
  const executeDisabled = blocked !== null || !props.projectAvailable;
  const executeHint =
    blocked === "claim_held"
      ? "Another launch is pending."
      : blocked === "active_agent"
        ? "A linked agent is still active."
        : blocked === "stale_agent"
          ? "A linked agent was last seen active; check status first."
          : !props.projectAvailable
            ? "Rebind the project first."
            : "Choose the prompt, workspace and model, then start.";
  const unknownPending = aggregate.unknownAttemptIds.length > 0 && aggregate.pendingClaim !== null;
  const checking = actions.checkingId === item.id;
  const canContinue = !archived && resolveInProgressIntent(view).kind === "continue";
  const attempts = allAttempts ? view.attempts : view.attempts.slice(0, VISIBLE_ATTEMPTS);
  const folded = view.attempts.length - attempts.length;
  const latest = latestLink(view.links);
  const projects = useMemo(() => projectItems(props.projects, item.projectId), [props.projects, item.projectId]);
  const showExecute = !archived && !closed;
  const { phone } = useOverlay();

  const menuItems = [
    ...(archived
      ? [
          { key: "restore", label: "Restore", icon: "ArchiveRestore" },
          { key: "purge", label: blocked ? `Purge (blocked: ${blocked.replace("_", " ")})` : "Purge", icon: "Trash2", iconColor: theme.colors.statusDanger },
        ]
      : [{ key: "archive", label: "Archive", icon: "Archive" }]),
  ];

  return (
    <OverlayBox
      size="wide"
      maxRatio={0.85}
      accessibilityLabel={`#${item.number} ${item.title}`}
      meta={<PanelMeta theme={theme} view={view} projectAvailable={props.projectAvailable} />}
      footer={
        <View style={{ marginTop: 6 }}>
          {showExecute && executeDisabled ? <InlineNote theme={theme}>{executeHint}</InlineNote> : null}
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 10 }}>
            <MenuButton
              theme={theme}
              icon="Ellipsis"
              label="More"
              items={menuItems}
              onSelect={(key) => {
                if (key === "archive") actions.setArchived(view, true);
                else if (key === "restore") actions.setArchived(view, false);
                else if (key === "purge") actions.purge(view);
              }}
            />
            {unknownPending ? (
              <TextAction theme={theme} label="Retry anyway" icon="TriangleAlert" kind="danger" disabled={!props.projectAvailable} accessibilityHint={TEXT.retryAnywayWarning} onPress={() => actions.retryAnyway(view)} />
            ) : null}
            <View style={{ flex: 1 }} />
            {archived ? <TextAction theme={theme} label="Restore" icon="ArchiveRestore" kind="accent" onPress={() => actions.setArchived(view, false)} /> : null}
            {showExecute ? (
              <TextAction theme={theme} label="Execute" icon="Play" kind={canContinue ? "default" : "accent"} disabled={executeDisabled} accessibilityHint={executeHint} onPress={() => actions.execute(view)} />
            ) : null}
            {canContinue ? (
              <TextAction
                theme={theme}
                label={phone ? "Continue" : "Continue agent"}
                icon="Send"
                kind="accent"
                accessibilityHint="Send a follow-up message to the agent that last worked on this item"
                onPress={() => actions.continueAgent(view)}
              />
            ) : null}
          </View>
        </View>
      }
    >
      <Pressable
        accessibilityRole={archived ? undefined : "button"}
        accessibilityHint={archived ? undefined : "Edits the text and attachments"}
        disabled={archived}
        onPress={props.onEdit}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        style={[
          { borderRadius: 8, padding: 4, margin: -4, borderWidth: 1, borderStyle: "dashed", borderColor: "transparent" },
          hovered && !archived ? { borderColor: theme.colors.border } : null,
        ]}
      >
        <Text style={{ color: theme.colors.foreground, fontSize: 17, fontWeight: "600", lineHeight: 24, paddingRight: hovered ? 80 : 0 }}>{item.title}</Text>
        {item.details ? <Text style={{ color: theme.colors.foreground, opacity: 0.88, fontSize: 14, lineHeight: 22, marginTop: 4 }}>{item.details}</Text> : null}
        {hovered && !archived ? (
          <View style={{ position: "absolute", top: 4, right: 6, flexDirection: "row", alignItems: "center", gap: 4 }}>
            <Icon name="Pencil" size={11} color={theme.colors.foregroundMuted} />
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>Click to edit</Text>
          </View>
        ) : null}
      </Pressable>
      {/* Outside the text's press area: a thumbnail opens its preview instead of the editor. */}
      {images.length > 0 || files.length > 0 ? (
        <View style={{ marginTop: 8 }}>
          <AttachmentStrip styles={styles} theme={theme} images={images} files={files} size={60} />
        </View>
      ) : null}

      {/* Only cards from before the one-box editor still carry a prompt of their own. */}
      {item.defaultPrompt ? (
        <View style={{ marginTop: 10 }}>
          <Text style={styles.code} numberOfLines={12} selectable>
            {item.defaultPrompt}
          </Text>
          <Text style={[styles.mono, { marginTop: 4 }]}>This runs instead of the title and details.</Text>
        </View>
      ) : null}

      <View style={{ flexDirection: "row", alignItems: "center", marginTop: 12 }}>
        <PillStrip theme={theme}>
          <StatusPill theme={theme} status={item.status} onSelect={(status) => actions.move(view, status)} />
          {!archived ? <PriorityPill theme={theme} priority={item.priority} onSelect={(priority) => priority !== item.priority && actions.setPriority(view, priority)} /> : null}
          <PillSelect
            theme={theme}
            label="Project"
            icon={props.projectAvailable ? "Folder" : "FolderX"}
            iconColor={props.projectAvailable ? theme.colors.foregroundMuted : theme.colors.statusWarning}
            text={item.projectNameSnapshot}
            items={projects}
            note={{ icon: "ArrowLeftRight", text: "Rebind: choose the project this card belongs to now. Todo never rebinds by path on its own." }}
            filter={{ placeholder: "Filter projects…", noun: "projects" }}
            onSelect={(projectId) => {
              const project = props.projects.get(projectId);
              if (project && projectId !== item.projectId) actions.rebind(view, project);
            }}
          />
        </PillStrip>
      </View>
      <Text style={[styles.metaText, { marginTop: 6, marginHorizontal: 2 }]}>
        {`${STATUS_REASON_LABELS[item.statusReason]} · ${formatRelativeTime(item.statusChangedAt, props.now)}`}
      </Text>
      {archived ? <InlineNote theme={theme} kind="info">{`Archived ${formatTime(item.archivedAt)}. It is hidden from the board until restored.`}</InlineNote> : null}
      {archived && blocked ? <InlineNote theme={theme}>{`Purge is disabled: ${blocked.replace("_", " ")}.`}</InlineNote> : null}
      {!props.projectAvailable ? <InlineNote theme={theme}>{`Project unavailable. ${TEXT.rebindNotice}`}</InlineNote> : null}

      <View style={{ height: 1, backgroundColor: theme.colors.border, marginTop: 12 }} />
      <SectionHeading theme={theme} title="Agent" />
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginHorizontal: 2 }}>
        <Icon name={presentation.icon} size={13} color={toneColor(theme, presentation.tone)} />
        <Text style={{ color: presentation.tone !== "default" ? toneColor(theme, presentation.tone) : theme.colors.foreground, fontSize: 13 }} numberOfLines={1}>
          {presentation.label}
        </Text>
        {latest ? (
          <Text style={[styles.metaText, { flex: 1 }]} numberOfLines={1}>
            {`· ${latest.provider}${latest.model ? ` · ${latest.model}` : ""} · ${formatRelativeTime(latest.stateChangedAt, props.now)}`}
          </Text>
        ) : (
          <View style={{ flex: 1 }} />
        )}
        {latest && actions.openAgent ? <TextAction theme={theme} small kind="ghost" label="Open agent" icon="Bot" onPress={() => actions.openAgent?.(latest.agentId)} /> : null}
      </View>
      {aggregate.pendingClaim ? <Text style={[styles.metaText, { marginTop: 4, marginHorizontal: 2 }]}>{`Launch prepared by ${aggregate.pendingClaim.initiatorLabel}`}</Text> : null}

      {view.attempts.length > 0 ? (
        <>
          <SectionHeading
            theme={theme}
            title={`Attempts · ${view.attempts.length}`}
            trailing={<TextAction theme={theme} small kind="ghost" label={checking ? "Checking…" : "Check status"} icon="RefreshCw" disabled={checking} accessibilityHint={TEXT.checkNotice} onPress={() => actions.check(view)} />}
          />
          {attempts.map((attempt) => (
            <AttemptRow
              key={attempt.id}
              styles={styles}
              theme={theme}
              view={view}
              attempt={attempt}
              links={view.links.filter((link) => link.attemptId === attempt.id)}
              actions={actions}
              canResume={props.canLaunch}
              now={props.now}
            />
          ))}
          {view.attempts.length > VISIBLE_ATTEMPTS ? (
            <View style={{ alignItems: "flex-start" }}>
              <TextAction
                theme={theme}
                small
                kind="ghost"
                label={allAttempts ? "Show fewer" : `Show ${folded} earlier ${folded === 1 ? "attempt" : "attempts"}`}
                icon={allAttempts ? "ChevronUp" : "ChevronDown"}
                onPress={() => setAllAttempts((current) => !current)}
              />
            </View>
          ) : null}
        </>
      ) : null}
    </OverlayBox>
  );
}

/** One attempt as a compact row: what happened, its agents, and what can be done about it. */
function AttemptRow(props: {
  styles: TodoStyles;
  theme: PluginTheme;
  view: WorkItemView;
  attempt: Attempt;
  links: AgentLink[];
  actions: CardActions;
  canResume: boolean;
  now: number;
}) {
  const { styles, theme, attempt, view, actions, links } = props;
  const claim = view.claim?.attemptId === attempt.id ? view.claim : undefined;
  const unknown = isAttemptOutcomeUnknown(attempt);
  const settled = isAttemptSettled(attempt);
  const pending = claim?.state === "pending";
  const localDevice = getKnownClientInstanceId();
  const initiatedHere = !attempt.initiatorClientInstanceId || (localDevice !== null && attempt.initiatorClientInstanceId === localDevice);
  // Abandon is driven by the attempt's own generation, not by whoever holds the claim now, so an
  // older attempt never becomes unactionable just because a newer one took over.
  const canAbandon = !settled;
  const abandonCertainty = isAttemptNotSubmitted(attempt) ? "not_submitted" : "outcome_unknown_confirmed";
  const orphanWorkspace = links.length === 0 && attempt.workspaceIdHint;
  const abandoned = attempt.userDisposition === "abandoned";
  const buttons = (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, justifyContent: "flex-end", marginLeft: "auto" }}>
      {pending && initiatedHere && !unknown && props.canResume && canResumeAttempt(attempt) ? (
        <TextAction theme={theme} small label="Resume launch" icon="Play" onPress={() => actions.resume(view, attempt)} />
      ) : null}
      {orphanWorkspace && actions.openWorkspace ? (
        <TextAction
          theme={theme}
          small
          label="Open workspace"
          icon="FolderOpen"
          accessibilityHint="No agent is linked to this attempt yet; this opens the workspace it named"
          onPress={() => actions.openWorkspace?.(attempt.workspaceIdHint!)}
        />
      ) : null}
      {canAbandon ? (
        <TextAction
          theme={theme}
          small
          kind="ghost"
          label={abandonCertainty === "not_submitted" ? "Discard" : "Abandon"}
          icon="Ban"
          accessibilityHint={abandonCertainty === "not_submitted" ? "Nothing was submitted for this attempt" : "Marks the attempt abandoned; a late workspace or agent may still appear"}
          onPress={() => actions.abandon(view, attempt, abandonCertainty)}
        />
      ) : (
        <TextAction theme={theme} small kind="ghost" label="Remove" icon="Trash2" accessibilityHint={TEXT.forgetAttemptWarning} onPress={() => actions.forget(view, attempt)} />
      )}
    </View>
  );
  // With one agent on the card, the Agent line above already opens it.
  const openPerLink = actions.openAgent && view.links.length > 1;
  return (
    <View style={[{ borderWidth: 1, borderColor: theme.colors.border, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8, gap: 4, marginBottom: 6 }, abandoned ? { opacity: 0.65 } : null]}>
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 12.5, fontWeight: "600", flexShrink: 1 }}>{summarize(attempt, links)}</Text>
        <Text style={styles.metaText}>{`${attempt.initiatorLabel} · ${formatRelativeTime(attempt.createdAt, props.now)} · ${attempt.id.slice(-6)}`}</Text>
        {abandoned ? <Badge styles={styles} theme={theme} label="Abandoned" icon="Ban" /> : null}
        {pending && !unknown ? <Badge styles={styles} theme={theme} label={initiatedHere ? "Preparing here" : "Preparing elsewhere"} icon="Hourglass" /> : null}
        {unknown ? <Badge styles={styles} theme={theme} label="Outcome unknown" icon="CircleHelp" tone="warning" /> : null}
      </View>
      {attempt.lastLaunchErrorCode ? <Text style={styles.warning}>Last launch error: {attempt.lastLaunchErrorCode}</Text> : null}
      {unknown && !settled ? <Text style={styles.warning}>{TEXT.unknownNotice}</Text> : null}
      {pending && !initiatedHere ? <Text style={styles.mono}>{TEXT.offlineJournalNotice}</Text> : null}
      {links.map((link, index) => {
        const state = DISPLAY_STATE_PRESENTATION[link.displayState];
        const duplicate = view.aggregate.duplicateAttemptIds.includes(link.attemptId);
        return (
          <View key={link.agentId} style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
            <View style={[styles.dot, { backgroundColor: theme.colors[DISPLAY_STATE_COLOR[link.displayState]] }]} />
            <Text style={{ color: theme.colors.foreground, fontSize: 12.5 }}>{state.label}</Text>
            <Text style={[styles.metaText, { flexShrink: 1 }]} numberOfLines={1}>
              {`· ${link.provider}${link.model ? ` · ${link.model}` : ""}`}
            </Text>
            {link.staleSince ? <Badge styles={styles} theme={theme} label={`Stale since ${formatTime(link.staleSince)}`} icon="CloudOff" tone="warning" /> : null}
            {duplicate ? <Badge styles={styles} theme={theme} label="Duplicate agent" icon="Copy" tone="warning" /> : null}
            {/* One way in: the agent view already sits inside its workspace. */}
            {openPerLink ? <TextAction theme={theme} small kind="ghost" label="Open agent" icon="Bot" onPress={() => actions.openAgent?.(link.agentId)} /> : null}
            {index === links.length - 1 ? buttons : null}
          </View>
        );
      })}
      {links.length === 0 ? buttons : null}
    </View>
  );
}

/** The card's text and images in the new-item text area; the agent and attempts step aside. */
function EditBody(props: PanelProps & { view: WorkItemView; onDone: () => void }) {
  const { styles, theme, view, actions } = props;
  const { item } = view;
  const { phone } = useOverlay();
  const imageStore = useTodoImageStore();
  const [text, setText] = useState(() => composeText(item));
  // A token in the text wins; otherwise the choice stands, so the pill stays usable on its own.
  const [priority, setPriority] = useState<WorkItemPriority>(item.priority);
  // Hydrated only once the stored bytes load, so a save before then leaves the images untouched.
  const [hydrated, setHydrated] = useState(false);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<TextInput | null>(null);
  const [initialFiles] = useState(() => item.files.map(refToDraftFile));
  const drafts = useDraftAttachments(hydrated, { files: initialFiles });
  const resetDrafts = drafts.reset;
  useEffect(() => {
    if (hydrated || !imageStore.ready) return;
    resetDrafts({ images: imageStore.resolve(item.images) });
    setHydrated(true);
  }, [hydrated, imageStore, item.images, resetDrafts]);

  const draft = parseQuickAdd(text);
  const effectivePriority = draft.priorityToken ? draft.priority : priority;
  const invalid = validateWorkItemFields({ title: draft.title, details: draft.details, defaultPrompt: item.defaultPrompt });
  const canSave = !invalid && !busy && !drafts.uploading;
  const refocus = () => {
    if (!phone) inputRef.current?.focus();
  };

  async function save() {
    if (!canSave) return;
    setBusy(true);
    try {
      const ok = await actions.save(view, {
        title: draft.title.trim(),
        details: draft.details,
        defaultPrompt: item.defaultPrompt,
        priority: effectivePriority,
        images: hydrated ? drafts.images : null,
        files: drafts.files.map(draftToFileRef),
      });
      if (ok) props.onDone();
    } finally {
      setBusy(false);
    }
  }

  const problem = fieldProblem(invalid);
  return (
    <OverlayBox
      size="wide"
      accessibilityLabel={`Edit #${item.number}`}
      scroll={false}
      nativeID={drafts.targetId}
      cover={drafts.dragging ? <DropHint theme={theme} /> : null}
      meta={<PanelMeta theme={theme} view={view} projectAvailable={props.projectAvailable} editing />}
    >
      <CardTextArea
        theme={theme}
        inputRef={inputRef}
        value={text}
        onChangeText={setText}
        placeholder={PLACEHOLDER}
        accessibilityLabel="Content"
        autoFocus
        onSubmitKey={() => void save()}
      />
      <DraftAttachmentRow styles={styles} theme={theme} drafts={drafts} loading={!hydrated} />
      {problem ? <Text style={[styles.warning, { marginTop: 8 }]}>{problem}</Text> : null}
      {item.defaultPrompt ? <InlineNote theme={theme} kind="info">{TEXT.customPromptNotice}</InlineNote> : null}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 10 }}>
        <AttachButton theme={theme} drafts={drafts} disabled={!hydrated} onPicked={refocus} />
        <PillStrip theme={theme}>
          <StatusPill theme={theme} status={item.status} onSelect={(status) => actions.move(view, status)} onClosed={refocus} />
          <PriorityPill theme={theme} priority={effectivePriority} token={draft.priorityToken} onSelect={setPriority} onClosed={refocus} />
        </PillStrip>
        <TextAction theme={theme} label="Discard" kind="ghost" disabled={busy} onPress={props.onDone} />
        <IconAction theme={theme} icon="Check" label="Save" tip="Save" keys={KEYS.submit} kind="round" disabled={!canSave} onPress={() => void save()} />
      </View>
    </OverlayBox>
  );
}
