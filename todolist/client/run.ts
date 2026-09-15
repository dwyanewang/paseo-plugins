import type { usePaseo } from "@getpaseo/plugin/client";
import type { z } from "zod";
import type { reportLaunchProgress } from "../shared/contracts";
import { computeRequestFingerprint } from "../shared/fingerprint";
import { createId } from "../shared/ids";
import { buildTodoLabels } from "../shared/labels";
import type { Attempt, WorkItem } from "../shared/schema";
import type { LaunchRpcs } from "./launch";

type PaseoApi = ReturnType<typeof usePaseo>;
type PaseoWorkspaceHandle = ReturnType<PaseoApi["workspaces"]["ref"]>;
type ProgressInput = z.input<typeof reportLaunchProgress.input>;

export interface RunAgentConfig {
  /** Provider and model in `provider/model` form, as the host agent API expects. */
  providerModel: string;
  modeId?: string;
  thinkingOptionId?: string;
}

/** Where a direct run happens: an existing workspace, or a worktree created for this run. */
export type RunTarget =
  | { kind: "existing"; workspaceId: string }
  | {
      kind: "new_worktree";
      branchName: string;
      /** Empty means the project's default branch. */
      baseBranch?: string;
      projectRootPath?: string;
    };

export interface RunInput {
  paseo: PaseoApi;
  item: WorkItem;
  incarnationId: string;
  seedPrompt: string;
  seedPromptSource: "work-item-default" | "launch-edited";
  initiatorLabel: string;
  target: RunTarget;
  config: RunAgentConfig;
  rpcs: LaunchRpcs;
  onChange: () => void;
}

export type RunResult =
  | { status: "started"; attempt: Attempt; agentId: string; workspaceId: string }
  | { status: "error"; message: string; certainty: "not_submitted" | "outcome_unknown" };

function describe(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * Starts the agent from here instead of seeding the native composer. The claim, attempt facts and
 * agent correlation are exactly the ones the composer path writes, so both kinds of attempt read
 * and reconcile identically; only the request-start milestones are reported by this module.
 *
 * Ordering is load-bearing: every milestone is awaited before the effect it describes, so a
 * request that vanishes mid-flight always leaves a persisted `outcome_unknown`, never silence.
 */
export async function runWorkItemNow(input: RunInput): Promise<RunResult> {
  const attemptId = createId("att");
  const clientMessageId = createId("msg");
  const labels = buildTodoLabels(input.item.id, attemptId);
  const requestFingerprint = computeRequestFingerprint({
    projectId: input.item.projectId,
    workItemId: input.item.id,
    attemptId,
    clientMessageId,
    labels,
    seedPrompt: input.seedPrompt,
  });
  let acquired;
  try {
    acquired = await input.rpcs.acquire({
      expectedIncarnationId: input.incarnationId,
      workItemId: input.item.id,
      attemptId,
      requestFingerprint,
      clientMessageId,
      seedPrompt: input.seedPrompt,
      seedPromptSource: input.seedPromptSource,
      initiatorLabel: input.initiatorLabel,
    });
  } catch (error) {
    return { status: "error", message: describe(error, "Could not reach the daemon."), certainty: "not_submitted" };
  }
  input.onChange();
  if (acquired.status !== "ok") {
    return { status: "error", message: acquired.message, certainty: "not_submitted" };
  }
  const { attempt, claim } = acquired;

  const versions = new Map<ProgressInput["facet"], number>();
  const report = async (facet: ProgressInput["facet"], facts: ProgressInput["facts"], agentId?: string) => {
    const factVersion = (versions.get(facet) ?? 0) + 1;
    versions.set(facet, factVersion);
    const result = await input.rpcs.progress({
      expectedIncarnationId: input.incarnationId,
      attemptId: attempt.id,
      generation: claim.generation,
      facet,
      factVersion,
      facts,
      ...(agentId ? { agentId } : {}),
    });
    input.onChange();
    if (result.status !== "ok") throw new Error(result.message);
  };
  /** Releases the claim; false when the daemon refused because a milestone was already recorded. */
  const abandonNotSubmitted = async (): Promise<boolean> => {
    try {
      const result = await input.rpcs.abandon({
        expectedIncarnationId: input.incarnationId,
        workItemId: input.item.id,
        attemptId: attempt.id,
        generation: claim.generation,
        certainty: "not_submitted",
      });
      input.onChange();
      return result.status === "ok";
    } catch {
      // The attempt stays pending and the user can abandon it from the attempt card.
      return false;
    }
  };
  /**
   * A request may have reached the host, or its start was recorded even though the reply was lost.
   * Nothing is retried. The failure is recorded as unknown for both stages, with the workspace when
   * one is known: a stage that never started, or whose result is already known, ignores the flag,
   * so the attempt reads as unknown exactly where a request may be pending, and the card offers
   * abandon or retry instead of resuming the same attempt. The record itself is best effort.
   */
  const outcomeUnknown = async (failure: { error: unknown; fallback: string; code: string; workspaceId?: string }): Promise<RunResult> => {
    const message = describe(failure.error, failure.fallback);
    const now = new Date().toISOString();
    try {
      // Filed under the stage the run reached: the workspace until one is known, then the agent.
      await report(failure.workspaceId ? "agent-request" : "workspace-request", {
        workspaceOutcomeUnknownObservedAt: now,
        agentOutcomeUnknownObservedAt: now,
        ...(failure.workspaceId ? { workspaceIdHint: failure.workspaceId } : {}),
        lastLaunchErrorCode: failure.code,
        lastLaunchErrorMessage: message,
      });
    } catch {
      // Still unknown: the daemon-side reconciler finds a late workspace or agent by its labels.
    }
    return { status: "error", message, certainty: "outcome_unknown" };
  };
  /**
   * Recording a request-start failed, yet the write may have landed before the reply was lost. Each
   * start is the attempt's first recorded milestone after the claim, or follows one that already
   * made it unreleasable, so the daemon refusing "not submitted" means a start may stand: the
   * outcome is then unknown. Otherwise the claim is released.
   */
  const releaseOrUnknown = async (failure: { error: unknown; fallback: string; code: string; workspaceId?: string }): Promise<RunResult> => {
    if (await abandonNotSubmitted()) {
      return { status: "error", message: describe(failure.error, failure.fallback), certainty: "not_submitted" };
    }
    return outcomeUnknown(failure);
  };

  let workspace: PaseoWorkspaceHandle;
  let workspaceId: string;
  if (input.target.kind === "existing") {
    workspaceId = input.target.workspaceId;
    // Resolve the workspace before any milestone is written: a lookup failure here is still a
    // "nothing was submitted" outcome, and reporting it as unknown would be a false alarm.
    workspace = input.paseo.workspaces.ref(workspaceId);
    try {
      const snapshot = await workspace.refresh();
      if (!snapshot?.workspaceDirectory) throw new Error("The workspace has no available directory.");
    } catch (error) {
      await abandonNotSubmitted();
      return { status: "error", message: describe(error, "The workspace is unavailable."), certainty: "not_submitted" };
    }
  } else {
    // The worktree is a request of its own: record its start first, and treat any failure after
    // that as unknown, since the daemon may have created the worktree before the reply was lost.
    try {
      await report("workspace-request", { workspaceRequestStartedAt: new Date().toISOString() });
    } catch (error) {
      return releaseOrUnknown({ error, fallback: "Could not record the launch.", code: "workspace_request_unrecorded" });
    }
    try {
      workspace = await input.paseo.workspaces.create({
        source: {
          kind: "worktree",
          projectId: input.item.projectId,
          ...(input.target.projectRootPath ? { cwd: input.target.projectRootPath } : {}),
          worktreeSlug: input.target.branchName,
          branchName: input.target.branchName,
          ...(input.target.baseBranch ? { refName: input.target.baseBranch } : {}),
        },
        firstAgentContext: { prompt: input.seedPrompt },
      });
      workspaceId = workspace.id;
    } catch (error) {
      return outcomeUnknown({ error, fallback: "The worktree request failed with an unknown outcome.", code: "workspace_create_outcome_unknown" });
    }
  }

  try {
    // One write for the workspace and the agent request. A separate workspace observation would
    // make the attempt unreleasable before anything was sent, so a lost reply here could not be
    // told apart from a recorded start.
    const now = new Date().toISOString();
    await report("agent-request", { workspaceIdHint: workspaceId, workspaceObservedAt: now, agentRequestStartedAt: now });
  } catch (error) {
    // Nothing was sent to the host for the agent, but the start may have been recorded.
    return releaseOrUnknown({ error, fallback: "Could not record the launch.", code: "agent_request_unrecorded", workspaceId });
  }

  let agentId: string;
  try {
    const agent = await workspace.agents.create({
      config: {
        provider: input.config.providerModel,
        ...(input.config.modeId ? { modeId: input.config.modeId } : {}),
        ...(input.config.thinkingOptionId ? { thinkingOptionId: input.config.thinkingOptionId } : {}),
      },
      title: input.item.title,
      prompt: input.seedPrompt,
      clientMessageId: attempt.clientMessageId,
      labels,
    });
    agentId = agent.id;
  } catch (error) {
    return outcomeUnknown({ error, fallback: "The agent request failed with an unknown outcome.", code: "agent_create_outcome_unknown", workspaceId });
  }

  try {
    await report("agent-observation", { workspaceIdHint: workspaceId }, agentId);
  } catch {
    // The agent exists and carries Todo labels; reconciliation links it on the next pass.
  }
  return { status: "started", attempt, agentId, workspaceId };
}
