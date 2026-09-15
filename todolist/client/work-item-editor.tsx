import type { PluginTheme } from "@getpaseo/plugin";
import { Modal } from "@getpaseo/plugin/client/react-native";
import { useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { validateWorkItemFields } from "../shared/limits";
import type { WorkItem, WorkItemPriority } from "../shared/schema";
import { Button, DialogActions, Field, FormLabel, Notice, Select } from "./components";
import { PriorityPicker, StatusPicker } from "./move-menu";
import type { ProjectRecord } from "./projects";
import type { TodoStyles } from "./styles";
import { TEXT } from "./text";

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
  const [title, setTitle] = useState(item?.title ?? "");
  const [details, setDetails] = useState(item?.details ?? "");
  const [defaultPrompt, setDefaultPrompt] = useState(item?.defaultPrompt ?? "");
  const [projectId, setProjectId] = useState<string | null>(item?.projectId ?? props.initialProjectId);
  const [status, setStatus] = useState<StartingStatus>(props.initialStatus);
  const [priority, setPriority] = useState<WorkItemPriority>(item?.priority ?? "none");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!props.open) return;
    setTitle(item?.title ?? "");
    setDetails(item?.details ?? "");
    setDefaultPrompt(item?.defaultPrompt ?? "");
    setProjectId(item?.projectId ?? props.initialProjectId);
    setStatus(props.initialStatus);
    setPriority(item?.priority ?? "none");
  }, [props.open, item, props.initialProjectId, props.initialStatus]);
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
        status,
        priority,
        execute,
      });
      if (ok) props.onOpenChange(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={item ? "Edit work item" : "New work item"} open={props.open} onOpenChange={props.onOpenChange}>
      <Modal.Content>
        <Field styles={styles} theme={theme} label="Title" value={title} onChangeText={setTitle} placeholder="What needs to happen" autoFocus={!item} />
        <Field styles={styles} theme={theme} label="Details" value={details} onChangeText={setDetails} multiline placeholder="Notes for you (not sent to the agent unless you put them in the prompt)" />
        <Field styles={styles} theme={theme} label="Default prompt" value={defaultPrompt} onChangeText={setDefaultPrompt} multiline placeholder="Seed prompt used when you execute this item" />
        <View style={[styles.rowWrap, { gap: 16, alignItems: "flex-start" }]}>
          <FormLabel styles={styles} label="Priority">
            <PriorityPicker styles={styles} theme={theme} value={priority} onChange={setPriority} />
          </FormLabel>
          {!item ? (
            <FormLabel styles={styles} label="Column">
              <StatusPicker styles={styles} theme={theme} value={status} statuses={STARTING_STATUSES} onChange={(next) => setStatus(next as StartingStatus)} />
            </FormLabel>
          ) : null}
        </View>
        {item ? (
          <Text style={styles.mono}>Project: {item.projectNameSnapshot}. Use Rebind project to move it.</Text>
        ) : (
          <Select styles={styles} theme={theme} label="Project" value={projectId} options={options} onChange={setProjectId} />
        )}
        {invalid ? (
          <Notice styles={styles} theme={theme} kind="warning">{`${invalid.field} is ${invalid.reason.replace("_", " ")}.`}</Notice>
        ) : null}
        {!item ? <Text style={styles.mono}>{TEXT.seedNotice}</Text> : null}
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
