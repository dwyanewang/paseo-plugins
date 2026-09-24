import { usePaseo, useSettings } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { createId } from "../shared/ids";
import { validateSeedPrompt } from "../shared/limits";
import { todoPrefs, type LaunchMode } from "../shared/prefs";
import { deriveSeedPrompt } from "../shared/prompt";
import type { WorkItem } from "../shared/schema";
import { useAgentConfigCatalog, type ModelOption, type ModeOption } from "./agent-config";
import { useTodoImageStore } from "./images";
import type { LaunchTarget } from "./launch";
import { NEW_WORKSPACE, NEW_WORKTREE, resolveChoice, resolveWorkspaceTarget, worktreeNameFor } from "./launch-defaults";
import type { ProjectRecord } from "./projects";
import type { RunAgentConfig, RunTarget } from "./run";

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

export interface ExecuteFormInput {
  item: WorkItem;
  /** The item's project: only git projects offer a new worktree, which is cut from its root. */
  project: ProjectRecord | undefined;
  defaultWorkspaceId: string | null;
  canOpenComposer: boolean;
  onSubmit: (input: ExecuteSubmit) => Promise<boolean>;
  /** Called after a launch the dialog should close for. */
  onDone: () => void;
}

/**
 * Everything the execute box decides: the prompt, where it runs, and with which agent. It mounts
 * per opening. A choice left alone (`null`) falls back to the saved preference and then to the
 * host default, so a settings load that lands after opening still applies without overwriting a
 * choice already made.
 */
export function useExecuteForm(input: ExecuteFormInput) {
  const { item } = input;
  const paseo = usePaseo();
  const toast = useToast();
  const prefs = useSettings(todoPrefs);
  const imageStore = useTodoImageStore();
  const images = useMemo(() => imageStore.resolve(item.images), [item, imageStore]);
  const catalog = useAgentConfigCatalog(paseo, true);
  const [initialSeedPrompt] = useState(() => deriveSeedPrompt(item));
  const [seedPrompt, setSeedPrompt] = useState(initialSeedPrompt);
  const [updateDefault, setUpdateDefault] = useState(false);
  const [mode, setMode] = useState<LaunchMode | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [model, setModelChoice] = useState<string | null>(null);
  const [modeId, setModeId] = useState<string | null>(null);
  const [thinkingOptionId, setThinkingOptionId] = useState<string | null>(null);
  const [branchName, setBranchName] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  // Generated once per opening, so the placeholder name does not change while the box is open.
  const [nameSuffix] = useState(() => createId("att").slice(-4));
  const [busy, setBusy] = useState(false);

  const stored = prefs.status === "ready" ? prefs.values : null;
  const effectiveMode: LaunchMode = !input.canOpenComposer ? "run" : (mode ?? stored?.launchMode ?? "run");

  const workspaces = useQuery({
    queryKey: ["todo", "workspaces", item.projectId],
    queryFn: async () => {
      const result = await paseo.workspaces.list({ filter: { projectId: item.projectId }, page: { limit: 200 } });
      return result.entries.filter((workspace) => !workspace.archivingAt);
    },
  });
  const existing = useMemo(() => (workspaces.data ?? []).map((workspace) => ({ value: workspace.id, label: workspace.name })), [workspaces.data]);
  const canCreateWorktree = input.project?.projectKind === "git";
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
    saved: stored?.workspaceByProject[item.projectId],
    contextual: input.defaultWorkspaceId,
    workspaces: existing,
    canCreateWorktree,
  });
  const newWorktree = effectiveMode === "run" && effectiveTarget === NEW_WORKTREE;
  const generatedBranch = worktreeNameFor(item, nameSuffix);
  const known = (value: string | null | undefined) => Boolean(value) && catalog.models.some((option) => option.value === value);
  const effectiveModel = known(model) ? model! : known(stored?.providerModel) ? stored!.providerModel : (catalog.defaultModel ?? "");
  const modes: ModeOption[] = effectiveModel ? catalog.modesFor(effectiveModel) : [];
  const knownMode = (value: string | null | undefined) => Boolean(value) && modes.some((option) => option.value === value);
  const effectiveModeId = knownMode(modeId) ? modeId! : knownMode(stored?.modeId) ? stored!.modeId : catalog.defaultModeFor(effectiveModel);
  const selectedModel: ModelOption | undefined = catalog.models.find((option) => option.value === effectiveModel);
  const effectiveProvider = selectedModel?.provider ?? "";
  const thinkingOptions = selectedModel?.thinkingOptions ?? [];
  const effectiveThinkingOptionId = resolveChoice(thinkingOptions, thinkingOptionId, stored?.thinkingOptionId, selectedModel?.defaultThinkingOptionId);

  const invalid = validateSeedPrompt(seedPrompt);
  const edited = seedPrompt !== initialSeedPrompt;
  const noWorkspace = effectiveMode === "run" && !workspaces.isPending && existing.length === 0 && !canCreateWorktree;
  const noModel = effectiveMode === "run" && catalog.status !== "loading" && catalog.models.length === 0;
  const blocked = Boolean(invalid) || busy || prefs.status === "loading" || workspaces.isPending || !effectiveTarget || (effectiveMode === "run" && !effectiveModel);

  /** A new model resets the choices that depend on it. */
  function setModel(value: string) {
    setModelChoice(value);
    setModeId(null);
    setThinkingOptionId(null);
  }

  async function submit() {
    if (invalid || blocked) return;
    setBusy(true);
    try {
      const shared = {
        seedPrompt,
        seedPromptSource: (edited ? "launch-edited" : "work-item-default") as "launch-edited" | "work-item-default",
        updateDefaultPrompt: edited && updateDefault,
      };
      const ok = await input.onSubmit(
        effectiveMode === "run"
          ? {
              mode: "run",
              ...shared,
              target: newWorktree
                ? {
                    kind: "new_worktree",
                    branchName: branchName.trim() || generatedBranch,
                    ...(baseBranch.trim() ? { baseBranch: baseBranch.trim() } : {}),
                    ...(input.project ? { projectRootPath: input.project.projectRootPath } : {}),
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
      if (!ok) return;
      if (prefs.status === "ready") {
        const next = {
          ...prefs.values,
          launchMode: effectiveMode,
          workspaceByProject: { ...prefs.values.workspaceByProject, [item.projectId]: effectiveTarget },
          ...(effectiveMode === "run" ? { providerModel: effectiveModel, modeId: effectiveModeId, thinkingOptionId: effectiveThinkingOptionId } : {}),
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
      input.onDone();
    } finally {
      setBusy(false);
    }
  }

  return {
    images,
    catalog,
    seedPrompt,
    setSeedPrompt,
    edited,
    updateDefault,
    setUpdateDefault,
    effectiveMode,
    setMode,
    workspaces,
    workspaceOptions,
    effectiveTarget,
    setTarget,
    newWorktree,
    generatedBranch,
    branchName,
    setBranchName,
    baseBranch,
    setBaseBranch,
    effectiveModel,
    setModel,
    effectiveProvider,
    modes,
    effectiveModeId,
    setModeId,
    thinkingOptions,
    effectiveThinkingOptionId,
    setThinkingOptionId,
    invalid,
    noWorkspace,
    noModel,
    blocked,
    busy,
    submit,
  };
}

export type ExecuteForm = ReturnType<typeof useExecuteForm>;
