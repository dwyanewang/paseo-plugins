import { describe, expect, it, vi } from "vitest";
import { runWorkItemNow, type RunInput } from "../client/run";
import { abandonLaunchMutation, acquireLaunchMutation, reportLaunchProgressMutation } from "../server/mutations";
import { isAttemptOutcomeUnknown } from "../shared/attempt";
import type { TodoDocument } from "../shared/schema";
import { NOW, baseDocument, withClaim, withWorkItem } from "./helpers/setup";

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

/**
 * Launch RPCs backed by the real mutations. A write can be set to fail before it lands, or to land
 * and then lose its reply, which is what a dropped connection does to the client.
 */
function persistentLaunch() {
  let document: TodoDocument = withWorkItem(baseDocument(), "wi-1");
  const faults = new Map<string, "before" | "after">();
  type Outcome = { status: string; values?: TodoDocument; result?: object; message?: string };
  const settle = (key: string, outcome: Outcome) => {
    const fault = faults.get(key);
    faults.delete(key);
    if (fault === "before") throw new Error("connection lost");
    if (outcome.status === "commit" && outcome.values) document = outcome.values;
    if (fault === "after") throw new Error("connection lost");
    return outcome.status === "commit" || outcome.status === "unchanged" ? { status: "ok", ...outcome.result } : outcome;
  };
  const rpcs = {
    // The server handler adds project availability from the host before calling the mutation.
    acquire: async (input: object) => settle("acquire", acquireLaunchMutation(document, { ...input, projectAvailable: true } as never, NOW) as Outcome),
    progress: async (input: { facet: string }) => settle(`progress:${input.facet}`, reportLaunchProgressMutation(document, input as never, NOW) as Outcome),
    abandon: async (input: unknown) => settle("abandon", abandonLaunchMutation(document, input as never, NOW) as Outcome),
  } as unknown as RunInput["rpcs"];
  const create = vi.fn().mockResolvedValue({ id: "agent-1" });
  const createWorkspace = vi.fn().mockResolvedValue({ id: "wks-new", agents: { create } });
  const refresh = vi.fn().mockResolvedValue({ workspaceDirectory: "/project/selected" });
  const input: RunInput = {
    paseo: { workspaces: { ref: vi.fn().mockReturnValue({ refresh, agents: { create } }), create: createWorkspace } } as unknown as RunInput["paseo"],
    item: document.workItems["wi-1"]!,
    incarnationId: document.incarnationId,
    seedPrompt: "Do the work",
    seedPromptSource: "work-item-default",
    initiatorLabel: "Test",
    target: { kind: "new_worktree", branchName: "todo-1-k3x9" },
    config: { providerModel: "claude/opus" },
    rpcs,
    onChange: vi.fn(),
  };
  return {
    input,
    create,
    createWorkspace,
    fail: (key: string, when: "before" | "after") => faults.set(key, when),
    attempt: () => Object.values(document.attempts)[0]!,
    claim: () => document.claims["wi-1"],
  };
}

describe("direct execution when a launch write loses its reply", () => {
  it("keeps an unknown outcome when the worktree request start landed but its reply was lost", async () => {
    const launch = persistentLaunch();
    launch.fail("progress:workspace-request", "after");
    await expect(runWorkItemNow(launch.input)).resolves.toMatchObject({ status: "error", certainty: "outcome_unknown" });
    expect(launch.createWorkspace).not.toHaveBeenCalled();
    // The daemon refused to call it "not submitted", so the claim stays and the outcome is unknown.
    expect(launch.claim()?.state).toBe("pending");
    expect(isAttemptOutcomeUnknown(launch.attempt())).toBe(true);
    expect(launch.attempt().lastLaunchErrorCode).toBe("workspace_request_unrecorded");
  });

  it("releases the claim when the worktree request start never landed", async () => {
    const launch = persistentLaunch();
    launch.fail("progress:workspace-request", "before");
    await expect(runWorkItemNow(launch.input)).resolves.toMatchObject({ status: "error", certainty: "not_submitted" });
    expect(launch.claim()?.state).toBe("abandoned");
    expect(launch.createWorkspace).not.toHaveBeenCalled();
  });

  it("records the new worktree and an unknown outcome when observing it fails", async () => {
    const launch = persistentLaunch();
    launch.fail("progress:workspace-observation", "before");
    await expect(runWorkItemNow(launch.input)).resolves.toMatchObject({ status: "error", certainty: "outcome_unknown" });
    expect(launch.create).not.toHaveBeenCalled();
    expect(launch.attempt()).toMatchObject({ workspaceIdHint: "wks-new", lastLaunchErrorCode: "workspace_observation_unrecorded" });
    expect(isAttemptOutcomeUnknown(launch.attempt())).toBe(true);
  });

  it("never sends the agent request after its start landed without a reply", async () => {
    const launch = persistentLaunch();
    launch.input.target = { kind: "existing", workspaceId: "selected-workspace" };
    launch.fail("progress:agent-request", "after");
    await expect(runWorkItemNow(launch.input)).resolves.toMatchObject({ status: "error", certainty: "outcome_unknown" });
    expect(launch.create).not.toHaveBeenCalled();
    expect(launch.claim()?.state).toBe("pending");
    expect(isAttemptOutcomeUnknown(launch.attempt())).toBe(true);
    expect(launch.attempt().workspaceIdHint).toBe("selected-workspace");
  });
});
