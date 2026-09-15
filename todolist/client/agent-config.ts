import type { usePaseo } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

type PaseoApi = ReturnType<typeof usePaseo>;
type Snapshot = Awaited<ReturnType<PaseoApi["providers"]["snapshot"]>>;
type SnapshotEntry = Snapshot["entries"][number];

export interface ModelOption {
  /** `provider/model`, the form the host agent API expects. */
  value: string;
  provider: string;
  /** The model's own name; the provider is picked first. */
  modelLabel: string;
  thinkingOptions: ModeOption[];
  defaultThinkingOptionId: string;
}

export interface ModeOption {
  value: string;
  label: string;
}

export interface AgentConfigCatalog {
  status: "loading" | "ready" | "error";
  error: string | null;
  models: ModelOption[];
  /** Providers with at least one selectable model, in catalog order. */
  providers: ModeOption[];
  /** The provider's default model, or its first one. */
  defaultModelFor: (provider: string) => string | null;
  /** Default `provider/model` when the user has never chosen one. */
  defaultModel: string | null;
  modesFor: (providerModel: string) => ModeOption[];
  defaultModeFor: (providerModel: string) => string;
}

function providerOf(providerModel: string): string {
  const slash = providerModel.indexOf("/");
  return slash === -1 ? providerModel : providerModel.slice(0, slash);
}

function usable(entry: SnapshotEntry): boolean {
  return entry.enabled !== false && entry.status === "ready";
}

type CatalogChoices = Omit<AgentConfigCatalog, "status" | "error">;

/** The selectable models of every ready provider, grouped for a provider-then-model picker. */
export function buildCatalogChoices(snapshotEntries: readonly SnapshotEntry[]): CatalogChoices {
  const entries = snapshotEntries.filter(usable);
  const models: ModelOption[] = [];
  const providers: ModeOption[] = [];
  const providerDefaults = new Map<string, string>();
  const explicitDefaults = new Set<string>();
  let first: string | null = null;
  let preferred: string | null = null;
  for (const entry of entries) {
    const providerLabel = entry.label ?? entry.provider;
    for (const model of entry.models ?? []) {
      if (model.isSelectable === false) continue;
      const value = `${entry.provider}/${model.id}`;
      models.push({
        value,
        provider: entry.provider,
        modelLabel: model.label,
        thinkingOptions: (model.thinkingOptions ?? []).map((option) => ({ value: option.id, label: option.label })),
        defaultThinkingOptionId: model.defaultThinkingOptionId ?? model.thinkingOptions?.find((option) => option.isDefault)?.id ?? model.thinkingOptions?.[0]?.id ?? "",
      });
      if (!first) first = value;
      if (!preferred && model.isDefault) preferred = value;
      if (!providers.some((provider) => provider.value === entry.provider)) providers.push({ value: entry.provider, label: providerLabel });
      // The provider's first default model wins; without one, its first model.
      if (!providerDefaults.has(entry.provider) || (model.isDefault && !explicitDefaults.has(entry.provider))) {
        providerDefaults.set(entry.provider, value);
        if (model.isDefault) explicitDefaults.add(entry.provider);
      }
    }
  }
  const byProvider = new Map(entries.map((entry) => [entry.provider, entry]));
  return {
    models,
    providers,
    defaultModel: preferred ?? first,
    defaultModelFor: (provider) => providerDefaults.get(provider) ?? null,
    modesFor: (providerModel) => (byProvider.get(providerOf(providerModel))?.modes ?? []).map((mode) => ({ value: mode.id, label: mode.label })),
    defaultModeFor: (providerModel) => byProvider.get(providerOf(providerModel))?.defaultModeId ?? "",
  };
}

/**
 * Provider/model catalog for a direct run. The native composer owns the full picker; this only
 * reads the same model thinking options and provider modes as agent profiles.
 */
export function useAgentConfigCatalog(paseo: PaseoApi, enabled: boolean): AgentConfigCatalog {
  const query = useQuery({
    queryKey: ["todo", "providers"],
    enabled,
    staleTime: 60_000,
    queryFn: () => paseo.providers.snapshot(),
  });
  return useMemo(
    () => ({
      status: query.isPending ? "loading" : query.isError ? "error" : "ready",
      error: query.error instanceof Error ? query.error.message : query.isError ? "Could not list providers." : null,
      ...buildCatalogChoices(query.data?.entries ?? []),
    }),
    [query.data, query.error, query.isError, query.isPending],
  );
}
