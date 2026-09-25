import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { TextInput as HostTextInput } from "@getpaseo/plugin/client/react-native";
import { Text, View, type NativeSyntheticEvent, type TextInput, type TextInputKeyPressEventData, type TextStyle } from "react-native";
import { validateWorkItemFields } from "../shared/limits";
import { WORK_ITEM_PRIORITIES, WORK_ITEM_STATUSES, type WorkItem, type WorkItemPriority, type WorkItemStatus } from "../shared/schema";
import { WORK_ITEM_PRIORITY_LABELS, WORK_ITEM_STATUS_LABELS } from "../shared/board";
import type { WorkItemFileInput } from "../shared/contracts";
import { AttachmentStrip, useDraftAttachments, type DraftAttachments } from "./attachments";
import { canPickFiles, draftToFileRef, type DraftFile } from "./files";
import { EdgeFade, PillSelect, PillStrip, WEB_TEXT_INPUT, useBoxMenu, type MenuItem } from "./floating-menu";
import { canPasteImages, canTakeImages, type DraftImage } from "./images";
import { EmbeddedBox, Overlay, OverlayBox, useBox, useOverlay } from "./overlay";
import { IconAction, KEYS } from "./overlay-parts";
import { parseQuickAdd, priorityTokenFor } from "./quick-add";
import type { ProjectRecord } from "./projects";
import type { TodoStyles } from "./styles";
import { PRIORITY_PRESENTATION, STATUS_PRESENTATION } from "./text";
import { scrollTopOfWeb } from "./web";

/** The card as one block of text: the title, then whatever detail it already carries. */
export function composeText(item: WorkItem): string {
  const token = priorityTokenFor(item.priority);
  const title = token ? `${item.title} ${token}` : item.title;
  return item.details ? `${title}\n${item.details}` : title;
}

/** New work starts in one of these; later columns are reached by moving the card. */
export type StartingStatus = "backlog" | "todo";
const STARTING_STATUSES = ["todo", "backlog"] as const;

export interface EditorSubmit {
  projectId: string;
  projectNameSnapshot: string;
  projectRootSnapshot?: string;
  title: string;
  details: string;
  defaultPrompt: string;
  /** The full desired image set with in-memory bytes. */
  images: DraftImage[];
  /** Attached files, already on the daemon host. */
  files: WorkItemFileInput[];
  status: StartingStatus;
  priority: WorkItemPriority;
  /** Create, then open the execute box for the new card. */
  execute: boolean;
}

/** Paths read shorter with the home folder as `~`, the way a shell prompt shows them. */
export function shortPath(path: string): string {
  return path.replace(/^\/(?:home|Users)\/[^/]+(?=\/|$)/, "~").replace(/^\/root(?=\/|$)/, "~");
}

/** Every project as a menu row, by name, with its path underneath. */
export function projectItems(projects: Map<string, ProjectRecord>, current: string | null): MenuItem[] {
  return [...projects.values()]
    .sort((left, right) => left.projectDisplayName.localeCompare(right.projectDisplayName))
    .map((project) => ({
      key: project.projectId,
      label: project.projectDisplayName,
      hint: shortPath(project.projectRootPath),
      mono: true,
      icon: "Folder",
      checked: project.projectId === current,
    }));
}

export function statusItems(theme: PluginTheme, statuses: readonly WorkItemStatus[], current: WorkItemStatus | null): MenuItem[] {
  return statuses.map((status) => ({
    key: status,
    label: WORK_ITEM_STATUS_LABELS[status],
    icon: STATUS_PRESENTATION[status].icon,
    iconColor: theme.colors[STATUS_PRESENTATION[status].color],
    checked: status === current,
  }));
}

export function priorityItems(theme: PluginTheme, current: WorkItemPriority): MenuItem[] {
  return WORK_ITEM_PRIORITIES.map((priority) => {
    const shortcut = priorityTokenFor(priority);
    return {
      key: priority,
      label: WORK_ITEM_PRIORITY_LABELS[priority],
      icon: PRIORITY_PRESENTATION[priority].icon,
      iconColor: theme.colors[PRIORITY_PRESENTATION[priority].color],
      checked: priority === current,
      ...(shortcut ? { shortcut } : {}),
    };
  });
}

/** The status pill of an existing card: every column. */
export function StatusPill(props: { theme: PluginTheme; status: WorkItemStatus; onSelect: (status: WorkItemStatus) => void; onClosed?: () => void }) {
  const { theme, status } = props;
  return (
    <PillSelect
      theme={theme}
      label="Status"
      icon={STATUS_PRESENTATION[status].icon}
      iconColor={theme.colors[STATUS_PRESENTATION[status].color]}
      text={WORK_ITEM_STATUS_LABELS[status]}
      items={statusItems(theme, WORK_ITEM_STATUSES, status)}
      onSelect={(key) => key !== status && props.onSelect(key as WorkItemStatus)}
      {...(props.onClosed ? { onClosed: props.onClosed } : {})}
    />
  );
}

export function PriorityPill(props: { theme: PluginTheme; priority: WorkItemPriority; token?: string | null; onSelect: (priority: WorkItemPriority) => void; onClosed?: () => void }) {
  const { theme, priority } = props;
  return (
    <PillSelect
      theme={theme}
      label="Priority"
      icon={PRIORITY_PRESENTATION[priority].icon}
      iconColor={theme.colors[PRIORITY_PRESENTATION[priority].color]}
      text={WORK_ITEM_PRIORITY_LABELS[priority]}
      token={props.token ?? null}
      items={priorityItems(theme, priority)}
      onSelect={(key) => props.onSelect(key as WorkItemPriority)}
      {...(props.onClosed ? { onClosed: props.onClosed } : {})}
    />
  );
}

const LINE_HEIGHT = 22;
const FADE_SLACK = LINE_HEIGHT / 2;

/** Mod+Enter submits, as in the host composer; with Shift it also runs. A plain Enter is a new line. */
export function submitKeyOf(event: NativeSyntheticEvent<TextInputKeyPressEventData>): "submit" | "run" | null {
  const native = event.nativeEvent as TextInputKeyPressEventData & { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; isComposing?: boolean; keyCode?: number };
  if (native.isComposing || native.keyCode === 229) return null;
  if (native.key !== "Enter" || !(native.metaKey || native.ctrlKey)) return null;
  return native.shiftKey ? "run" : "submit";
}

/**
 * A card's text, growing with its content between a floor and whatever the box leaves it, then
 * scrolling on its own while everything under it stays in view. The rest of the box is measured as
 * the box's height minus this area's, so it adapts to images and notes coming and going.
 */
export function CardTextArea(props: {
  theme: PluginTheme;
  inputRef: MutableRefObject<TextInput | null>;
  value: string;
  onChangeText: (text: string) => void;
  placeholder: string;
  accessibilityLabel: string;
  /** Focus on open, with the caret after the text. */
  autoFocus: boolean;
  onSubmitKey?: (kind: "submit" | "run") => void;
  editable?: boolean;
}) {
  const { theme } = props;
  const box = useBox();
  const minText = (box.phone ? 2 : 3) * LINE_HEIGHT;
  // A box that shares its space, such as the header panel, caps the text at a number of lines.
  const lineCap = box.maxLines ? box.maxLines * LINE_HEIGHT : Number.MAX_SAFE_INTEGER;
  const [contentHeight, setContentHeight] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [caret, setCaret] = useState<{ start: number; end: number } | undefined>(props.autoFocus ? { start: props.value.length, end: props.value.length } : undefined);
  const rendered = useRef(minText);
  const chrome = box.height > 0 ? box.height - rendered.current : 0;
  const maxText = Math.max(minText, Math.min(lineCap, box.maxHeight - chrome));
  const height = Math.min(Math.max(contentHeight, minText), maxText);
  rendered.current = height;
  const overflowing = contentHeight > height + 1;
  const textStyle: TextStyle = { color: theme.colors.foreground, fontSize: 14.5, lineHeight: LINE_HEIGHT, paddingHorizontal: 2, paddingVertical: 0 };
  const inputRef = props.inputRef;

  // A dialog that closed as this one opened (the command center) hands focus back to where it came
  // from after this area took it; take it back once that has settled.
  useEffect(() => {
    if (!props.autoFocus) return undefined;
    const timer = setTimeout(() => {
      if (!inputRef.current?.isFocused()) inputRef.current?.focus();
    }, 350);
    return () => clearTimeout(timer);
  }, [props.autoFocus, inputRef]);

  return (
    <View style={{ height }}>
      {/* An invisible copy of the text measures how tall it wants to be; a text area only grows. */}
      <Text
        aria-hidden
        pointerEvents="none"
        onLayout={(event) => setContentHeight(Math.ceil(event.nativeEvent.layout.height))}
        style={[textStyle, { position: "absolute", top: 0, left: 0, right: 0, opacity: 0 }]}
      >
        {`${props.value || props.placeholder}${props.value.endsWith("\n") ? " " : ""}`}
      </Text>
      {/* The host's input: inside a host sheet it keeps the keyboard from covering the box. */}
      <HostTextInput
        ref={inputRef}
        accessibilityLabel={props.accessibilityLabel}
        value={props.value}
        editable={props.editable ?? true}
        onChangeText={(next) => {
          props.onChangeText(next);
          setCaret(undefined);
        }}
        selection={caret}
        onSelectionChange={() => setCaret(undefined)}
        onKeyPress={(event) => {
          const kind = submitKeyOf(event);
          if (!kind || !props.onSubmitKey) return;
          event.preventDefault();
          props.onSubmitKey(kind);
        }}
        onScroll={(event) => setScrollTop((event.nativeEvent as { contentOffset?: { y: number } }).contentOffset?.y ?? scrollTopOfWeb(event) ?? 0)}
        multiline
        autoFocus={props.autoFocus}
        placeholder={props.placeholder}
        placeholderTextColor={theme.colors.foregroundMuted}
        underlineColorAndroid="transparent"
        style={[textStyle, { height, textAlignVertical: "top", borderWidth: 0, backgroundColor: "transparent" }, WEB_TEXT_INPUT]}
      />
      {/* The measured copy can differ from the text area by a few pixels, so small gaps show no fade. */}
      {overflowing && scrollTop > FADE_SLACK ? <EdgeFade side="top" color={theme.colors.surface0} size={30} /> : null}
      {overflowing && contentHeight - height - scrollTop > FADE_SLACK ? <EdgeFade side="bottom" color={theme.colors.surface0} size={30} /> : null}
    </View>
  );
}

/** Attached images and files under the text, or a note while an existing card's image bytes load. */
export function DraftAttachmentRow(props: { styles: TodoStyles; theme: PluginTheme; drafts: DraftAttachments; loading?: boolean }) {
  const box = useBox();
  const { drafts } = props;
  if (props.loading) return <Text style={[props.styles.mono, { marginTop: 8 }]}>Loading images…</Text>;
  if (drafts.images.length === 0 && drafts.files.length === 0) return null;
  return (
    <View style={{ marginTop: 4 }}>
      <AttachmentStrip
        styles={props.styles}
        theme={props.theme}
        images={drafts.images}
        files={drafts.files}
        onRemoveImage={drafts.removeImage}
        onRemoveFile={drafts.removeFile}
        size={box.phone ? 48 : 60}
      />
    </View>
  );
}

/** Dashed outline over the whole box while files are dragged over it. */
export function DropHint(props: { theme: PluginTheme }) {
  const { theme } = props;
  return (
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        top: 6,
        left: 6,
        right: 6,
        bottom: 6,
        zIndex: 2,
        borderRadius: 12,
        borderWidth: 1.5,
        borderStyle: "dashed",
        borderColor: theme.colors.accent,
        backgroundColor: theme.colors.surface0,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Icon name="Paperclip" size={16} color={theme.colors.accent} />
        <Text style={{ color: theme.colors.accent, fontSize: 13, fontWeight: "600" }}>Drop images or files to attach</Text>
      </View>
    </View>
  );
}

const ATTACH_ITEMS: readonly MenuItem[] = [
  ...(canTakeImages() ? [{ key: "images", label: "Add images", icon: "Image" }] : []),
  ...(canPickFiles() ? [{ key: "files", label: "Add files", icon: "Paperclip" }] : []),
];

/**
 * The "+" that attaches images and files, as the host composer's does: a menu of what this runtime
 * can choose, or straight to the chooser when there is only one.
 */
export function AttachButton(props: { theme: PluginTheme; drafts: DraftAttachments; disabled?: boolean; onPicked?: () => void }) {
  const { drafts } = props;
  const button = useRef<View | null>(null);
  const pick = (key: string) => void (key === "files" ? drafts.pickFiles() : drafts.pickImages()).then(() => props.onPicked?.());
  const menu = useBoxMenu({ theme: props.theme, label: "Attach", items: ATTACH_ITEMS, onSelect: pick });
  const only = ATTACH_ITEMS.length === 1 ? ATTACH_ITEMS[0] : undefined;
  if (ATTACH_ITEMS.length === 0) return null;
  return (
    <>
      <View ref={button} collapsable={false}>
        <IconAction
          theme={props.theme}
          icon="Plus"
          label={only?.label ?? "Attach"}
          tip={only?.label ?? "Add images or files"}
          kind="plain"
          align="start"
          disabled={Boolean(props.disabled) || drafts.picking || drafts.full}
          onPress={() => (only ? pick(only.key) : void menu.toggle(button.current))}
        />
      </View>
      {menu.node}
    </>
  );
}

/** Why the fields cannot be saved, in one line, unless they are simply empty. */
export function fieldProblem(invalid: ReturnType<typeof validateWorkItemFields>): string | null {
  return invalid && invalid.reason !== "empty" ? `${invalid.field} is ${invalid.reason.replace("_", " ")}.` : null;
}

export const PLACEHOLDER = `What needs to happen?\nFirst line is the title · !1–!4 sets priority${canPasteImages() ? " · paste or drop files" : ""}`;

/** What a new-item form holds; kept when it closes without creating, so it comes back. */
export interface NewItemDraft {
  text: string;
  images: DraftImage[];
  /** Only files already on the host: an upload stops when the form goes away. */
  files: DraftFile[];
  projectId: string | null;
  status: StartingStatus;
  priority: WorkItemPriority;
}

/** The New box's draft. Kept for this app session only. */
let newItemDraft: NewItemDraft | null = null;
/** The header panels' drafts, one per project, apart from the New box's. */
const panelDrafts = new Map<string, NewItemDraft>();

function worthKeeping(draft: NewItemDraft): NewItemDraft | null {
  return draft.text.trim() || draft.images.length > 0 || draft.files.length > 0 ? draft : null;
}

interface EditorProps {
  styles: TodoStyles;
  theme: PluginTheme;
  open: boolean;
  onClose: () => void;
  projects: Map<string, ProjectRecord>;
  initialProjectId: string | null;
  /** Column the new item lands in, unless a kept draft says otherwise. */
  initialStatus: StartingStatus;
  onSubmit: (input: EditorSubmit) => Promise<boolean>;
}

/**
 * The new-item box: the text on top, attached images under it, and one row of tools with "+",
 * the project, column and priority, then create-and-run and create. Existing cards are edited in
 * the card panel, with the same text area.
 */
export function WorkItemEditor(props: EditorProps) {
  return (
    <Overlay theme={props.theme} open={props.open} onClose={props.onClose} variant="box" accessibilityLabel="New todo">
      <NewItemBox {...props} />
    </Overlay>
  );
}

function NewItemBox(props: EditorProps) {
  const { phone } = useOverlay();
  const [initial] = useState<NewItemDraft>(
    () => newItemDraft ?? { text: "", images: [], files: [], projectId: props.initialProjectId, status: props.initialStatus, priority: "none" },
  );
  return (
    <NewItemForm
      styles={props.styles}
      theme={props.theme}
      container="overlay"
      phone={phone}
      projects={props.projects}
      initial={{ ...initial, projectId: initial.projectId ?? props.initialProjectId }}
      onSubmit={props.onSubmit}
      afterSubmit={props.onClose}
      keep={(draft) => {
        newItemDraft = draft;
      }}
      autoFocus
    />
  );
}

/**
 * The same form embedded in a host surface — the workspace header panel: its project is the
 * workspace's and cannot change, it stays open after each card so several go down in a row, and
 * what is left unwritten waits for the panel's next opening.
 */
export function EmbeddedNewItem(props: {
  styles: TodoStyles;
  theme: PluginTheme;
  phone: boolean;
  project: LockedProject;
  /** Called with a created card's input; `execute` asks the caller to open the execute box. */
  onSubmit: (input: EditorSubmit) => Promise<boolean>;
}) {
  const key = props.project.projectId;
  const [initial] = useState<NewItemDraft>(() => panelDrafts.get(key) ?? { text: "", images: [], files: [], projectId: key, status: "todo", priority: "none" });
  return (
    <NewItemForm
      styles={props.styles}
      theme={props.theme}
      container="embedded"
      phone={props.phone}
      projects={EMPTY_PROJECTS}
      lockedProject={props.project}
      initial={initial}
      onSubmit={props.onSubmit}
      keep={(draft) => {
        if (draft) panelDrafts.set(key, draft);
        else panelDrafts.delete(key);
      }}
      // Phones keep the keyboard down, so it does not cover the list the panel opened to show.
      autoFocus={!props.phone}
      createNote={`New todo anywhere ${KEYS.newItem}`}
    />
  );
}

/** A project fixed by where the form is, not chosen in it. */
export interface LockedProject {
  projectId: string;
  projectDisplayName: string;
  projectRootPath?: string;
}

const EMPTY_PROJECTS = new Map<string, ProjectRecord>();

/**
 * The new-item form both boxes share. With `afterSubmit` it hands over after a card is created,
 * as the New box closes; without it, it clears itself for the next card.
 */
function NewItemForm(props: {
  styles: TodoStyles;
  theme: PluginTheme;
  container: "overlay" | "embedded";
  phone: boolean;
  projects: Map<string, ProjectRecord>;
  lockedProject?: LockedProject;
  initial: NewItemDraft;
  onSubmit: (input: EditorSubmit) => Promise<boolean>;
  afterSubmit?: () => void;
  /** Stores what the form holds when it goes away, or null once there is nothing to keep. */
  keep: (draft: NewItemDraft | null) => void;
  autoFocus: boolean;
  /** A second line in the create button's tooltip. */
  createNote?: string;
}) {
  const { styles, theme, initial } = props;
  const [text, setText] = useState(initial.text);
  const [projectId, setProjectId] = useState<string | null>(initial.projectId);
  const [status, setStatus] = useState<StartingStatus>(initial.status);
  // A token in the text wins; otherwise the choice stands, so the pill stays usable on its own.
  const [priority, setPriority] = useState<WorkItemPriority>(initial.priority);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<TextInput | null>(null);
  const drafts = useDraftAttachments(true, { images: initial.images, files: initial.files });

  // Going away without creating keeps what was written; creating clears it.
  const submitted = useRef(false);
  const snapshot = useRef<NewItemDraft>(initial);
  snapshot.current = { text, images: drafts.images, files: drafts.files.filter((file) => file.ready), projectId, status, priority };
  const keep = useRef(props.keep);
  keep.current = props.keep;
  useEffect(
    () => () => {
      keep.current(submitted.current ? null : worthKeeping(snapshot.current));
    },
    [],
  );

  const draft = parseQuickAdd(text);
  const effectivePriority = draft.priorityToken ? draft.priority : priority;
  const invalid = validateWorkItemFields({ title: draft.title, details: draft.details, defaultPrompt: "" });
  const chosen = projectId ? props.projects.get(projectId) : undefined;
  const project: LockedProject | undefined = props.lockedProject ?? chosen;
  const canSubmit = !invalid && Boolean(project) && !busy && !drafts.uploading;
  const projects = useMemo(() => projectItems(props.projects, projectId), [props.projects, projectId]);
  // Typing continues after a menu; phones keep the keyboard down until the text is tapped.
  const refocus = () => {
    if (!props.phone) inputRef.current?.focus();
  };

  async function submit(execute: boolean) {
    if (!project || invalid || busy) return;
    setBusy(true);
    try {
      const ok = await props.onSubmit({
        projectId: project.projectId,
        projectNameSnapshot: project.projectDisplayName,
        ...(project.projectRootPath ? { projectRootSnapshot: project.projectRootPath } : {}),
        title: draft.title.trim(),
        details: draft.details,
        defaultPrompt: "",
        images: drafts.images,
        files: drafts.files.map(draftToFileRef),
        status,
        priority: effectivePriority,
        execute,
      });
      if (!ok) return;
      keep.current(null);
      if (props.afterSubmit) {
        submitted.current = true;
        props.afterSubmit();
        return;
      }
      // Ready for the next one, in the same column. The kept snapshot empties now: "create and
      // run" may close the panel before the cleared form renders.
      snapshot.current = { text: "", images: [], files: [], projectId, status, priority: "none" };
      setText("");
      setPriority("none");
      drafts.reset({ images: [], files: [] });
      refocus();
    } finally {
      setBusy(false);
    }
  }

  const problem = fieldProblem(invalid);
  const fields = (
    <>
      <CardTextArea
        theme={theme}
        inputRef={inputRef}
        value={text}
        onChangeText={setText}
        placeholder={PLACEHOLDER}
        accessibilityLabel="What needs to happen"
        autoFocus={props.autoFocus}
        onSubmitKey={(kind) => void submit(kind === "run")}
      />
      <DraftAttachmentRow styles={styles} theme={theme} drafts={drafts} />
      {problem ? <Text style={[styles.warning, { marginTop: 8 }]}>{problem}</Text> : null}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 10 }}>
        <AttachButton theme={theme} drafts={drafts} onPicked={refocus} />
        <PillStrip theme={theme}>
          {/* A locked project is the workspace's own; the card goes there without a pill to say so. */}
          {props.lockedProject ? null : (
            <PillSelect
              theme={theme}
              label="Project"
              icon="Folder"
              text={chosen?.projectDisplayName ?? "Choose project"}
              muted={!chosen}
              items={projects}
              onSelect={setProjectId}
              filter={{ placeholder: "Filter projects…", noun: "projects" }}
              onClosed={refocus}
            />
          )}
          <PillSelect
            theme={theme}
            label="Column"
            icon={STATUS_PRESENTATION[status].icon}
            iconColor={theme.colors[STATUS_PRESENTATION[status].color]}
            text={WORK_ITEM_STATUS_LABELS[status]}
            items={statusItems(theme, STARTING_STATUSES, status)}
            onSelect={(key) => setStatus(key as StartingStatus)}
            onClosed={refocus}
          />
          <PriorityPill theme={theme} priority={effectivePriority} token={draft.priorityToken} onSelect={setPriority} onClosed={refocus} />
        </PillStrip>
        <IconAction theme={theme} icon="Play" label="Create and run" tip="Create & run" keys={KEYS.run} kind="outline" disabled={!canSubmit} onPress={() => void submit(true)} />
        <IconAction
          theme={theme}
          icon="ArrowUp"
          label="Create"
          tip="Create"
          keys={KEYS.submit}
          {...(props.createNote ? { tipNote: props.createNote } : {})}
          kind="round"
          disabled={!canSubmit}
          onPress={() => void submit(false)}
        />
      </View>
    </>
  );
  const cover = drafts.dragging ? <DropHint theme={theme} /> : null;
  return props.container === "overlay" ? (
    <OverlayBox size="wide" accessibilityLabel="New todo" scroll={false} nativeID={drafts.targetId} cover={cover}>
      {fields}
    </OverlayBox>
  ) : (
    <EmbeddedBox theme={theme} phone={props.phone} maxLines={8} nativeID={drafts.targetId} cover={cover}>
      {fields}
    </EmbeddedBox>
  );
}
