import type { PluginTheme } from "@getpaseo/plugin";
import { usePaseo, useSettings } from "@getpaseo/plugin/client";
import { Icon, Modal, useToast } from "@getpaseo/plugin/client/react-native";
import { SettingsCard, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Image, Text, View } from "react-native";
import { validateSeedPrompt } from "../shared/limits";
import { todoPrefs, type LaunchMode } from "../shared/prefs";
import { deriveSeedPrompt } from "../shared/prompt";
import type { WorkItem } from "../shared/schema";
import { useAgentConfigCatalog } from "./agent-config";
import { Button, DialogActions, Field, Notice } from "./components";
import { imageDataUri, useTodoImageStore } from "./images";
import type { LaunchTarget } from "./launch";
import { createId } from "../shared/ids";
import { NEW_WORKSPACE, NEW_WORKTREE, resolveChoice, resolveWorkspaceTarget, worktreeNameFor } from "./launch-defaults";
import { LAUNCH_UPGRADE_NOTICE } from "./launch-guard";
import type { ProjectRecord } from "./projects";
import type { RunAgentConfig, RunTarget } from "./run";
import { RowGroup, SelectRow } from "./select-row";
import type { TodoStyles } from "./styles";
import { TEXT } from "./text";

export type ExecuteSubmit =
  | {
      mode: "run";
      seedPrompt: string;
      seedPromptSource: "work-item-default" | "launch-edited";
      updateDefaultPrompt: boolean;
      target: RunTarget;
      config: RunAgentConfig;
    }
  | {
      mode: "composer";
      seedPrompt: string;
      seedPromptSource: "work-item-default" | "launch-edited";
      updateDefaultPrompt: boolean;
      target: LaunchTarget;
    };

function Group(props: { styles: TodoStyles; title: string; children: ReactNode }) {
  return (
    <View style={{ gap: 8 }}>
      <Text style={props.styles.sectionTitle}>{props.title}</Text>
      {props.children}
    </View>
  );
}

export function ExecuteModal(props: {
  styles: TodoStyles;
  theme: PluginTheme;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  item: WorkItem | null;
  /** The item's project: only git projects offer a new worktree, which is cut from its root. */
  project: ProjectRecord | undefined;
  defaultWorkspaceId: string | null;
  canOpenComposer: boolean;
  onSubmit: (input: ExecuteSubmit) => Promise<boolean>;
  /** Present when the dialog came from moving the card into In progress: move without running. */
  onMoveOnly?: () => void;
}) {
  const { styles, theme, item } = props;
  const paseo = usePaseo();
  const toast = useToast();
  const prefs = useSettings(todoPrefs);
  const imageStore = useTodoImageStore();
  const images = useMemo(() => (item ? imageStore.resolve(item.images) : []), [item, imageStore]);
  const catalog = useAgentConfigCatalog(paseo, props.open);
  const initialSeedPrompt = item ? deriveSeedPrompt(item) : "";
  const [seedPrompt, setSeedPrompt] = useState(initialSeedPrompt);
  const [updateDefault, setUpdateDefault] = useState(false);
  // `null` means "not chosen in this dialog": the effective value then falls back to the saved
  // preference and finally to the host default, so a settings load that lands after the dialog
  // opened still applies without overwriting a choice the user already made.
  const [mode, setMode] = useState<LaunchMode | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [modeId, setModeId] = useState<string | null>(null);
  const [thinkingOptionId, setThinkingOptionId] = useState<string | null>(null);
  const [branchName, setBranchName] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  // Generated once per opening, so the placeholder name does not change while the dialog is open.
  const [nameSuffix, setNameSuffix] = useState(() => createId("att").slice(-4));
  const [busy, setBusy] = useState(false);

  const stored = prefs.status === "ready" ? prefs.values : null;
  useEffect(() => {
    if (!props.open) return;
    setSeedPrompt(item ? deriveSeedPrompt(item) : "");
    setUpdateDefault(false);
    setBusy(false);
    setTarget(null);
    setBranchName("");
    setBaseBranch("");
    setNameSuffix(createId("att").slice(-4));
    setMode(null);
    setModel(null);
    setModeId(null);
    setThinkingOptionId(null);
  }, [props.open, item]);

  const effectiveMode: LaunchMode = !props.canOpenComposer ? "run" : (mode ?? stored?.launchMode ?? "run");

  const workspaces = useQuery({
    queryKey: ["todo", "workspaces", item?.projectId ?? ""],
    enabled: props.open && Boolean(item),
    queryFn: async () => {
      const result = await paseo.workspaces.list({
        filter: { projectId: item!.projectId },
        page: { limit: 200 },
      });
      return result.entries.filter((workspace) => !workspace.archivingAt);
    },
  });
  const existing = useMemo(
    () => (workspaces.data ?? []).map((workspace) => ({ value: workspace.id, label: workspace.name })),
    [workspaces.data],
  );
  const canCreateWorktree = props.project?.projectKind === "git";
  const workspaceOptions = useMemo(
    () =>
      effectiveMode === "run"
        ? [...existing, ...(canCreateWorktree ? [{ value: NEW_WORKTREE, label: "New worktree" }] : [])]
        : [{ value: NEW_WORKSPACE, label: "New workspace" }, ...existing],
    [existing, effectiveMode, canCreateWorktree],
  );
  const effectiveTarget = resolveWorkspaceTarget({
    mode: effectiveMode,
    selected: target,
    saved: item ? stored?.workspaceByProject[item.projectId] : undefined,
    contextual: props.defaultWorkspaceId,
    workspaces: existing,
    canCreateWorktree,
  });
  const newWorktree = effectiveMode === "run" && effectiveTarget === NEW_WORKTREE;
  const generatedBranch = item ? worktreeNameFor(item, nameSuffix) : "";
  const known = (value: string | null | undefined) => Boolean(value) && catalog.models.some((option) => option.value === value);
  const effectiveModel = known(model) ? model! : known(stored?.providerModel) ? stored!.providerModel : (catalog.defaultModel ?? "");
  const modes = effectiveModel ? catalog.modesFor(effectiveModel) : [];
  const knownMode = (value: string | null | undefined) => Boolean(value) && modes.some((option) => option.value === value);
  const effectiveModeId = knownMode(modeId) ? modeId! : knownMode(stored?.modeId) ? stored!.modeId : catalog.defaultModeFor(effectiveModel);
  const selectedModel = catalog.models.find((option) => option.value === effectiveModel);
  // Provider first, then one of its models: the full catalog is too long for a single list.
  const effectiveProvider = selectedModel?.provider ?? "";
  const providerModels = catalog.models.filter((option) => option.provider === effectiveProvider);
  const thinkingOptions = selectedModel?.thinkingOptions ?? [];
  const effectiveThinkingOptionId = resolveChoice(thinkingOptions, thinkingOptionId, stored?.thinkingOptionId, selectedModel?.defaultThinkingOptionId);

  const invalid = validateSeedPrompt(seedPrompt);
  const edited = seedPrompt !== initialSeedPrompt;
  const noWorkspace = effectiveMode === "run" && !workspaces.isPending && existing.length === 0 && !canCreateWorktree;
  const noModel = effectiveMode === "run" && catalog.status !== "loading" && catalog.models.length === 0;
  const blocked = Boolean(invalid) || busy || !item || prefs.status === "loading" || workspaces.isPending || !effectiveTarget || (effectiveMode === "run" && !effectiveModel);

  async function submit() {
    if (!item || invalid || blocked) return;
    setBusy(true);
    try {
      const shared = {
        seedPrompt,
        seedPromptSource: (edited ? "launch-edited" : "work-item-default") as "launch-edited" | "work-item-default",
        updateDefaultPrompt: edited && updateDefault,
      };
      const ok = await props.onSubmit(
        effectiveMode === "run"
          ? {
              mode: "run",
              ...shared,
              target: newWorktree
                ? {
                    kind: "new_worktree",
                    branchName: branchName.trim() || generatedBranch,
                    ...(baseBranch.trim() ? { baseBranch: baseBranch.trim() } : {}),
                    ...(props.project ? { projectRootPath: props.project.projectRootPath } : {}),
                  }
                : { kind: "existing", workspaceId: effectiveTarget },
              config: {
                providerModel: effectiveModel,
                ...(effectiveModeId ? { modeId: effectiveModeId } : {}),
                ...(effectiveThinkingOptionId ? { thinkingOptionId: effectiveThinkingOptionId } : {}),
              },
            }
          : {
              mode: "composer",
              ...shared,
              target: effectiveTarget === NEW_WORKSPACE ? { kind: "new" } : { kind: "existing", workspaceId: effectiveTarget },
            },
      );
      if (ok) {
        if (prefs.status === "ready") {
          const next = {
            ...prefs.values,
            launchMode: effectiveMode,
            workspaceByProject: { ...prefs.values.workspaceByProject, [item.projectId]: effectiveTarget },
            ...(effectiveMode === "run" ? {
              providerModel: effectiveModel,
              modeId: effectiveModeId,
              thinkingOptionId: effectiveThinkingOptionId,
            } : {}),
          };
          if (
            next.launchMode !== prefs.values.launchMode ||
            next.providerModel !== prefs.values.providerModel ||
            next.modeId !== prefs.values.modeId ||
            next.thinkingOptionId !== prefs.values.thinkingOptionId ||
            effectiveTarget !== prefs.values.workspaceByProject[item.projectId]
          ) {
            const saved = await prefs.save(next, prefs.revision);
            if (!saved) toast.error("Launch succeeded, but Todo could not remember these choices. Reload Todo before the next launch.");
          }
        } else {
          toast.error("Launch succeeded, but Todo preferences are unavailable, so these choices could not be remembered.");
        }
        props.onOpenChange(false);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={item ? `Execute #${item.number}` : "Execute"} open={props.open} onOpenChange={props.onOpenChange}>
      <Modal.Content>
        {item ? (
          <View style={{ gap: 4 }}>
            <Text style={styles.detailTitle} numberOfLines={2}>
              {item.title}
            </Text>
            <View style={[styles.row, { gap: 6 }]}>
              <Icon name="Folder" size={12} color={theme.colors.foregroundMuted} />
              <Text style={[styles.mono, { flexShrink: 1 }]} numberOfLines={1}>
                {item.projectNameSnapshot}
              </Text>
            </View>
          </View>
        ) : null}

        {images.length > 0 ? (
          <View style={{ gap: 6 }}>
            <View style={[styles.rowWrap, { gap: 8 }]}>
              {images.map((image) => (
                <Image
                  key={image.id}
                  source={{ uri: imageDataUri(image) }}
                  style={{ width: 56, height: 56, borderRadius: 6, borderWidth: 1, borderColor: theme.colors.border }}
                  accessibilityLabel={image.name ?? "Attached image"}
                  resizeMode="cover"
                />
              ))}
            </View>
            <Text style={styles.mono}>
              {effectiveMode === "run"
                ? `${images.length} image${images.length > 1 ? "s" : ""} will be sent with this run.`
                : "Images are only sent on a direct run, not in the composer."}
            </Text>
          </View>
        ) : null}

        <View style={{ gap: 8 }}>
          <Field styles={styles} theme={theme} label="Prompt for this attempt" value={seedPrompt} onChangeText={setSeedPrompt} multiline placeholder="What the agent should do" />
          {edited ? (
            <SettingsCard>
              <SettingsSwitch label="Also update the default prompt" value={updateDefault} onValueChange={setUpdateDefault} />
            </SettingsCard>
          ) : null}
        </View>

        {!props.canOpenComposer ? <Notice styles={styles} theme={theme}>{LAUNCH_UPGRADE_NOTICE}</Notice> : null}

        <Group styles={styles} title="Run">
          <RowGroup styles={styles}>
            {props.canOpenComposer ? (
              <SelectRow
                styles={styles}
                theme={theme}
                label="Launch"
                value={effectiveMode}
                options={[
                  { value: "run", label: "Run now", icon: "Play" },
                  { value: "composer", label: "In the composer", icon: "SquarePen" },
                ]}
                onChange={(value) => setMode(value as LaunchMode)}
                disabled={busy}
              />
            ) : null}
            {workspaceOptions.length > 0 ? (
              <SelectRow
                styles={styles}
                theme={theme}
                label="Workspace"
                value={effectiveTarget || null}
                options={workspaceOptions.map((option) => ({
                  ...option,
                  icon: option.value === NEW_WORKTREE ? "GitBranchPlus" : option.value === NEW_WORKSPACE ? "FolderPlus" : "Folder",
                }))}
                onChange={setTarget}
                disabled={busy}
              />
            ) : null}
          </RowGroup>
          {newWorktree ? (
            <View style={[styles.card, { gap: 12 }]}>
              <Field styles={styles} theme={theme} label="Branch" value={branchName} onChangeText={setBranchName} placeholder={generatedBranch} editable={!busy} hint={TEXT.worktreeBranchHint} monospace />
              <Field styles={styles} theme={theme} label="Base branch" value={baseBranch} onChangeText={setBaseBranch} placeholder="Project default branch" editable={!busy} monospace />
            </View>
          ) : null}
        </Group>

        {effectiveMode === "run" && catalog.models.length > 0 ? (
          <Group styles={styles} title="Agent">
            <RowGroup styles={styles}>
              {catalog.providers.length > 1 ? (
                <SelectRow
                  styles={styles}
                  theme={theme}
                  label="Provider"
                  value={effectiveProvider || null}
                  options={catalog.providers}
                  onChange={(provider) => {
                    setModel(catalog.defaultModelFor(provider));
                    setModeId(null);
                    setThinkingOptionId(null);
                  }}
                  disabled={busy}
                />
              ) : null}
              <SelectRow
                styles={styles}
                theme={theme}
                label="Model"
                value={effectiveModel || null}
                options={providerModels.map((option) => ({ value: option.value, label: option.modelLabel }))}
                onChange={(value) => {
                  setModel(value);
                  setModeId(null);
                  setThinkingOptionId(null);
                }}
                disabled={busy}
              />
              {modes.length > 0 ? (
                <SelectRow styles={styles} theme={theme} label="Mode" value={effectiveModeId || null} options={modes} onChange={setModeId} disabled={busy} />
              ) : null}
              {thinkingOptions.length > 0 ? (
                <SelectRow styles={styles} theme={theme} label="Thinking" value={effectiveThinkingOptionId || null} options={thinkingOptions} onChange={setThinkingOptionId} disabled={busy} />
              ) : null}
            </RowGroup>
          </Group>
        ) : null}

        {workspaces.isError ? <Notice styles={styles} theme={theme} kind="warning">Could not list workspaces for this project.</Notice> : null}
        {noWorkspace ? (
          <Notice styles={styles} theme={theme} kind="warning">
            {props.canOpenComposer ? TEXT.noWorkspaceForRun : TEXT.noWorkspaceAtAll}
          </Notice>
        ) : null}
        {noModel ? <Notice styles={styles} theme={theme} kind="warning">{catalog.error ?? TEXT.noProviderForRun}</Notice> : null}
        {invalid ? (
          <Notice styles={styles} theme={theme} kind="warning">
            {invalid.reason === "empty" ? "Enter a prompt before launching." : "The prompt is too long."}
          </Notice>
        ) : null}
        <Text style={styles.mono}>{effectiveMode === "run" ? TEXT.runNotice : `${TEXT.composerModeHint} ${TEXT.seedNotice}`}</Text>
        <DialogActions styles={styles}>
          <Button styles={styles} theme={theme} label="Cancel" disabled={busy} onPress={() => props.onOpenChange(false)} />
          {props.onMoveOnly ? <Button styles={styles} theme={theme} label="Move only" disabled={busy} onPress={props.onMoveOnly} /> : null}
          <Button
            styles={styles}
            theme={theme}
            label={busy ? "Starting…" : effectiveMode === "run" ? "Start agent" : "Open composer"}
            icon={effectiveMode === "run" ? "Play" : "SquarePen"}
            variant="primary"
            disabled={blocked}
            onPress={() => void submit()}
          />
        </DialogActions>
      </Modal.Content>
    </Modal>
  );
}
