import type { PluginTheme } from "@getpaseo/plugin";
import { Modal } from "@getpaseo/plugin/client/react-native";
import { useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { WORK_ITEM_STATUS_LABELS } from "../shared/board";
import { validateWorkItemFields } from "../shared/limits";
import type { WorkItem, WorkItemStatus } from "../shared/schema";
import { Button, Field, Notice, Select } from "./components";
import type { ProjectRecord } from "./projects";
import type { TodoStyles } from "./styles";
import { TEXT } from "./text";

export interface EditorSubmit {
  projectId: string;
  projectNameSnapshot: string;
  projectRootSnapshot?: string;
  title: string;
  details: string;
  defaultPrompt: string;
  status: WorkItemStatus;
}

export function WorkItemEditor(props: {
  styles: TodoStyles;
  theme: PluginTheme;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: Map<string, ProjectRecord>;
  initialProjectId: string | null;
  /** Column a new item lands in; ignored when editing. */
  initialStatus: WorkItemStatus;
  item: WorkItem | null;
  onSubmit: (input: EditorSubmit) => Promise<boolean>;
}) {
  const { styles, theme, item } = props;
  const [title, setTitle] = useState(item?.title ?? "");
  const [details, setDetails] = useState(item?.details ?? "");
  const [defaultPrompt, setDefaultPrompt] = useState(item?.defaultPrompt ?? "");
  const [projectId, setProjectId] = useState<string | null>(item?.projectId ?? props.initialProjectId);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!props.open) return;
    setTitle(item?.title ?? "");
    setDetails(item?.details ?? "");
    setDefaultPrompt(item?.defaultPrompt ?? "");
    setProjectId(item?.projectId ?? props.initialProjectId);
  }, [props.open, item, props.initialProjectId]);
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

  async function submit() {
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
        status: props.initialStatus,
      });
      if (ok) props.onOpenChange(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={item ? "Edit work item" : "New work item"} open={props.open} onOpenChange={props.onOpenChange}>
      <Modal.Content>
        <Field styles={styles} theme={theme} label="Title" value={title} onChangeText={setTitle} placeholder="What needs to happen" />
        <Field styles={styles} theme={theme} label="Details" value={details} onChangeText={setDetails} multiline placeholder="Notes for you (not sent to the agent unless you put them in the prompt)" />
        <Field styles={styles} theme={theme} label="Default prompt" value={defaultPrompt} onChangeText={setDefaultPrompt} multiline placeholder="Seed prompt used when you execute this item" />
        {item ? (
          <Text style={styles.muted}>Project: {item.projectNameSnapshot}. Use Rebind project to move it.</Text>
        ) : (
          <Select styles={styles} theme={theme} label="Project" value={projectId} options={options} onChange={setProjectId} />
        )}
        {invalid ? (
          <Notice styles={styles} kind="warning">{`${invalid.field} is ${invalid.reason.replace("_", " ")}.`}</Notice>
        ) : null}
        {!item ? <Text style={styles.muted}>Column: {WORK_ITEM_STATUS_LABELS[props.initialStatus]}</Text> : null}
        {!item ? <Text style={styles.mono}>{TEXT.seedNotice}</Text> : null}
        <View style={styles.rowWrap}>
          <Button styles={styles} theme={theme} label={item ? "Save" : "Create"} onPress={() => void submit()} variant="primary" disabled={!canSubmit} />
          <Button styles={styles} theme={theme} label="Cancel" onPress={() => props.onOpenChange(false)} />
        </View>
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
        <Notice styles={styles}>{TEXT.rebindNotice}</Notice>
        <Select styles={styles} theme={theme} label="New project" value={projectId} options={options} onChange={setProjectId} />
        <View style={styles.rowWrap}>
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
          <Button styles={styles} theme={theme} label="Cancel" onPress={() => props.onOpenChange(false)} />
        </View>
      </Modal.Content>
    </Modal>
  );
}
