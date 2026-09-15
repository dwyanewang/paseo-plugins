import type { PluginTheme } from "@getpaseo/plugin";
import { usePaseo, useSettings } from "@getpaseo/plugin/client";
import { Modal, useToast } from "@getpaseo/plugin/client/react-native";
import { SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { validateSeedPrompt } from "../shared/limits";
import { todoPrefs, type LaunchMode } from "../shared/prefs";
import { deriveSeedPrompt } from "../shared/prompt";
import type { WorkItem } from "../shared/schema";
import { useAgentConfigCatalog } from "./agent-config";
import { Button, Field, Notice } from "./components";
import type { LaunchTarget } from "./launch";
import { NEW_WORKSPACE, resolveChoice, resolveWorkspaceTarget } from "./launch-defaults";
import { LAUNCH_UPGRADE_NOTICE } from "./launch-guard";
import type { RunAgentConfig } from "./run";
import type { TodoStyles } from "./styles";
import { TEXT } from "./text";

export type ExecuteSubmit =
  | {
      mode: "run";
      seedPrompt: string;
      seedPromptSource: "work-item-default" | "launch-edited";
      updateDefaultPrompt: boolean;
      workspaceId: string;
      config: RunAgentConfig;
    }
  | {
      mode: "composer";
      seedPrompt: string;
      seedPromptSource: "work-item-default" | "launch-edited";
      updateDefaultPrompt: boolean;
      target: LaunchTarget;
    };

export function ExecuteModal(props: {
  styles: TodoStyles;
  theme: PluginTheme;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  item: WorkItem | null;
  defaultWorkspaceId: string | null;
  canOpenComposer: boolean;
  onSubmit: (input: ExecuteSubmit) => Promise<boolean>;
}) {
  const { styles, theme, item } = props;
  const paseo = usePaseo();
  const toast = useToast();
  const prefs = useSettings(todoPrefs);
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
  const [busy, setBusy] = useState(false);

  const stored = prefs.status === "ready" ? prefs.values : null;
  useEffect(() => {
    if (!props.open) return;
    setSeedPrompt(item ? deriveSeedPrompt(item) : "");
    setUpdateDefault(false);
    setBusy(false);
    setTarget(null);
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
  const workspaceOptions = useMemo(
    () => (effectiveMode === "run" ? existing : [{ value: NEW_WORKSPACE, label: "New workspace" }, ...existing]),
    [existing, effectiveMode],
  );
  const effectiveTarget = resolveWorkspaceTarget({
    mode: effectiveMode,
    selected: target,
    saved: item ? stored?.workspaceByProject[item.projectId] : undefined,
    contextual: props.defaultWorkspaceId,
    workspaces: existing,
  });
  const known = (value: string | null | undefined) => Boolean(value) && catalog.models.some((option) => option.value === value);
  const effectiveModel = known(model) ? model! : known(stored?.providerModel) ? stored!.providerModel : (catalog.defaultModel ?? "");
  const modes = effectiveModel ? catalog.modesFor(effectiveModel) : [];
  const knownMode = (value: string | null | undefined) => Boolean(value) && modes.some((option) => option.value === value);
  const effectiveModeId = knownMode(modeId) ? modeId! : knownMode(stored?.modeId) ? stored!.modeId : catalog.defaultModeFor(effectiveModel);
  const selectedModel = catalog.models.find((option) => option.value === effectiveModel);
  const thinkingOptions = selectedModel?.thinkingOptions ?? [];
  const effectiveThinkingOptionId = resolveChoice(thinkingOptions, thinkingOptionId, stored?.thinkingOptionId, selectedModel?.defaultThinkingOptionId);

  const invalid = validateSeedPrompt(seedPrompt);
  const edited = seedPrompt !== initialSeedPrompt;
  const noWorkspace = effectiveMode === "run" && !workspaces.isPending && existing.length === 0;
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
              workspaceId: effectiveTarget,
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
    <Modal title={item ? `Execute: ${item.title}` : "Execute"} open={props.open} onOpenChange={props.onOpenChange}>
      <Modal.Content>
        <Field styles={styles} theme={theme} label="Prompt for this attempt" value={seedPrompt} onChangeText={setSeedPrompt} multiline placeholder="What the agent should do" />
        {edited ? (
          <SettingsSwitch label="Also update the default prompt" value={updateDefault} onValueChange={setUpdateDefault} />
        ) : null}
        {!props.canOpenComposer ? <Notice styles={styles}>{LAUNCH_UPGRADE_NOTICE}</Notice> : null}
        {props.canOpenComposer ? (
          <SettingsSelect
            label="Launch"
            hint={effectiveMode === "run" ? TEXT.runModeHint : TEXT.composerModeHint}
            value={effectiveMode}
            options={[
              { value: "run", label: "Start the agent now" },
              { value: "composer", label: "Open the composer" },
            ]}
            onValueChange={(value) => setMode(value as LaunchMode)}
            disabled={busy}
          />
        ) : null}
        {workspaceOptions.length > 0 ? (
          <SettingsSelect label="Workspace" value={effectiveTarget} options={workspaceOptions} onValueChange={setTarget} disabled={busy} />
        ) : null}
        {effectiveMode === "run" ? (
          <>
            {catalog.models.length > 0 ? (
              <SettingsSelect
                label="Model"
                value={effectiveModel}
                options={catalog.models.map((option) => ({ value: option.value, label: option.label }))}
                onValueChange={(value) => {
                  setModel(value);
                  setModeId(null);
                  setThinkingOptionId(null);
                }}
                disabled={busy}
              />
            ) : null}
            {modes.length > 0 ? (
              <SettingsSelect label="Mode" value={effectiveModeId} options={modes.map((option) => ({ value: option.value, label: option.label }))} onValueChange={setModeId} disabled={busy} />
            ) : null}
            {thinkingOptions.length > 0 ? (
              <SettingsSelect label="Thinking" value={effectiveThinkingOptionId} options={thinkingOptions} onValueChange={setThinkingOptionId} disabled={busy} />
            ) : null}
          </>
        ) : null}
        {workspaces.isError ? <Notice styles={styles} kind="warning">Could not list workspaces for this project.</Notice> : null}
        {noWorkspace ? (
          <Notice styles={styles} kind="warning">
            {props.canOpenComposer ? TEXT.noWorkspaceForRun : TEXT.noWorkspaceAtAll}
          </Notice>
        ) : null}
        {noModel ? <Notice styles={styles} kind="warning">{catalog.error ?? TEXT.noProviderForRun}</Notice> : null}
        {invalid ? (
          <Notice styles={styles} kind="warning">
            {invalid.reason === "empty" ? "Enter a prompt before launching." : "The prompt is too long."}
          </Notice>
        ) : null}
        <Text style={styles.mono}>{effectiveMode === "run" ? TEXT.runNotice : TEXT.seedNotice}</Text>
        <View style={styles.rowWrap}>
          <Button
            styles={styles}
            theme={theme}
            label={busy ? "Starting…" : effectiveMode === "run" ? "Start agent" : "Open composer"}
            icon={effectiveMode === "run" ? "Play" : "SquarePen"}
            variant="primary"
            disabled={blocked}
            onPress={() => void submit()}
          />
          <Button styles={styles} theme={theme} label="Cancel" disabled={busy} onPress={() => props.onOpenChange(false)} />
        </View>
      </Modal.Content>
    </Modal>
  );
}
