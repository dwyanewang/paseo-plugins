import type { usePaseo } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

type PaseoApi = ReturnType<typeof usePaseo>;
type Snapshot = Awaited<ReturnType<PaseoApi["providers"]["snapshot"]>>;
type SnapshotEntry = Snapshot["entries"][number];

export interface ModelOption {
  /** `provider/model`, the form the host agent API expects. */
  value: string;
  label: string;
  provider: string;
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
  return useMemo(() => {
    const entries = (query.data?.entries ?? []).filter(usable);
    const models: ModelOption[] = [];
    let first: string | null = null;
    let preferred: string | null = null;
    for (const entry of entries) {
      const providerLabel = entry.label ?? entry.provider;
      for (const model of entry.models ?? []) {
        if (model.isSelectable === false) continue;
        const value = `${entry.provider}/${model.id}`;
        models.push({
          value,
          label: `${providerLabel} · ${model.label}`,
          provider: entry.provider,
          thinkingOptions: (model.thinkingOptions ?? []).map((option) => ({ value: option.id, label: option.label })),
          defaultThinkingOptionId: model.defaultThinkingOptionId ?? model.thinkingOptions?.find((option) => option.isDefault)?.id ?? model.thinkingOptions?.[0]?.id ?? "",
        });
        if (!first) first = value;
        if (!preferred && model.isDefault) preferred = value;
      }
    }
    const byProvider = new Map(entries.map((entry) => [entry.provider, entry]));
    return {
      status: query.isPending ? "loading" : query.isError ? "error" : "ready",
      error: query.error instanceof Error ? query.error.message : query.isError ? "Could not list providers." : null,
      models,
      defaultModel: preferred ?? first,
      modesFor: (providerModel) =>
        (byProvider.get(providerOf(providerModel))?.modes ?? []).map((mode) => ({ value: mode.id, label: mode.label })),
      defaultModeFor: (providerModel) => byProvider.get(providerOf(providerModel))?.defaultModeId ?? "",
    };
  }, [query.data, query.error, query.isError, query.isPending]);
}
