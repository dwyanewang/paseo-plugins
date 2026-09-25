import type { z } from "zod";
import type {
  abandonLaunch,
  acquireLaunch,
  createWorkItem,
  forgetAttempt,
  moveWorkItem,
  purgeWorkItem,
  rebindWorkItemProject,
  reportLaunchProgress,
  setWorkItemArchived,
  updateWorkItem,
} from "../shared/contracts";
import { deriveAutoMove, withStatus, type AutoMove } from "../shared/board";
import {
  abandonAttempt,
  isAttemptNotSubmitted,
  isAttemptOutcomeUnknown,
  isAttemptSettled,
  joinAttemptFacts,
  type AttemptFacts,
} from "../shared/attempt";
import {
  RETIRED_RING_MAX_ENTRIES,
  RETIRED_RING_RETENTION_MS,
  validateInitiatorLabel,
  validateSeedPrompt,
  validateWorkItemFields,
  validateWorkItemFiles,
  validateWorkItemImages,
  type FieldError,
} from "../shared/limits";
import type {
  AgentLink,
  Attempt,
  LaunchClaim,
  TodoDocument,
  TodoFileRef,
  TodoImageRef,
  WorkItem,
  WorkItemStatus,
} from "../shared/schema";
import type { WorkItemFileInput, WorkItemImageInput } from "../shared/contracts";
import { aggregateWorkItem, isActiveDisplayState } from "../shared/state";
import type { MutationError, MutationOutcome } from "./store";

type Input<Contract extends { input: z.ZodType }> = z.output<Contract["input"]>;

function error(
  status: MutationError["status"],
  message: string,
  details?: MutationError["details"],
): MutationError {
  return details ? { status, message, details } : { status, message };
}

function fieldError(failure: FieldError): MutationError {
  return error("invalid_input", `${failure.field} is ${failure.reason.replace("_", " ")}.`, {
    field: failure.field,
    reason: failure.reason,
  });
}

function touched(item: WorkItem, now: string, patch: Partial<WorkItem>): WorkItem {
  return { ...item, ...patch, version: item.version + 1, updatedAt: now };
}

/** Normalizes submitted image references into stored refs; the client owns the id and byte count. */
function buildImages(inputs: readonly WorkItemImageInput[] | undefined): TodoImageRef[] {
  if (!inputs || inputs.length === 0) return [];
  return inputs.map(toRef);
}

function toRef(input: WorkItemImageInput): TodoImageRef {
  return {
    id: input.id,
    mimeType: input.mimeType,
    ...(input.name ? { name: input.name } : {}),
    byteLength: input.byteLength,
  };
}

/**
 * Resolves a full replacement reference set against the stored one. Returns null when the set is
 * unchanged, so an edit that only touched other fields does not churn the version.
 */
function reconcileImages(
  current: readonly TodoImageRef[],
  desired: readonly WorkItemImageInput[],
): TodoImageRef[] | null {
  const unchanged =
    current.length === desired.length &&
    current.every((ref, index) => desired[index]?.id === ref.id);
  if (unchanged) return null;
  return desired.map(toRef);
}

function toFileRef(input: WorkItemFileInput): TodoFileRef {
  return { id: input.id, name: input.name, mimeType: input.mimeType, byteLength: input.byteLength };
}

/** Like `reconcileImages`: null when the file set is unchanged. */
function reconcileFiles(current: readonly TodoFileRef[], desired: readonly WorkItemFileInput[]): TodoFileRef[] | null {
  const unchanged =
    current.length === desired.length &&
    current.every((ref, index) => desired[index]?.id === ref.id);
  if (unchanged) return null;
  return desired.map(toFileRef);
}

export function attemptsForWorkItem(document: TodoDocument, workItemId: string): Attempt[] {
  return Object.values(document.attempts)
    .filter((attempt) => attempt.workItemId === workItemId)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export function linksForWorkItem(document: TodoDocument, workItemId: string): AgentLink[] {
  return Object.values(document.agentLinks).filter((link) => link.workItemId === workItemId);
}

function boardFacts(document: TodoDocument, item: WorkItem) {
  const aggregate = aggregateWorkItem({
    claim: document.claims[item.id],
    attempts: attemptsForWorkItem(document, item.id),
    links: linksForWorkItem(document, item.id),
  });
  return {
    busy: aggregate.activeAgentIds.length > 0,
    launchSettled: aggregate.pendingClaim === null && aggregate.unknownAttemptIds.length === 0,
  };
}

/**
 * Folds the agent-driven board moves into a snapshot write that is already committing: `before`
 * is the document the mutation started from, `after` its result. Returns `after` unchanged when
 * no move applies, so the move never costs a write of its own.
 */
export function withAgentAutoMove(
  before: TodoDocument,
  after: TodoDocument,
  input: { workItemId: string; agentFinished: boolean },
  now: string,
): { document: TodoDocument; autoMove: AutoMove | null } {
  const previous = before.workItems[input.workItemId];
  const item = after.workItems[input.workItemId];
  if (!previous || !item) return { document: after, autoMove: null };
  const was = boardFacts(before, previous);
  const is = boardFacts(after, item);
  const autoMove = deriveAutoMove(item.status, {
    kind: "agent_observed",
    busyBefore: was.busy,
    busyAfter: is.busy,
    agentFinished: input.agentFinished,
    launchSettled: is.launchSettled,
  });
  if (!autoMove) return { document: after, autoMove: null };
  const workItem = withStatus(item, autoMove.to, autoMove.reason, now);
  return {
    document: { ...after, workItems: { ...after.workItems, [workItem.id]: workItem } },
    autoMove,
  };
}

export function createWorkItemMutation(
  document: TodoDocument,
  input: Input<typeof createWorkItem>,
  now: string,
): MutationOutcome<{ workItem: WorkItem; created: boolean }> {
  const existing = document.workItems[input.id];
  if (existing) {
    if (existing.creationFingerprint === input.creationFingerprint) {
      return { status: "unchanged", result: { workItem: existing, created: false } };
    }
    return error("id_conflict", "A different work item already uses this ID.");
  }
  const retired = document.retiredWorkItemIds.find((entry) => entry.id === input.id);
  if (retired) {
    if (retired.creationFingerprint === input.creationFingerprint) {
      return error("retired_id", "This work item was purged and cannot be recreated by retry.");
    }
    return error("id_conflict", "This ID was retired by a purged work item.");
  }
  const invalid = validateWorkItemFields(input);
  if (invalid) return fieldError(invalid);
  const imagesInvalid = validateWorkItemImages(input.images);
  if (imagesInvalid) return fieldError(imagesInvalid);
  const filesInvalid = validateWorkItemFiles(input.files);
  if (filesInvalid) return fieldError(filesInvalid);
  const status = input.status ?? "todo";
  const workItem: WorkItem = {
    id: input.id,
    creationFingerprint: input.creationFingerprint,
    version: 1,
    number: document.nextWorkItemNumber,
    projectId: input.projectId,
    projectNameSnapshot: input.projectNameSnapshot,
    ...(input.projectRootSnapshot ? { projectRootSnapshot: input.projectRootSnapshot } : {}),
    title: input.title.trim(),
    details: input.details,
    defaultPrompt: input.defaultPrompt,
    images: buildImages(input.images),
    files: (input.files ?? []).map(toFileRef),
    status,
    statusChangedAt: now,
    statusReason: "created",
    priority: input.priority ?? "none",
    createdAt: now,
    updatedAt: now,
  };
  return {
    status: "commit",
    values: {
      ...document,
      nextWorkItemNumber: document.nextWorkItemNumber + 1,
      workItems: { ...document.workItems, [workItem.id]: workItem },
    },
    result: { workItem, created: true },
  };
}

function requireVersioned(
  document: TodoDocument,
  id: string,
  expectedVersion: number,
): WorkItem | MutationError {
  const item = document.workItems[id];
  if (!item) return error("not_found", "The work item no longer exists.");
  if (item.version !== expectedVersion) {
    return error("conflict", "The work item changed elsewhere. Reload before editing again.", {
      currentVersion: item.version,
    });
  }
  return item;
}

function isError(value: WorkItem | MutationError): value is MutationError {
  return "status" in value && typeof (value as MutationError).status === "string" && !("id" in value);
}

export function updateWorkItemMutation(
  document: TodoDocument,
  input: Input<typeof updateWorkItem>,
  now: string,
): MutationOutcome<{ workItem: WorkItem }> {
  const item = requireVersioned(document, input.id, input.expectedVersion);
  if (isError(item)) return item;
  const invalid = validateWorkItemFields(input.patch);
  if (invalid) return fieldError(invalid);
  const imagesInvalid = validateWorkItemImages(input.patch.images);
  if (imagesInvalid) return fieldError(imagesInvalid);
  const filesInvalid = validateWorkItemFiles(input.patch.files);
  if (filesInvalid) return fieldError(filesInvalid);
  const patch: Partial<WorkItem> = {};
  if (input.patch.title !== undefined && input.patch.title.trim() !== item.title) {
    patch.title = input.patch.title.trim();
  }
  if (input.patch.details !== undefined && input.patch.details !== item.details) {
    patch.details = input.patch.details;
  }
  if (input.patch.defaultPrompt !== undefined && input.patch.defaultPrompt !== item.defaultPrompt) {
    patch.defaultPrompt = input.patch.defaultPrompt;
  }
  if (input.patch.priority !== undefined && input.patch.priority !== item.priority) {
    patch.priority = input.patch.priority;
  }
  if (input.patch.images !== undefined) {
    const nextImages = reconcileImages(item.images, input.patch.images);
    if (nextImages) patch.images = nextImages;
  }
  if (input.patch.files !== undefined) {
    const nextFiles = reconcileFiles(item.files, input.patch.files);
    if (nextFiles) patch.files = nextFiles;
  }
  if (Object.keys(patch).length === 0) return { status: "unchanged", result: { workItem: item } };
  const workItem = touched(item, now, patch);
  return {
    status: "commit",
    values: { ...document, workItems: { ...document.workItems, [workItem.id]: workItem } },
    result: { workItem },
  };
}

export function rebindWorkItemProjectMutation(
  document: TodoDocument,
  input: Input<typeof rebindWorkItemProject>,
  now: string,
): MutationOutcome<{ workItem: WorkItem }> {
  const item = requireVersioned(document, input.id, input.expectedVersion);
  if (isError(item)) return item;
  if (item.projectId === input.projectId) return { status: "unchanged", result: { workItem: item } };
  const workItem = touched(item, now, {
    projectId: input.projectId,
    projectNameSnapshot: input.projectNameSnapshot,
  });
  if (input.projectRootSnapshot) workItem.projectRootSnapshot = input.projectRootSnapshot;
  else delete workItem.projectRootSnapshot;
  return {
    status: "commit",
    values: { ...document, workItems: { ...document.workItems, [workItem.id]: workItem } },
    result: { workItem },
  };
}

export function moveWorkItemMutation(
  document: TodoDocument,
  input: Input<typeof moveWorkItem>,
  now: string,
): MutationOutcome<{ workItem: WorkItem; previousStatus: WorkItemStatus }> {
  const item = document.workItems[input.id];
  if (!item) return error("not_found", "The work item no longer exists.");
  const previousStatus = item.status;
  if (item.status === input.status) return { status: "unchanged", result: { workItem: item, previousStatus } };
  const workItem = withStatus(item, input.status, "manual", now);
  return {
    status: "commit",
    values: { ...document, workItems: { ...document.workItems, [workItem.id]: workItem } },
    result: { workItem, previousStatus },
  };
}

export function setWorkItemArchivedMutation(
  document: TodoDocument,
  input: Input<typeof setWorkItemArchived>,
  now: string,
): MutationOutcome<{ workItem: WorkItem }> {
  const item = requireVersioned(document, input.id, input.expectedVersion);
  if (isError(item)) return item;
  if (Boolean(item.archivedAt) === input.archived) {
    return { status: "unchanged", result: { workItem: item } };
  }
  const workItem = touched(item, now, {});
  if (input.archived) workItem.archivedAt = now;
  else delete workItem.archivedAt;
  return {
    status: "commit",
    values: { ...document, workItems: { ...document.workItems, [workItem.id]: workItem } },
    result: { workItem },
  };
}

export function purgeWorkItemMutation(
  document: TodoDocument,
  input: Input<typeof purgeWorkItem>,
  now: string,
): MutationOutcome<Record<string, never>> {
  const item = requireVersioned(document, input.id, input.expectedVersion);
  if (isError(item)) return item;
  if (!item.archivedAt) {
    return error("invalid_transition", "Only archived work items can be purged.");
  }
  const claim = document.claims[item.id];
  const attempts = attemptsForWorkItem(document, item.id);
  const links = linksForWorkItem(document, item.id);
  const aggregate = aggregateWorkItem({ claim, attempts, links });
  if (aggregate.blockedReason === "claim_held") {
    return error("claim_held", "Abandon the pending launch before purging.");
  }
  if (!input.force) {
    if (aggregate.blockedReason === "active_agent") {
      return error("active_agent", "A linked agent is still active.");
    }
    if (aggregate.blockedReason === "stale_agent") {
      return error("stale_agent", "A linked agent was last seen active and has not been refreshed.");
    }
    // An unknown outcome stays unknown after abandon: late entities may still appear, so only a
    // forced purge (with its warning) may drop the correlation records.
    const unknown = attempts.find((attempt) => isAttemptOutcomeUnknown(attempt));
    if (unknown) {
      return error(
        "invalid_transition",
        "An attempt has an unknown outcome. Force the purge to drop its late correlations.",
        { attemptId: unknown.id, reason: "outcome_unknown" },
      );
    }
    const unsettled = attempts.find((attempt) => !isAttemptSettled(attempt));
    if (unsettled) {
      return error(
        "invalid_transition",
        "An attempt is still open. Abandon it explicitly before purging.",
        { attemptId: unsettled.id, reason: "unsettled_attempt" },
      );
    }
  }
  const workItems = { ...document.workItems };
  delete workItems[item.id];
  const claims = { ...document.claims };
  delete claims[item.id];
  const remainingAttempts = Object.fromEntries(
    Object.entries(document.attempts).filter(([, attempt]) => attempt.workItemId !== item.id),
  );
  const remainingLinks = Object.fromEntries(
    Object.entries(document.agentLinks).filter(([, link]) => link.workItemId !== item.id),
  );
  const cutoff = Date.parse(now) - RETIRED_RING_RETENTION_MS;
  const retiredWorkItemIds = [
    ...document.retiredWorkItemIds.filter((entry) => Date.parse(entry.retiredAt) >= cutoff),
    { id: item.id, creationFingerprint: item.creationFingerprint, retiredAt: now },
  ].slice(-RETIRED_RING_MAX_ENTRIES);
  return {
    status: "commit",
    values: {
      ...document,
      workItems,
      claims,
      attempts: remainingAttempts,
      agentLinks: remainingLinks,
      retiredWorkItemIds,
    },
    result: {},
    kind: "recovery",
  };
}

export function acquireLaunchMutation(
  document: TodoDocument,
  input: Input<typeof acquireLaunch> & { projectAvailable: boolean },
  now: string,
): MutationOutcome<{ attempt: Attempt; claim: LaunchClaim; created: boolean }> {
  const item = document.workItems[input.workItemId];
  if (!item) return error("not_found", "The work item no longer exists.");
  const existingAttempt = document.attempts[input.attemptId];
  const claim = document.claims[item.id];
  if (existingAttempt) {
    if (existingAttempt.workItemId !== item.id) {
      return error("launch_key_conflict", "This attempt ID belongs to another work item.");
    }
    if (existingAttempt.requestFingerprint !== input.requestFingerprint) {
      return error("launch_key_conflict", "This attempt ID was already used with different inputs.");
    }
    if (!claim || claim.attemptId !== existingAttempt.id) {
      return error("stale_launch", "This attempt is no longer the current launch.");
    }
    return { status: "unchanged", result: { attempt: existingAttempt, claim, created: false } };
  }
  if (input.expectedItemVersion !== undefined && item.version !== input.expectedItemVersion) {
    return error("conflict", "The work item changed since this launch was prepared. Reload and try again.");
  }
  if (item.status === "done" || item.status === "cancelled") {
    return error("invalid_transition", "Move the work item out of Done or Cancelled first.");
  }
  if (item.archivedAt) return error("invalid_transition", "Restore the work item first.");
  if (!input.projectAvailable) {
    return error("project_unavailable", "The project is unavailable. Rebind the work item first.");
  }
  const seedInvalid = validateSeedPrompt(input.seedPrompt);
  if (seedInvalid) return fieldError(seedInvalid);
  const labelInvalid = validateInitiatorLabel(input.initiatorLabel);
  if (labelInvalid) return fieldError(labelInvalid);
  const aggregate = aggregateWorkItem({
    claim,
    attempts: attemptsForWorkItem(document, item.id),
    links: linksForWorkItem(document, item.id),
  });
  if (aggregate.blockedReason === "claim_held" && claim) {
    return error("claim_held", `Another launch is being prepared (${claim.initiatorLabel}).`, {
      attemptId: claim.attemptId,
      initiatorLabel: claim.initiatorLabel,
    });
  }
  if (aggregate.blockedReason === "active_agent") {
    return error("active_agent", "A linked agent is still active.", {
      agentId: aggregate.activeAgentIds[0] ?? "",
    });
  }
  if (aggregate.blockedReason === "stale_agent") {
    return error("stale_agent", "A linked agent was last seen active and has not been refreshed.", {
      agentId: aggregate.activeAgentIds[0] ?? "",
    });
  }
  const generation = (claim?.generation ?? 0) + 1;
  const attempt: Attempt = {
    id: input.attemptId,
    workItemId: item.id,
    claimGeneration: generation,
    requestFingerprint: input.requestFingerprint,
    projectIdSnapshot: item.projectId,
    projectNameSnapshot: item.projectNameSnapshot,
    titleSnapshot: item.title,
    seedPromptSnapshot: input.seedPrompt,
    seedPromptSource: input.seedPromptSource,
    clientMessageId: input.clientMessageId,
    initiatorLabel: input.initiatorLabel,
    factVersions: {},
    userDisposition: "active",
    createdAt: now,
    updatedAt: now,
  };
  const nextClaim: LaunchClaim = {
    workItemId: item.id,
    attemptId: attempt.id,
    generation,
    state: "pending",
    initiatorLabel: input.initiatorLabel,
    createdAt: now,
    updatedAt: now,
  };
  return {
    status: "commit",
    values: {
      ...document,
      attempts: { ...document.attempts, [attempt.id]: attempt },
      claims: { ...document.claims, [item.id]: nextClaim },
    },
    result: { attempt, claim: nextClaim, created: true },
  };
}

function sanitizeClientFacts(document: TodoDocument, attempt: Attempt, facts: AttemptFacts) {
  const sanitized: AttemptFacts = { ...facts };
  // A client may only assert an agent observation once a verified link exists for the attempt.
  const verified = Object.values(document.agentLinks).some((link) => link.attemptId === attempt.id);
  if (!verified) delete sanitized.firstAgentObservedAt;
  return sanitized;
}

export function reportLaunchProgressMutation(
  document: TodoDocument,
  input: Input<typeof reportLaunchProgress>,
  now: string,
): MutationOutcome<{ attempt: Attempt; claim?: LaunchClaim; autoMove?: AutoMove }> {
  const attempt = document.attempts[input.attemptId];
  if (!attempt) return error("not_found", "The attempt no longer exists.");
  if (attempt.claimGeneration !== input.generation) {
    return error("stale_launch", "This progress report belongs to a different claim generation.");
  }
  const joined = joinAttemptFacts({
    attempt,
    facet: input.facet,
    factVersion: input.factVersion,
    facts: sanitizeClientFacts(document, attempt, input.facts),
    now,
  });
  const claim = document.claims[attempt.workItemId];
  let nextClaim = claim;
  if (
    claim &&
    claim.attemptId === attempt.id &&
    claim.generation === attempt.claimGeneration &&
    claim.state === "pending"
  ) {
    const patch: Partial<LaunchClaim> = {};
    if (input.facts.clientInstanceId && !claim.initiatorClientInstanceId) {
      patch.initiatorClientInstanceId = input.facts.clientInstanceId;
    }
    if (
      input.facts.lastLaunchErrorCode !== undefined &&
      input.factVersion > (attempt.factVersions[input.facet] ?? 0) &&
      input.facts.lastLaunchErrorCode !== claim.lastErrorCode
    ) {
      patch.lastErrorCode = input.facts.lastLaunchErrorCode;
      if (input.facts.lastLaunchErrorMessage !== undefined) {
        patch.lastErrorMessage = input.facts.lastLaunchErrorMessage;
      }
    }
    if (Object.keys(patch).length > 0) nextClaim = { ...claim, ...patch, updatedAt: now };
  }
  if (!joined.changed && nextClaim === claim) {
    return { status: "unchanged", result: { attempt, ...(claim ? { claim } : {}) } };
  }
  // The first request-start of the current launch moves the card; later milestones do not.
  const requestStarted = (entry: Attempt) => Boolean(entry.workspaceRequestStartedAt || entry.agentRequestStartedAt);
  const item = document.workItems[attempt.workItemId];
  const currentLaunch = claim?.attemptId === attempt.id && claim.generation === attempt.claimGeneration;
  const autoMove =
    item && currentLaunch && !requestStarted(attempt) && requestStarted(joined.attempt)
      ? deriveAutoMove(item.status, { kind: "launch_started" })
      : null;
  const workItems =
    item && autoMove
      ? { ...document.workItems, [item.id]: withStatus(item, autoMove.to, autoMove.reason, now) }
      : document.workItems;
  return {
    status: "commit",
    values: {
      ...document,
      workItems,
      attempts: { ...document.attempts, [attempt.id]: joined.attempt },
      ...(nextClaim && nextClaim !== claim
        ? { claims: { ...document.claims, [attempt.workItemId]: nextClaim } }
        : {}),
    },
    result: {
      attempt: joined.attempt,
      ...(nextClaim ? { claim: nextClaim } : {}),
      ...(autoMove ? { autoMove } : {}),
    },
    kind: "recovery",
  };
}

export function abandonLaunchMutation(
  document: TodoDocument,
  input: Input<typeof abandonLaunch>,
  now: string,
): MutationOutcome<{ attempt: Attempt; claim?: LaunchClaim }> {
  const attempt = document.attempts[input.attemptId];
  if (!attempt || attempt.workItemId !== input.workItemId) {
    return error("not_found", "The attempt no longer exists.");
  }
  if (attempt.claimGeneration !== input.generation) {
    return error("stale_launch", "This abandon request belongs to a different claim generation.");
  }
  if (input.certainty === "not_submitted" && !isAttemptNotSubmitted(attempt)) {
    return error(
      "invalid_transition",
      "A request was already sent for this attempt. Confirm the unknown outcome instead.",
    );
  }
  const joined = abandonAttempt(attempt, now);
  const claim = document.claims[attempt.workItemId];
  let nextClaim = claim;
  if (
    claim &&
    claim.attemptId === attempt.id &&
    claim.generation === attempt.claimGeneration &&
    claim.state === "pending"
  ) {
    nextClaim = { ...claim, state: "abandoned", updatedAt: now };
  }
  if (!joined.changed && nextClaim === claim) {
    return { status: "unchanged", result: { attempt, ...(claim ? { claim } : {}) } };
  }
  return {
    status: "commit",
    values: {
      ...document,
      attempts: { ...document.attempts, [attempt.id]: joined.attempt },
      ...(nextClaim && nextClaim !== claim
        ? { claims: { ...document.claims, [attempt.workItemId]: nextClaim } }
        : {}),
    },
    result: { attempt: joined.attempt, ...(nextClaim ? { claim: nextClaim } : {}) },
    kind: "recovery",
  };
}

/**
 * Removes one finished attempt and its agent links. Only history is dropped: the agents and
 * workspaces themselves are untouched, and a late agent for a forgotten attempt no longer
 * correlates, so it is ignored instead of resurrecting the record.
 */
export function forgetAttemptMutation(
  document: TodoDocument,
  input: Input<typeof forgetAttempt>,
  _now: string,
): MutationOutcome<{ removedAgentIds: string[] }> {
  const attempt = document.attempts[input.attemptId];
  if (!attempt || attempt.workItemId !== input.workItemId) {
    return error("not_found", "The attempt no longer exists.");
  }
  if (!isAttemptSettled(attempt)) {
    return error(
      "invalid_transition",
      "This attempt is still open. Abandon it before removing it from the history.",
      { attemptId: attempt.id, reason: "unsettled_attempt" },
    );
  }
  const claim = document.claims[attempt.workItemId];
  if (claim && claim.attemptId === attempt.id && claim.state === "pending") {
    return error("claim_held", "This attempt still holds the pending launch.");
  }
  const links = linksForWorkItem(document, attempt.workItemId).filter(
    (link) => link.attemptId === attempt.id,
  );
  const active = links.find((link) => isActiveDisplayState(link.displayState));
  if (active) {
    return error("active_agent", "A linked agent is still active.", { agentId: active.agentId });
  }
  const attempts = { ...document.attempts };
  delete attempts[attempt.id];
  const agentLinks = { ...document.agentLinks };
  for (const link of links) delete agentLinks[link.agentId];
  // The claim record is left in place: it carries the generation counter that keeps later attempt
  // IDs distinguishable, and a claim pointing at a forgotten attempt is only ever read as history.
  return {
    status: "commit",
    values: { ...document, attempts, agentLinks },
    result: { removedAgentIds: links.map((link) => link.agentId) },
    kind: "recovery",
  };
}
