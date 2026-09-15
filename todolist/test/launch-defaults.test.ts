import { describe, expect, it } from "vitest";
import { NEW_WORKSPACE, resolveChoice, resolveWorkspaceTarget } from "../client/launch-defaults";
import { TodoPrefsSchema } from "../shared/prefs";

describe("launch preferences", () => {
  it("reads existing version 1 preferences without losing the saved model or mode", () => {
    expect(TodoPrefsSchema.parse({ launchMode: "run", providerModel: "claude/opus", modeId: "auto" })).toEqual({
      launchMode: "run",
      providerModel: "claude/opus",
      modeId: "auto",
      thinkingOptionId: "",
      workspaceByProject: {},
      boardProjectId: "",
    });
  });

  const workspaces = [{ value: "first" }, { value: "last-used" }, { value: "panel" }];
  const input = { mode: "run" as const, selected: null, saved: "last-used", contextual: "panel", workspaces };

  it("uses the project's remembered workspace in both the sidebar and workspace panel", () => {
    expect(resolveWorkspaceTarget(input)).toBe("last-used");
    expect(resolveWorkspaceTarget({ ...input, contextual: null })).toBe("last-used");
  });

  it("keeps an explicit selection when saved preferences arrive later", () => {
    expect(resolveWorkspaceTarget({ ...input, saved: undefined })).toBe("panel");
    expect(resolveWorkspaceTarget(input)).toBe("last-used");
    expect(resolveWorkspaceTarget({ ...input, selected: "first" })).toBe("first");
  });

  it("keeps each project's saved workspace separate across a settings round trip", () => {
    const preferences = TodoPrefsSchema.parse(JSON.parse(JSON.stringify({ workspaceByProject: { alpha: "last-used", beta: "panel" } })));
    expect(resolveWorkspaceTarget({ ...input, saved: preferences.workspaceByProject.alpha })).toBe("last-used");
    expect(resolveWorkspaceTarget({ ...input, saved: preferences.workspaceByProject.beta })).toBe("panel");
  });

  it("falls back when the saved workspace was removed, archived, or belongs to another project", () => {
    expect(resolveWorkspaceTarget({ ...input, saved: "unavailable" })).toBe("panel");
    expect(resolveWorkspaceTarget({ ...input, saved: "unavailable", contextual: "other-project" })).toBe("first");
    expect(resolveWorkspaceTarget({ ...input, workspaces: [] })).toBe("");
  });

  it("inherits existing workspaces in composer mode and preserves an explicit new-workspace choice", () => {
    expect(resolveWorkspaceTarget({ ...input, mode: "composer" })).toBe("last-used");
    expect(resolveWorkspaceTarget({ ...input, mode: "composer", selected: NEW_WORKSPACE })).toBe(NEW_WORKSPACE);
    expect(resolveWorkspaceTarget({ ...input, mode: "composer", saved: NEW_WORKSPACE })).toBe(NEW_WORKSPACE);
  });

  it("resolves a valid existing workspace when switching from composer to direct execution", () => {
    expect(resolveWorkspaceTarget({ ...input, selected: NEW_WORKSPACE })).toBe("last-used");
    expect(resolveWorkspaceTarget({ ...input, saved: NEW_WORKSPACE })).toBe("panel");
  });
});

describe("thinking selection", () => {
  const options = [{ value: "low" }, { value: "high" }];

  it("uses the model default initially, then remembers a supported choice", () => {
    expect(resolveChoice(options, null, "", "high")).toBe("high");
    expect(resolveChoice(options, null, "low", "high")).toBe("low");
    expect(resolveChoice(options, "high", "low", "high")).toBe("high");
  });

  it("drops unsupported thinking levels on model switches", () => {
    expect(resolveChoice(options, "xhigh", "medium", "high")).toBe("high");
    expect(resolveChoice([], "high", "high", undefined)).toBe("");
  });
});
