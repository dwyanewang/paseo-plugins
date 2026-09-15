import { describe, expect, it } from "vitest";
import { buildCatalogChoices } from "../client/agent-config";

type Entries = Parameters<typeof buildCatalogChoices>[0];

const entries = [
  {
    provider: "claude",
    label: "Claude",
    status: "ready",
    models: [
      { id: "opus", label: "Opus 5" },
      { id: "sonnet", label: "Sonnet 5", isDefault: true },
      { id: "hidden", label: "Hidden", isSelectable: false },
    ],
    modes: [{ id: "auto", label: "Auto" }],
    defaultModeId: "auto",
  },
  { provider: "codex", label: "Codex", status: "ready", models: [{ id: "gpt", label: "GPT-5.5" }] },
  { provider: "offline", label: "Offline", status: "unavailable", models: [{ id: "x", label: "X" }] },
] as unknown as Entries;

describe("run catalog", () => {
  it("lists ready providers and their selectable models", () => {
    const catalog = buildCatalogChoices(entries);
    expect(catalog.providers).toEqual([
      { value: "claude", label: "Claude" },
      { value: "codex", label: "Codex" },
    ]);
    expect(catalog.models.filter((model) => model.provider === "claude").map((model) => model.modelLabel)).toEqual(["Opus 5", "Sonnet 5"]);
  });

  it("picks each provider's default model, or its first", () => {
    const catalog = buildCatalogChoices(entries);
    expect(catalog.defaultModelFor("claude")).toBe("claude/sonnet");
    expect(catalog.defaultModelFor("codex")).toBe("codex/gpt");
    expect(catalog.defaultModelFor("offline")).toBeNull();
    expect(catalog.defaultModel).toBe("claude/sonnet");
    expect(catalog.defaultModeFor("claude/opus")).toBe("auto");
  });
});
