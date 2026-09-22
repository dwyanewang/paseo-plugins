import type { PluginTheme } from "@getpaseo/plugin";
import { Modal, useToast } from "@getpaseo/plugin/client/react-native";
import { useEffect, useMemo, useState } from "react";
import { Image, Text, View } from "react-native";
import { IMAGE_MAX_COUNT, validateWorkItemFields, validateWorkItemImages } from "../shared/limits";
import { WORK_ITEM_PRIORITIES, type WorkItem, type WorkItemPriority } from "../shared/schema";
import { WORK_ITEM_PRIORITY_LABELS, WORK_ITEM_STATUS_LABELS } from "../shared/board";
import { Button, DialogActions, Field, IconButton, Notice, Select } from "./components";
import { imageDataUri, pickImageDrafts, useTodoImageStore, type DraftImage } from "./images";
import { parseQuickAdd, priorityTokenFor } from "./quick-add";
import { InfoRow, RowGroup, SelectRow } from "./select-row";
import type { ProjectRecord } from "./projects";
import type { TodoStyles } from "./styles";
import { PRIORITY_PRESENTATION, STATUS_PRESENTATION, TEXT } from "./text";

/** The card as one block of text: the title, then whatever detail it already carries. */
function composeText(item: WorkItem | null): string {
  if (!item) return "";
  const token = priorityTokenFor(item.priority);
  const title = token ? `${item.title} ${token}` : item.title;
  return item.details ? `${title}\n${item.details}` : title;
}

/** New work starts in one of these; later columns are reached by moving the card. */
export type StartingStatus = "backlog" | "todo";
const STARTING_STATUSES = ["backlog", "todo"] as const;

export interface EditorSubmit {
  projectId: string;
  projectNameSnapshot: string;
  projectRootSnapshot?: string;
  title: string;
  details: string;
  defaultPrompt: string;
  /** The full desired image set with in-memory bytes, or null to leave stored images unchanged. */
  images: DraftImage[] | null;
  status: StartingStatus;
  priority: WorkItemPriority;
  /** Create, then open the execute dialog for the new card. */
  execute: boolean;
}

export function WorkItemEditor(props: {
  styles: TodoStyles;
  theme: PluginTheme;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: Map<string, ProjectRecord>;
  initialProjectId: string | null;
  /** Column a new item lands in; ignored when editing. */
  initialStatus: StartingStatus;
  item: WorkItem | null;
  onSubmit: (input: EditorSubmit) => Promise<boolean>;
}) {
  const { styles, theme, item } = props;
  const toast = useToast();
  const imageStore = useTodoImageStore();
  const [text, setText] = useState(() => composeText(item));
  const [projectId, setProjectId] = useState<string | null>(item?.projectId ?? props.initialProjectId);
  const [status, setStatus] = useState<StartingStatus>(props.initialStatus);
  // A token in the text wins; otherwise the choice stands, so the row stays usable on its own.
  const [priority, setPriority] = useState<WorkItemPriority>(item?.priority ?? "none");
  const [images, setImages] = useState<DraftImage[]>([]);
  // A new item is hydrated at once (it starts empty); an existing item is hydrated only after its
  // bytes load, so a save before then leaves the stored images untouched rather than wiping them.
  const [hydrated, setHydrated] = useState(false);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!props.open) return;
    setText(composeText(item));
    setProjectId(item?.projectId ?? props.initialProjectId);
    setStatus(props.initialStatus);
    setPriority(item?.priority ?? "none");
    setImages([]);
    setHydrated(!item);
  }, [props.open, item, props.initialProjectId, props.initialStatus]);
  // Hydrate existing images once the bytes document is available.
  useEffect(() => {
    if (!props.open || hydrated || !item || !imageStore.ready) return;
    setImages(imageStore.resolve(item.images));
    setHydrated(true);
  }, [props.open, hydrated, item, imageStore]);

  async function addImages() {
    if (picking) return;
    setPicking(true);
    try {
      const picked = await pickImageDrafts();
      if (picked === null) {
        toast.error("Adding images needs the desktop or web app.");
        return;
      }
      if (picked.length === 0) return;
      setImages((current) => {
        const merged = [...current];
        for (const draft of picked) {
          if (merged.length >= IMAGE_MAX_COUNT) break;
          merged.push(draft);
        }
        const invalid = validateWorkItemImages(merged);
        if (invalid) {
          toast.error(
            invalid.reason === "too_many"
              ? `Up to ${IMAGE_MAX_COUNT} images per card.`
              : invalid.reason === "too_large"
                ? "That image is too large to attach."
                : invalid.reason === "unsupported_type"
                  ? "Only PNG, JPEG, GIF, and WebP images are supported."
                  : "That image could not be read.",
          );
          return current;
        }
        return merged;
      });
    } finally {
      setPicking(false);
    }
  }

  function removeImage(id: string) {
    setImages((current) => current.filter((image) => image.id !== id));
  }
  const draft = parseQuickAdd(text);
  const { title, details } = draft;
  const defaultPrompt = item?.defaultPrompt ?? "";
  const effectivePriority = draft.priorityToken ? draft.priority : priority;
  const invalid = validateWorkItemFields({ title, details, defaultPrompt });
  const options = useMemo(
    () =>
      [...props.projects.values()]
        .sort((left, right) => left.projectDisplayName.localeCompare(right.projectDisplayName))
        .map((project) => ({ value: project.projectId, label: project.projectDisplayName, hint: project.projectRootPath })),
    [props.projects],
  );
  const project = projectId ? props.projects.get(projectId) : undefined;
  const canSubmit = !invalid && Boolean(project) && !busy;

  async function submit(execute: boolean) {
    if (!project || invalid) return;
    setBusy(true);
    try {
      const ok = await props.onSubmit({
        projectId: project.projectId,
        projectNameSnapshot: project.projectDisplayName,
        projectRootSnapshot: project.projectRootPath,
        title: title.trim(),
        details,
        defaultPrompt,
        images: hydrated ? images : null,
        status,
        priority: effectivePriority,
        execute,
      });
      if (ok) props.onOpenChange(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={item ? `Edit #${item.number}` : "New todo"} open={props.open} onOpenChange={props.onOpenChange}>
      <Modal.Content>
        <Field
          styles={styles}
          theme={theme}
          label={item ? "Content" : "What needs to happen"}
          value={text}
          onChangeText={setText}
          multiline
          autoFocus={!item}
          placeholder={"Cursor-paginate the device list !2\nThe offset pages get slow past a few thousand rows."}
          hint="The first line is the title, the rest is detail. Running the item sends all of it."
        />
        {title ? (
          <View style={[styles.row, { gap: 8 }]}>
            <Text style={styles.fieldLabel}>Title</Text>
            <Text numberOfLines={1} style={[styles.body, { flex: 1, fontWeight: "600" }]}>
              {title}
            </Text>
          </View>
        ) : null}
        {defaultPrompt ? (
          <Notice styles={styles} theme={theme}>
            {TEXT.customPromptNotice}
          </Notice>
        ) : null}
        <RowGroup styles={styles}>
          {item ? (
            <InfoRow styles={styles} label="Project">
              <Text style={[styles.rowValue, { color: theme.colors.foregroundMuted }]} numberOfLines={1}>
                {item.projectNameSnapshot}
              </Text>
            </InfoRow>
          ) : (
            <SelectRow styles={styles} theme={theme} label="Project" value={projectId} placeholder="Choose a project" options={options} onChange={setProjectId} />
          )}
          {!item ? (
            <SelectRow
              styles={styles}
              theme={theme}
              label="Column"
              value={status}
              options={STARTING_STATUSES.map((entry) => ({
                value: entry,
                label: WORK_ITEM_STATUS_LABELS[entry],
                icon: STATUS_PRESENTATION[entry].icon,
                iconColor: theme.colors[STATUS_PRESENTATION[entry].color],
              }))}
              onChange={setStatus}
            />
          ) : null}
          <SelectRow
            styles={styles}
            theme={theme}
            label={draft.priorityToken ? `Priority (${draft.priorityToken})` : "Priority"}
            value={effectivePriority}
            options={WORK_ITEM_PRIORITIES.map((entry) => ({
              value: entry,
              label: WORK_ITEM_PRIORITY_LABELS[entry],
              icon: PRIORITY_PRESENTATION[entry].icon,
              iconColor: theme.colors[PRIORITY_PRESENTATION[entry].color],
            }))}
            onChange={setPriority}
          />
        </RowGroup>
        <View style={{ gap: 8 }}>
          <View style={[styles.row, { justifyContent: "space-between" }]}>
            <Text style={styles.fieldLabel}>{`Images${images.length > 0 ? ` (${images.length}/${IMAGE_MAX_COUNT})` : ""}`}</Text>
            <Button
              styles={styles}
              theme={theme}
              label={picking ? "Choosing…" : "Add image"}
              icon="ImagePlus"
              onPress={() => void addImages()}
              disabled={picking || !hydrated || images.length >= IMAGE_MAX_COUNT}
              accessibilityHint="Attach images that describe this work; they are sent to the agent on a direct run"
            />
          </View>
          {item && !hydrated ? (
            <Text style={styles.mono}>Loading images…</Text>
          ) : images.length > 0 ? (
            <View style={[styles.rowWrap, { gap: 8 }]}>
              {images.map((image) => (
                <View key={image.id} style={{ width: 72 }}>
                  <Image
                    source={{ uri: imageDataUri(image) }}
                    style={{ width: 72, height: 72, borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border }}
                    accessibilityLabel={image.name ?? "Attached image"}
                    resizeMode="cover"
                  />
                  <View style={{ position: "absolute", top: 2, right: 2 }}>
                    <IconButton styles={styles} theme={theme} icon="X" label="Remove image" onPress={() => removeImage(image.id)} bordered />
                  </View>
                </View>
              ))}
            </View>
          ) : (
            <Text style={styles.mono}>Optional. PNG, JPEG, GIF, or WebP; sent to the agent when you run this card.</Text>
          )}
        </View>
        {item ? <Text style={styles.mono}>Use Rebind project in the card detail to move it to another project.</Text> : null}
        {invalid && invalid.reason !== "empty" ? (
          <Notice styles={styles} theme={theme} kind="warning">{`${invalid.field} is ${invalid.reason.replace("_", " ")}.`}</Notice>
        ) : null}
        <DialogActions styles={styles}>
          <Button styles={styles} theme={theme} label="Cancel" onPress={() => props.onOpenChange(false)} />
          {!item ? (
            <Button styles={styles} theme={theme} label="Create and execute" icon="Play" onPress={() => void submit(true)} disabled={!canSubmit} accessibilityHint="Creates the item, then opens the execute dialog for it" />
          ) : null}
          <Button styles={styles} theme={theme} label={item ? "Save" : "Create"} onPress={() => void submit(false)} variant="primary" disabled={!canSubmit} />
        </DialogActions>
      </Modal.Content>
    </Modal>
  );
}

export function RebindModal(props: {
  styles: TodoStyles;
  theme: PluginTheme;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: Map<string, ProjectRecord>;
  item: WorkItem | null;
  onSubmit: (project: { projectId: string; projectNameSnapshot: string; projectRootSnapshot?: string }) => Promise<boolean>;
}) {
  const { styles, theme, item } = props;
  const [projectId, setProjectId] = useState<string | null>(null);
  useEffect(() => {
    if (props.open) setProjectId(null);
  }, [props.open]);
  const options = useMemo(
    () =>
      [...props.projects.values()]
        .filter((project) => project.projectId !== item?.projectId)
        .sort((left, right) => left.projectDisplayName.localeCompare(right.projectDisplayName))
        .map((project) => ({
          value: project.projectId,
          label:
            item?.projectRootSnapshot && project.projectRootPath === item.projectRootSnapshot
              ? `${project.projectDisplayName} (same path as before)`
              : project.projectDisplayName,
          hint: project.projectRootPath,
        })),
    [props.projects, item],
  );
  const project = projectId ? props.projects.get(projectId) : undefined;
  return (
    <Modal title="Rebind project" open={props.open} onOpenChange={props.onOpenChange}>
      <Modal.Content>
        <Notice styles={styles} theme={theme}>{TEXT.rebindNotice}</Notice>
        <Select styles={styles} theme={theme} label="New project" value={projectId} options={options} onChange={setProjectId} />
        <DialogActions styles={styles}>
          <Button styles={styles} theme={theme} label="Cancel" onPress={() => props.onOpenChange(false)} />
          <Button
            styles={styles}
            theme={theme}
            label="Rebind"
            variant="primary"
            disabled={!project}
            onPress={() => {
              if (!project) return;
              void props
                .onSubmit({ projectId: project.projectId, projectNameSnapshot: project.projectDisplayName, projectRootSnapshot: project.projectRootPath })
                .then((ok) => ok && props.onOpenChange(false));
            }}
          />
        </DialogActions>
      </Modal.Content>
    </Modal>
  );
}
