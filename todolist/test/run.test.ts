import { describe, expect, it, vi } from "vitest";
import { runWorkItemNow, type RunInput } from "../client/run";
import { baseDocument, withClaim, withWorkItem } from "./helpers/setup";

function setup(thinkingOptionId?: string) {
  const document = withClaim(withWorkItem(baseDocument(), "wi-1"), "wi-1", "att-1");
  const create = vi.fn().mockResolvedValue({ id: "agent-1" });
  const refresh = vi.fn().mockResolvedValue({ workspaceDirectory: "/project/selected" });
  const ref = vi.fn().mockReturnValue({ refresh, agents: { create } });
  const createWorkspace = vi.fn().mockResolvedValue({ id: "wks-new", agents: { create } });
  const acquire = vi.fn().mockResolvedValue({ status: "ok", attempt: document.attempts["att-1"], claim: document.claims["wi-1"] });
  const progress = vi.fn().mockResolvedValue({ status: "ok" });
  const abandon = vi.fn().mockResolvedValue({ status: "ok" });
  const input: RunInput = {
    paseo: { workspaces: { ref, create: createWorkspace } } as unknown as RunInput["paseo"],
    item: document.workItems["wi-1"],
    incarnationId: document.incarnationId,
    seedPrompt: "Do the work",
    seedPromptSource: "work-item-default",
    initiatorLabel: "Test",
    target: { kind: "existing", workspaceId: "selected-workspace" } as RunInput["target"],
    config: { providerModel: "claude/opus", modeId: "auto", ...(thinkingOptionId ? { thinkingOptionId } : {}) },
    rpcs: { acquire, progress, abandon },
    onChange: vi.fn(),
  };
  return { input, create, refresh, ref, progress, abandon, createWorkspace };
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

  it("creates a worktree first, records its request before sending it, and starts the agent there", async () => {
    const { input, create, createWorkspace, progress, ref } = setup();
    input.target = { kind: "new_worktree", branchName: "todo-1-ship-k3x9", baseBranch: "develop", projectRootPath: "/project" };
    await expect(runWorkItemNow(input)).resolves.toMatchObject({ status: "started", agentId: "agent-1", workspaceId: "wks-new" });
    expect(ref).not.toHaveBeenCalled();
    expect(createWorkspace).toHaveBeenCalledExactlyOnceWith({
      source: { kind: "worktree", projectId: "project-1", cwd: "/project", worktreeSlug: "todo-1-ship-k3x9", branchName: "todo-1-ship-k3x9", refName: "develop" },
      firstAgentContext: { prompt: "Do the work" },
    });
    const facets = progress.mock.calls.map(([call]) => call.facet);
    expect(facets.slice(0, 3)).toEqual(["workspace-request", "workspace-observation", "agent-request"]);
    expect(progress.mock.invocationCallOrder[0]).toBeLessThan(createWorkspace.mock.invocationCallOrder[0]!);
    expect(create).toHaveBeenCalledOnce();
  });

  it("uses the project default branch when no base branch is given", async () => {
    const { input, createWorkspace } = setup();
    input.target = { kind: "new_worktree", branchName: "todo-1-k3x9" };
    await runWorkItemNow(input);
    expect(createWorkspace.mock.calls[0][0].source).toEqual({ kind: "worktree", projectId: "project-1", worktreeSlug: "todo-1-k3x9", branchName: "todo-1-k3x9" });
  });

  it("reports a failed worktree request as unknown and never starts an agent or abandons", async () => {
    const { input, create, createWorkspace, progress, abandon } = setup();
    createWorkspace.mockRejectedValue(new Error("socket closed"));
    input.target = { kind: "new_worktree", branchName: "todo-1-k3x9" };
    await expect(runWorkItemNow(input)).resolves.toMatchObject({ status: "error", certainty: "outcome_unknown" });
    expect(create).not.toHaveBeenCalled();
    expect(abandon).not.toHaveBeenCalled();
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ facet: "workspace-request", facts: expect.objectContaining({ workspaceOutcomeUnknownObservedAt: expect.any(String), lastLaunchErrorCode: "workspace_create_outcome_unknown" }) }));
  });
});
