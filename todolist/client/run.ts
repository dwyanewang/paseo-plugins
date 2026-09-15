import type { usePaseo } from "@getpaseo/plugin/client";
import type { z } from "zod";
import type { reportLaunchProgress } from "../shared/contracts";
import { computeRequestFingerprint } from "../shared/fingerprint";
import { createId } from "../shared/ids";
import { buildTodoLabels } from "../shared/labels";
import type { Attempt, WorkItem } from "../shared/schema";
import type { LaunchRpcs } from "./launch";

type PaseoApi = ReturnType<typeof usePaseo>;
type ProgressInput = z.input<typeof reportLaunchProgress.input>;

export interface RunAgentConfig {
  /** Provider and model in `provider/model` form, as the host agent API expects. */
  providerModel: string;
  modeId?: string;
  thinkingOptionId?: string;
}

export interface RunInput {
  paseo: PaseoApi;
  item: WorkItem;
  incarnationId: string;
  seedPrompt: string;
  seedPromptSource: "work-item-default" | "launch-edited";
  initiatorLabel: string;
  workspaceId: string;
  config: RunAgentConfig;
  rpcs: LaunchRpcs;
  onChange: () => void;
}

export type RunResult =
  | { status: "started"; attempt: Attempt; agentId: string }
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
  const abandonNotSubmitted = async () => {
    try {
      await input.rpcs.abandon({
        expectedIncarnationId: input.incarnationId,
        workItemId: input.item.id,
        attemptId: attempt.id,
        generation: claim.generation,
        certainty: "not_submitted",
      });
      input.onChange();
    } catch {
      // The attempt stays pending and the user can abandon it from the attempt card.
    }
  };

  // Resolve the workspace before any milestone is written: a lookup failure here is still a
  // "nothing was submitted" outcome, and reporting it as unknown would be a false alarm.
  const workspace = input.paseo.workspaces.ref(input.workspaceId);
  try {
    const snapshot = await workspace.refresh();
    if (!snapshot?.workspaceDirectory) throw new Error("The workspace has no available directory.");
  } catch (error) {
    await abandonNotSubmitted();
    return { status: "error", message: describe(error, "The workspace is unavailable."), certainty: "not_submitted" };
  }

  const startedAt = new Date().toISOString();
  try {
    // The workspace already exists, so its stage is known before anything is submitted.
    await report("workspace-observation", {
      workspaceIdHint: input.workspaceId,
      workspaceObservedAt: startedAt,
    });
    await report("agent-request", {
      agentRequestStartedAt: startedAt,
      workspaceIdHint: input.workspaceId,
    });
  } catch (error) {
    // Nothing was sent to the host yet: release the claim rather than leave it pending.
    await abandonNotSubmitted();
    return { status: "error", message: describe(error, "Could not record the launch."), certainty: "not_submitted" };
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
    const message = describe(error, "The agent request failed with an unknown outcome.");
    const now = new Date().toISOString();
    try {
      await report("agent-request", {
        agentOutcomeUnknownObservedAt: now,
        workspaceIdHint: input.workspaceId,
        lastLaunchErrorCode: "agent_create_outcome_unknown",
        lastLaunchErrorMessage: message,
      });
    } catch {
      // Best effort: the daemon-side reconciler still finds a late agent by its Todo labels.
    }
    return { status: "error", message, certainty: "outcome_unknown" };
  }

  try {
    await report("agent-observation", { workspaceIdHint: input.workspaceId }, agentId);
  } catch {
    // The agent exists and carries Todo labels; reconciliation links it on the next pass.
  }
  return { status: "started", attempt, agentId };
}
