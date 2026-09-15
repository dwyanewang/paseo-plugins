import { fingerprintOf } from "../shared/fingerprint";
import { parseTodoLabels } from "../shared/labels";
import type { AutoMove } from "../shared/board";
import type { AgentLink, Attempt, LaunchClaim, TodoDocument } from "../shared/schema";
import {
  deriveDisplayState,
  isActiveDisplayState,
  type RawAgentStatus,
  type RawAttentionReason,
} from "../shared/state";
import { withAgentAutoMove } from "./mutations";
import type { MutationOutcome } from "./store";

/** Canonical, null-folded projection of one agent snapshot. Heartbeat timestamps are excluded. */
export interface CanonicalAgentProjection {
  agentId: string;
  labels: Readonly<Record<string, string>>;
  status: RawAgentStatus;
  pendingPermissionCount: number;
  requiresAttention: boolean;
  attentionReason: RawAttentionReason;
  providerUnavailable: boolean;
  archivedAt?: string;
  provider: string;
  model?: string;
  modeId?: string;
  thinkingOptionId?: string;
  workspaceId?: string;
  /** Verified placement, or undefined when it could not be resolved yet. */
  projectId?: string;
  updatedAt: string;
}

export function canonicalizeAgentSnapshot(input: {
  agent: {
    id: string;
    labels?: Record<string, string> | null;
    status: RawAgentStatus;
    pendingPermissions?: readonly unknown[] | null;
    requiresAttention?: boolean | null;
    attentionReason?: RawAttentionReason | undefined;
    providerUnavailable?: boolean | null;
    archivedAt?: string | null;
    provider: string;
    model?: string | null;
    currentModeId?: string | null;
    thinkingOptionId?: string | null;
    workspaceId?: string | null;
    updatedAt: string;
  };
  projectId?: string | null;
}): CanonicalAgentProjection {
  const { agent } = input;
  const projection: CanonicalAgentProjection = {
    agentId: agent.id,
    labels: agent.labels ?? {},
    status: agent.status,
    pendingPermissionCount: agent.pendingPermissions?.length ?? 0,
    requiresAttention: agent.requiresAttention ?? false,
    attentionReason: agent.attentionReason ?? null,
    providerUnavailable: agent.providerUnavailable ?? false,
    provider: agent.provider,
    updatedAt: agent.updatedAt,
  };
  if (agent.archivedAt) projection.archivedAt = agent.archivedAt;
  if (agent.model) projection.model = agent.model;
  if (agent.currentModeId) projection.modeId = agent.currentModeId;
  if (agent.thinkingOptionId) projection.thinkingOptionId = agent.thinkingOptionId;
  if (agent.workspaceId) projection.workspaceId = agent.workspaceId;
  if (input.projectId) projection.projectId = input.projectId;
  return projection;
}

/** In-memory watermark identity: excludes updatedAt so equal content at a new time is a no-op. */
export function projectionFingerprint(projection: CanonicalAgentProjection): string {
  const { updatedAt: _updatedAt, agentId: _agentId, ...rest } = projection;
  return fingerprintOf(rest);
}

export type ApplyRejection =
  | "no_correlation"
  | "unknown_attempt"
  | "mismatched_attempt"
  | "unknown_work_item"
  | "unverified_placement"
  | "mismatched_placement"
  | "projection_deferred";

export interface ApplyResult {
  linked: boolean;
  projectionChanged: boolean;
  claimResolved: boolean;
  rejection?: ApplyRejection;
  link?: AgentLink;
  /** Board move folded into this write by an agent starting or finishing. */
  autoMove?: AutoMove;
}

function projectionPatch(
  link: AgentLink,
  projection: CanonicalAgentProjection,
  promptObserved: boolean,
  now: string,
): { link: AgentLink; changed: boolean } {
  const displayState = deriveDisplayState({
    status: projection.status,
    pendingPermissionCount: projection.pendingPermissionCount,
    requiresAttention: projection.requiresAttention,
    attentionReason: projection.attentionReason,
    providerUnavailable: projection.providerUnavailable,
    archived: Boolean(projection.archivedAt),
  });
  const next: AgentLink = {
    ...link,
    provider: projection.provider,
    displayState,
    rawStatus: projection.status,
    promptDelivery: link.promptDelivery === "observed" || promptObserved ? "observed" : link.promptDelivery,
  };
  if (projection.attentionReason) next.rawAttentionReason = projection.attentionReason;
  else delete next.rawAttentionReason;
  if (projection.providerUnavailable) next.providerUnavailable = true;
  else delete next.providerUnavailable;
  if (projection.model) next.model = projection.model;
  else delete next.model;
  if (projection.modeId) next.modeId = projection.modeId;
  else delete next.modeId;
  if (projection.thinkingOptionId) next.thinkingOptionId = projection.thinkingOptionId;
  else delete next.thinkingOptionId;
  if (projection.workspaceId && !next.workspaceId) next.workspaceId = projection.workspaceId;
  if (projection.projectId && !next.observedProjectId) next.observedProjectId = projection.projectId;
  if (projection.archivedAt) next.archivedAt = projection.archivedAt;
  else delete next.archivedAt;
  delete next.staleSince;
  delete next.lastRefreshErrorCode;
  if (displayState !== link.displayState) next.stateChangedAt = now;
  const changed = fingerprintOf(next) !== fingerprintOf(link);
  return { link: changed ? next : link, changed };
}

function resolveClaim(
  document: TodoDocument,
  attempt: Attempt,
  agentId: string,
  now: string,
): LaunchClaim | null {
  const claim = document.claims[attempt.workItemId];
  if (
    !claim ||
    claim.attemptId !== attempt.id ||
    claim.generation !== attempt.claimGeneration ||
    claim.state !== "pending"
  ) {
    return null;
  }
  return { ...claim, state: "resolved", resolvedAgentId: agentId, updatedAt: now };
}

/**
 * Applies one accepted snapshot. Correlation discovery (steps 1–4) runs before and independently
 * of the mutable projection gate: a dirty or superseded snapshot can still establish a link
 * (marked stale for a targeted re-verification) but never overwrites an existing projection.
 */
export function applyAgentSnapshotMutation(
  document: TodoDocument,
  input: {
    projection: CanonicalAgentProjection;
    /** False when the snapshot was superseded (dirty) while in flight. */
    allowProjection: boolean;
    promptObserved: boolean;
  },
  now: string,
): MutationOutcome<ApplyResult> {
  const { projection } = input;
  const existing = document.agentLinks[projection.agentId];
  if (existing) {
    if (!input.allowProjection) {
      return {
        status: "unchanged",
        result: {
          linked: false,
          projectionChanged: false,
          claimResolved: false,
          rejection: "projection_deferred",
          link: existing,
        },
      };
    }
    const { link, changed } = projectionPatch(existing, projection, input.promptObserved, now);
    const attempt = document.attempts[link.attemptId];
    const claim = attempt ? resolveClaim(document, attempt, link.agentId, now) : null;
    if (!changed && !claim) {
      return {
        status: "unchanged",
        result: { linked: false, projectionChanged: false, claimResolved: false, link },
      };
    }
    const moved = withAgentAutoMove(
      document,
      {
        ...document,
        agentLinks: { ...document.agentLinks, [link.agentId]: link },
        ...(claim ? { claims: { ...document.claims, [claim.workItemId]: claim } } : {}),
      },
      {
        workItemId: link.workItemId,
        agentFinished: isActiveDisplayState(existing.displayState) && !isActiveDisplayState(link.displayState),
      },
      now,
    );
    return {
      status: "commit",
      values: moved.document,
      result: {
        linked: false,
        projectionChanged: changed,
        claimResolved: Boolean(claim),
        link,
        ...(moved.autoMove ? { autoMove: moved.autoMove } : {}),
      },
      kind: "recovery",
    };
  }

  const rejection = (why: ApplyRejection): MutationOutcome<ApplyResult> => ({
    status: "unchanged",
    result: { linked: false, projectionChanged: false, claimResolved: false, rejection: why },
  });
  const correlation = parseTodoLabels(projection.labels);
  if (!correlation) return rejection("no_correlation");
  const attempt = document.attempts[correlation.attemptId];
  if (!attempt) return rejection("unknown_attempt");
  if (attempt.workItemId !== correlation.workItemId) return rejection("mismatched_attempt");
  const workItem = document.workItems[attempt.workItemId];
  if (!workItem) return rejection("unknown_work_item");
  if (!projection.projectId) return rejection("unverified_placement");
  if (projection.projectId !== workItem.projectId && projection.projectId !== attempt.projectIdSnapshot) {
    return rejection("mismatched_placement");
  }

  const seed: AgentLink = {
    agentId: projection.agentId,
    attemptId: attempt.id,
    workItemId: workItem.id,
    provider: projection.provider,
    displayState: "initializing",
    promptDelivery: attempt.agentRequestStartedAt || attempt.firstAgentObservedAt ? "unknown" : "unknown",
    firstObservedAt: now,
    stateChangedAt: now,
  };
  const { link: projected } = projectionPatch(seed, projection, input.promptObserved, now);
  const link: AgentLink = input.allowProjection
    ? projected
    : { ...projected, staleSince: now, lastRefreshErrorCode: "superseded_snapshot" };

  const nextAttempt: Attempt = {
    ...attempt,
    firstAgentObservedAt: attempt.firstAgentObservedAt ?? now,
    ...(projection.workspaceId
      ? {
          workspaceIdHint: attempt.workspaceIdHint ?? projection.workspaceId,
          workspaceObservedAt: attempt.workspaceObservedAt ?? now,
        }
      : {}),
    updatedAt: now,
  };
  const claim = resolveClaim(document, attempt, link.agentId, now);
  // A new link seen already idle counts as finished: its whole run may have happened unobserved.
  const moved = withAgentAutoMove(
    document,
    {
      ...document,
      agentLinks: { ...document.agentLinks, [link.agentId]: link },
      attempts: { ...document.attempts, [attempt.id]: nextAttempt },
      ...(claim ? { claims: { ...document.claims, [claim.workItemId]: claim } } : {}),
    },
    { workItemId: workItem.id, agentFinished: !isActiveDisplayState(link.displayState) },
    now,
  );
  return {
    status: "commit",
    values: moved.document,
    result: {
      linked: true,
      projectionChanged: true,
      claimResolved: Boolean(claim),
      link,
      ...(moved.autoMove ? { autoMove: moved.autoMove } : {}),
    },
    kind: "recovery",
  };
}

/** Any refresh rejection keeps the last projection and adds a stale overlay (set-once). */
export function markAgentLinkStaleMutation(
  document: TodoDocument,
  input: { agentId: string; errorCode: string },
  now: string,
): MutationOutcome<{ link: AgentLink | null }> {
  const link = document.agentLinks[input.agentId];
  if (!link) return { status: "unchanged", result: { link: null } };
  if (link.staleSince && link.lastRefreshErrorCode === input.errorCode) {
    return { status: "unchanged", result: { link } };
  }
  const next: AgentLink = {
    ...link,
    staleSince: link.staleSince ?? now,
    lastRefreshErrorCode: input.errorCode,
  };
  return {
    status: "commit",
    values: { ...document, agentLinks: { ...document.agentLinks, [link.agentId]: next } },
    result: { link: next },
    kind: "recovery",
  };
}

/** Prompt delivery flips to observed at most once; unknown is never downgraded. */
export function markPromptObservedMutation(
  document: TodoDocument,
  input: { agentId: string },
): MutationOutcome<{ link: AgentLink | null }> {
  const link = document.agentLinks[input.agentId];
  if (!link) return { status: "unchanged", result: { link: null } };
  if (link.promptDelivery === "observed") return { status: "unchanged", result: { link } };
  const next: AgentLink = { ...link, promptDelivery: "observed" };
  return {
    status: "commit",
    values: { ...document, agentLinks: { ...document.agentLinks, [link.agentId]: next } },
    result: { link: next },
    kind: "recovery",
  };
}
