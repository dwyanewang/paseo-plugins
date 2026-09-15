import { describe, expect, it, vi } from "vitest";
import { runWorkItemNow, type RunInput } from "../client/run";
import { baseDocument, withClaim, withWorkItem } from "./helpers/setup";

function setup(thinkingOptionId?: string) {
  const document = withClaim(withWorkItem(baseDocument(), "wi-1"), "wi-1", "att-1");
  const create = vi.fn().mockResolvedValue({ id: "agent-1" });
  const refresh = vi.fn().mockResolvedValue({ workspaceDirectory: "/project/selected" });
  const ref = vi.fn().mockReturnValue({ refresh, agents: { create } });
  const acquire = vi.fn().mockResolvedValue({ status: "ok", attempt: document.attempts["att-1"], claim: document.claims["wi-1"] });
  const progress = vi.fn().mockResolvedValue({ status: "ok" });
  const abandon = vi.fn().mockResolvedValue({ status: "ok" });
  const input: RunInput = {
    paseo: { workspaces: { ref } } as unknown as RunInput["paseo"],
    item: document.workItems["wi-1"],
    incarnationId: document.incarnationId,
    seedPrompt: "Do the work",
    seedPromptSource: "work-item-default",
    initiatorLabel: "Test",
    workspaceId: "selected-workspace",
    config: { providerModel: "claude/opus", modeId: "auto", ...(thinkingOptionId ? { thinkingOptionId } : {}) },
    rpcs: { acquire, progress, abandon },
    onChange: vi.fn(),
  };
  return { input, create, refresh, ref, progress, abandon };
}

describe("direct execution", () => {
  it("starts in the chosen workspace with the selected thinking level, mode and prompt", async () => {
    const { input, create, ref, progress } = setup("high");
    await expect(runWorkItemNow(input)).resolves.toMatchObject({ status: "started", agentId: "agent-1" });
    expect(ref).toHaveBeenCalledWith("selected-workspace");
    expect(create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      config: { provider: "claude/opus", modeId: "auto", thinkingOptionId: "high" },
      prompt: "Do the work",
    }));
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ facet: "agent-request", facts: expect.objectContaining({ workspaceIdHint: "selected-workspace" }) }));
  });

  it("omits thinking for models without a thinking selection", async () => {
    const { input, create } = setup();
    await runWorkItemNow(input);
    expect(create.mock.calls[0][0].config).toEqual({ provider: "claude/opus", modeId: "auto" });
  });

  it("does not start an agent if the selected workspace becomes unavailable", async () => {
    const { input, refresh, create, abandon } = setup("high");
    refresh.mockRejectedValue(new Error("Workspace unavailable"));
    await expect(runWorkItemNow(input)).resolves.toMatchObject({ status: "error", certainty: "not_submitted" });
    expect(create).not.toHaveBeenCalled();
    expect(abandon).toHaveBeenCalledOnce();
  });
});
