import type { PluginAgentLaunchEvent, PluginAgentLaunchOpenResult } from "@getpaseo/plugin/client";
import type { z } from "zod";
import type { abandonLaunch, acquireLaunch, reportLaunchProgress, TodoError } from "../shared/contracts";
import { computeRequestFingerprint } from "../shared/fingerprint";
import { createId } from "../shared/ids";
import { buildTodoLabels } from "../shared/labels";
import type { Attempt, LaunchClaim, WorkItem } from "../shared/schema";
import { acquireLaunchWithRecovery } from "./acquire";
import type { OpenAgentLaunch } from "./launch-guard";

type AcquireOutput = z.output<typeof acquireLaunch.output>;
type ProgressInput = z.input<typeof reportLaunchProgress.input>;
type ProgressOutput = z.output<typeof reportLaunchProgress.output>;
type AbandonInput = z.input<typeof abandonLaunch.input>;
type AbandonOutput = z.output<typeof abandonLaunch.output>;

export interface LaunchRpcs {
  acquire: (input: z.input<typeof acquireLaunch.input>) => Promise<AcquireOutput>;
  progress: (input: ProgressInput) => Promise<ProgressOutput>;
  abandon: (input: AbandonInput) => Promise<AbandonOutput>;
}

export interface LaunchTarget {
  kind: "existing" | "new";
  workspaceId?: string;
}

export interface ExecuteInput {
  item: WorkItem;
  incarnationId: string;
  seedPrompt: string;
  seedPromptSource: "work-item-default" | "launch-edited";
  initiatorLabel: string;
  target: LaunchTarget;
  rpcs: LaunchRpcs;
  openAgentLaunch: OpenAgentLaunch;
  onChange: () => void;
}

type OpenResult<Status extends PluginAgentLaunchOpenResult["status"]> = Extract<
  PluginAgentLaunchOpenResult,
  { status: Status }
>;

export type ExecuteResult =
  | { status: "opened" | "restored"; attempt: Attempt; claim: LaunchClaim; open: OpenResult<"opened" | "restored"> }
  | { status: "completed"; attempt: Attempt; claim: LaunchClaim; open: OpenResult<"completed"> }
  | { status: "rejected"; attempt: Attempt; claim: LaunchClaim; open: OpenResult<"rejected"> }
  | { status: "error"; error: TodoError }
  /** The claim request never got a reply: nothing was opened, and a claim may exist. */
  | { status: "unknown"; message: string };

/** Local device identity, learned from the first journal_ready of this runtime. */
let knownClientInstanceId: string | null = null;
export function getKnownClientInstanceId(): string | null {
  return knownClientInstanceId;
}

/**
 * Translates host launch events into `launch.progress` facet reports. Each facet keeps its own
 * monotonic version inside this closure; the server joins fields, not whole facets.
 */
export function createLaunchEventReporter(input: {
  attempt: Attempt;
  claim: LaunchClaim;
  incarnationId: string;
  rpcs: LaunchRpcs;
  onChange: () => void;
}): (event: PluginAgentLaunchEvent) => void {
  const versions = new Map<ProgressInput["facet"], number>();
  const report = (facet: ProgressInput["facet"], facts: ProgressInput["facts"], agentId?: string) => {
    const factVersion = (versions.get(facet) ?? 0) + 1;
    versions.set(facet, factVersion);
    void input.rpcs
      .progress({
        expectedIncarnationId: input.incarnationId,
        attemptId: input.attempt.id,
        generation: input.claim.generation,
        facet,
        factVersion,
        facts,
        ...(agentId ? { agentId } : {}),
      })
      .then(() => input.onChange())
      .catch(() => undefined);
  };
  const abandonNotSubmitted = () => {
    void input.rpcs
      .abandon({
        expectedIncarnationId: input.incarnationId,
        workItemId: input.attempt.workItemId,
        attemptId: input.attempt.id,
        generation: input.claim.generation,
        certainty: "not_submitted",
      })
      .then(() => input.onChange())
      .catch(() => undefined);
  };
  return (event) => {
    const now = new Date().toISOString();
    switch (event.type) {
      case "journal_ready":
        knownClientInstanceId = event.clientInstanceId;
        report("journal", { clientInstanceId: event.clientInstanceId, journalPreparedAt: now });
        return;
      case "workspace_request_started":
        report("workspace-request", { workspaceRequestStartedAt: now });
        return;
      case "workspace_created":
        report("workspace-observation", { workspaceIdHint: event.workspaceId, workspaceObservedAt: now });
        return;
      case "agent_request_started":
        report("agent-request", { agentRequestStartedAt: now, workspaceIdHint: event.workspaceId });
        return;
      case "agent_created":
        report("agent-observation", { workspaceIdHint: event.workspaceId }, event.agentId);
        return;
      case "discarded":
        abandonNotSubmitted();
        return;
      case "failed": {
        if (event.certainty === "not_submitted") {
          if (event.stage === "journal" || event.stage === "open") abandonNotSubmitted();
          return;
        }
        const facet = event.stage === "workspace_create" ? "workspace-request" : "agent-request";
        report(facet, {
          ...(event.stage === "workspace_create"
            ? { workspaceOutcomeUnknownObservedAt: now }
            : { agentOutcomeUnknownObservedAt: now }),
          ...(event.workspaceId ? { workspaceIdHint: event.workspaceId } : {}),
          lastLaunchErrorCode: `${event.stage}_${event.certainty}`,
          lastLaunchErrorMessage: event.message,
        });
        return;
      }
    }
  };
}

/** Every Todo launch entry point goes through this: acquire first, then open the native launch. */
export async function executeWorkItem(input: ExecuteInput): Promise<ExecuteResult> {
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
  const acquired = await acquireLaunchWithRecovery(input.rpcs.acquire, {
    expectedIncarnationId: input.incarnationId,
    workItemId: input.item.id,
    attemptId,
    requestFingerprint,
    clientMessageId,
    seedPrompt: input.seedPrompt,
    seedPromptSource: input.seedPromptSource,
    initiatorLabel: input.initiatorLabel,
    expectedItemVersion: input.item.version,
  });
  input.onChange();
  if (acquired.status === "unknown") return { status: "unknown", message: acquired.message };
  if (acquired.status === "error") return { status: "error", error: acquired.error };
  return openForAttempt({
    attempt: acquired.attempt,
    claim: acquired.claim,
    incarnationId: input.incarnationId,
    target: input.target,
    rpcs: input.rpcs,
    openAgentLaunch: input.openAgentLaunch,
    onChange: input.onChange,
  });
}

/** Opens (or restores on the initiating device) the native launch for an existing attempt. */
export async function openForAttempt(input: {
  attempt: Attempt;
  claim: LaunchClaim;
  incarnationId: string;
  target: LaunchTarget;
  rpcs: LaunchRpcs;
  openAgentLaunch: OpenAgentLaunch;
  onChange: () => void;
  expectedClientInstanceId?: string;
}): Promise<ExecuteResult> {
  const { attempt, claim } = input;
  const onEvent = createLaunchEventReporter({
    attempt,
    claim,
    incarnationId: input.incarnationId,
    rpcs: input.rpcs,
    onChange: input.onChange,
  });
  const open = await input.openAgentLaunch({
    launchId: attempt.id,
    documentIncarnationId: input.incarnationId,
    requestFingerprint: attempt.requestFingerprint,
    projectId: attempt.projectIdSnapshot,
    ...(input.target.workspaceId ? { defaultWorkspaceId: input.target.workspaceId } : {}),
    title: attempt.titleSnapshot,
    seedPrompt: attempt.seedPromptSnapshot,
    clientMessageId: attempt.clientMessageId,
    labels: buildTodoLabels(attempt.workItemId, attempt.id),
    ...(input.expectedClientInstanceId
      ? { expectedClientInstanceId: input.expectedClientInstanceId }
      : {}),
    workspace: {
      allowExisting: input.target.kind === "existing",
      allowCreate: input.target.kind === "new",
    },
    onEvent,
  });
  if (open.status === "rejected") return { status: "rejected", attempt, claim, open };
  if (open.status === "completed") return { status: "completed", attempt, claim, open };
  return { status: open.status, attempt, claim, open };
}
