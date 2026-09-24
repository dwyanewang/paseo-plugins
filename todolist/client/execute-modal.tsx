import type { PluginTheme } from "@getpaseo/plugin";
import { Modal } from "@getpaseo/plugin/client/react-native";
import { SettingsCard, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { Text, View } from "react-native";
import type { WorkItem } from "../shared/schema";
import { Button, DialogActions, Field, Notice } from "./components";
import { useExecuteForm, type ExecuteSubmit } from "./execute-form";
import { NEW_WORKSPACE, NEW_WORKTREE } from "./launch-defaults";
import { LAUNCH_UPGRADE_NOTICE } from "./launch-guard";
import type { ProjectRecord } from "./projects";
import { RowGroup, SelectRow } from "./select-row";
import type { TodoStyles } from "./styles";
import { TEXT } from "./text";

interface ExecuteModalProps {
  styles: TodoStyles;
  theme: PluginTheme;
  item: WorkItem | null;
  project: ProjectRecord | undefined;
  defaultWorkspaceId: string | null;
  canOpenComposer: boolean;
  onClose: () => void;
  onSubmit: (input: ExecuteSubmit) => Promise<boolean>;
}

/**
 * The execute dialog inside the host's own dialog, for the workspace header panel only. That panel
 * is a host popover: a box the plugin draws itself would fight the popover for focus, and closing
 * the popover first would unmount whatever drew the box. Everywhere else uses `ExecuteBox`; both
 * share `useExecuteForm`, so only the layout differs.
 */
export function ExecuteModal(props: ExecuteModalProps) {
  return (
    <Modal title={props.item ? `Execute #${props.item.number}` : "Execute"} open={props.item !== null} onOpenChange={(open) => !open && props.onClose()}>
      <Modal.Content>{props.item ? <ExecuteModalBody {...props} item={props.item} /> : null}</Modal.Content>
    </Modal>
  );
}

function ExecuteModalBody(props: ExecuteModalProps & { item: WorkItem }) {
  const { styles, theme, item } = props;
  const form = useExecuteForm({
    item,
    project: props.project,
    defaultWorkspaceId: props.defaultWorkspaceId,
    canOpenComposer: props.canOpenComposer,
    onSubmit: props.onSubmit,
    onDone: props.onClose,
  });
  const run = form.effectiveMode === "run";
  const providerModels = form.catalog.models.filter((option) => option.provider === form.effectiveProvider);
  return (
    <>
      <Text style={styles.detailTitle} numberOfLines={2}>
        {item.title}
      </Text>
      <View style={{ gap: 8 }}>
        <Field styles={styles} theme={theme} label="Prompt for this attempt" value={form.seedPrompt} onChangeText={form.setSeedPrompt} multiline placeholder="What the agent should do" />
        {form.edited ? (
          <SettingsCard>
            <SettingsSwitch label="Also save as the card's default prompt" value={form.updateDefault} onValueChange={form.setUpdateDefault} />
          </SettingsCard>
        ) : null}
      </View>
      {!props.canOpenComposer ? <Notice styles={styles} theme={theme}>{LAUNCH_UPGRADE_NOTICE}</Notice> : null}
      <RowGroup styles={styles}>
        {props.canOpenComposer ? (
          <SelectRow
            styles={styles}
            theme={theme}
            label="Launch"
            value={form.effectiveMode}
            options={[
              { value: "run", label: "Run now", icon: "Play" },
              { value: "composer", label: "In the composer", icon: "SquarePen" },
            ]}
            onChange={(value) => form.setMode(value as "run" | "composer")}
            disabled={form.busy}
          />
        ) : null}
        {form.workspaceOptions.length > 0 ? (
          <SelectRow
            styles={styles}
            theme={theme}
            label="Workspace"
            value={form.effectiveTarget || null}
            options={form.workspaceOptions.map((option) => ({
              ...option,
              icon: option.value === NEW_WORKTREE ? "GitBranchPlus" : option.value === NEW_WORKSPACE ? "FolderPlus" : "Folder",
            }))}
            onChange={form.setTarget}
            disabled={form.busy}
          />
        ) : null}
        {run && form.catalog.providers.length > 1 ? (
          <SelectRow
            styles={styles}
            theme={theme}
            label="Provider"
            value={form.effectiveProvider || null}
            options={form.catalog.providers}
            onChange={(provider) => form.setModel(form.catalog.defaultModelFor(provider) ?? "")}
            disabled={form.busy}
          />
        ) : null}
        {run && form.catalog.models.length > 0 ? (
          <SelectRow
            styles={styles}
            theme={theme}
            label="Model"
            value={form.effectiveModel || null}
            options={providerModels.map((option) => ({ value: option.value, label: option.modelLabel }))}
            onChange={form.setModel}
            disabled={form.busy}
          />
        ) : null}
        {run && form.modes.length > 0 ? <SelectRow styles={styles} theme={theme} label="Mode" value={form.effectiveModeId || null} options={form.modes} onChange={form.setModeId} disabled={form.busy} /> : null}
        {run && form.thinkingOptions.length > 0 ? (
          <SelectRow styles={styles} theme={theme} label="Thinking" value={form.effectiveThinkingOptionId || null} options={form.thinkingOptions} onChange={form.setThinkingOptionId} disabled={form.busy} />
        ) : null}
      </RowGroup>
      {form.newWorktree ? (
        <View style={[styles.card, { gap: 12 }]}>
          <Field styles={styles} theme={theme} label="Branch" value={form.branchName} onChangeText={form.setBranchName} placeholder={form.generatedBranch} editable={!form.busy} hint={TEXT.worktreeBranchHint} monospace />
          <Field styles={styles} theme={theme} label="Base branch" value={form.baseBranch} onChangeText={form.setBaseBranch} placeholder="Project default branch" editable={!form.busy} monospace />
        </View>
      ) : null}
      {form.workspaces.isError ? <Notice styles={styles} theme={theme} kind="warning">Could not list workspaces for this project.</Notice> : null}
      {form.noWorkspace ? <Notice styles={styles} theme={theme} kind="warning">{props.canOpenComposer ? TEXT.noWorkspaceForRun : TEXT.noWorkspaceAtAll}</Notice> : null}
      {form.noModel ? <Notice styles={styles} theme={theme} kind="warning">{form.catalog.error ?? TEXT.noProviderForRun}</Notice> : null}
      {form.invalid ? <Notice styles={styles} theme={theme} kind="warning">{form.invalid.reason === "empty" ? "Enter a prompt before launching." : "The prompt is too long."}</Notice> : null}
      <Text style={styles.mono}>{run ? TEXT.runNotice : `${TEXT.composerModeHint} ${TEXT.seedNotice}`}</Text>
      <DialogActions styles={styles}>
        <Button styles={styles} theme={theme} label="Cancel" disabled={form.busy} onPress={props.onClose} />
        <Button
          styles={styles}
          theme={theme}
          label={form.busy ? "Starting…" : run ? "Start agent" : "Open composer"}
          icon={run ? "Play" : "SquarePen"}
          variant="primary"
          disabled={form.blocked}
          onPress={() => void form.submit()}
        />
      </DialogActions>
    </>
  );
}
