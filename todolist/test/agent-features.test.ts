import { describe, expect, it, vi } from "vitest";
import { loadAgentFeatures, resolveAgentFeatures, type AgentFeature } from "../client/agent-features";
import { TodoPrefsSchema } from "../shared/prefs";

const features: AgentFeature[] = [
  { type: "toggle", id: "auto_accept", label: "Auto-accept", value: false },
  { type: "select", id: "tools", label: "Tools", value: "safe", options: [{ id: "safe", label: "Safe" }, { id: "all", label: "All" }] },
];

describe("agent feature choices", () => {
  it("uses provider defaults without automatically enabling auto-accept", () => {
    expect(resolveAgentFeatures(features)).toEqual({ features, values: { auto_accept: false, tools: "safe" } });
  });

  it("honors an explicit false over a saved true, and drops foreign features", () => {
    expect(resolveAgentFeatures(features, { auto_accept: true, tools: "all", foreign: true }, { auto_accept: false }).values).toEqual({ auto_accept: false, tools: "all" });
  });

  it("validates selects and toggles, while preserving a select's explicit default", () => {
    expect(resolveAgentFeatures(features, { auto_accept: true, tools: "gone" }, { auto_accept: "true", tools: null }).values).toEqual({ auto_accept: true, tools: null });
  });

  it("keeps saved values separate by provider through a settings round trip", () => {
    const prefs = TodoPrefsSchema.parse({ featuresByProvider: { opencode: { auto_accept: true }, codex: { fast_mode: false } } });
    expect(resolveAgentFeatures(features, prefs.featuresByProvider.opencode).values.auto_accept).toBe(true);
    expect(resolveAgentFeatures(features, prefs.featuresByProvider.codex).values.auto_accept).toBe(false);
  });

  it("discovers features with the selected directory, model, mode and thinking", async () => {
    const listFeatures = vi.fn().mockResolvedValue({ features });
    const paseo = { providers: { listFeatures } } as unknown as Parameters<typeof loadAgentFeatures>[0];
    const draft = { provider: "opencode/dw-openai/gpt-6.1-sol", cwd: "/project/worktree", modeId: "build", thinkingOptionId: "xhigh" };
    await expect(loadAgentFeatures(paseo, draft)).resolves.toEqual(features);
    expect(listFeatures).toHaveBeenCalledExactlyOnceWith(draft);
    listFeatures.mockResolvedValue({ error: "Provider unavailable" });
    await expect(loadAgentFeatures(paseo, draft)).rejects.toThrow("Provider unavailable");
  });
});
