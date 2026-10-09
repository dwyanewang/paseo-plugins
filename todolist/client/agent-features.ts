import type { usePaseo } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import type { FeatureValues } from "../shared/prefs";

type PaseoApi = ReturnType<typeof usePaseo>;
export type AgentFeature = NonNullable<Awaited<ReturnType<PaseoApi["providers"]["listFeatures"]>>["features"]>[number];
type FeatureDraft = Parameters<PaseoApi["providers"]["listFeatures"]>[0];

/** Only values advertised by this provider may reach a new agent. False is an explicit choice. */
export function resolveAgentFeatures(features: readonly AgentFeature[], saved: FeatureValues = {}, selected: FeatureValues = {}): { features: AgentFeature[]; values: FeatureValues } {
  const values: FeatureValues = {};
  const resolved = features.map((feature): AgentFeature => {
    const valid = (value: unknown): boolean => feature.type === "toggle"
      ? typeof value === "boolean"
      : value === null || (typeof value === "string" && feature.options.some((option) => option.id === value));
    const value = valid(selected[feature.id]) ? selected[feature.id] : valid(saved[feature.id]) ? saved[feature.id] : feature.value;
    values[feature.id] = value;
    return feature.type === "toggle" ? { ...feature, value: value as boolean } : { ...feature, value: value as string | null };
  });
  return { features: resolved, values };
}

export async function loadAgentFeatures(paseo: PaseoApi, draft: FeatureDraft): Promise<AgentFeature[]> {
  const result = await paseo.providers.listFeatures(draft);
  if (result.error) throw new Error(result.error);
  return result.features ?? [];
}

/** Features are not in the model snapshot: discover them for the actual launch directory. */
export function useAgentFeatures(paseo: PaseoApi, draft: FeatureDraft | null) {
  return useQuery({
    queryKey: ["todo", "provider-features", draft],
    enabled: draft !== null,
    staleTime: 60_000,
    queryFn: () => loadAgentFeatures(paseo, draft!),
  });
}
