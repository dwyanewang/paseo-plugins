import { isAttemptOutcomeUnknown, isAttemptSettled } from "./attempt";
import type { AgentLink, Attempt, LaunchClaim, TodoAgentDisplayState, WorkItem } from "./schema";

/**
 * Canonical agent state. `@getpaseo/protocol` is not a plugin client module, so this mirrors
 * `deriveAgentStateBucket` from packages/protocol/src/agent-state-bucket.ts exactly; the shared
 * fixtures in test/state.test.ts keep the two from drifting.
 */
export type CanonicalBucket = "needs_input" | "failed" | "running" | "attention" | "done";
export type RawAgentStatus = "initializing" | "idle" | "running" | "error" | "closed";
export type RawAttentionReason = "finished" | "error" | "permission" | null;

export interface AgentStateInput {
  status: RawAgentStatus;
  pendingPermissionCount: number;
  requiresAttention: boolean;
  attentionReason: RawAttentionReason;
  providerUnavailable: boolean;
  archived: boolean;
}

export function deriveCanonicalBucket(input: {
  status: RawAgentStatus;
  pendingPermissionCount?: number;
  requiresAttention?: boolean;
  attentionReason?: RawAttentionReason | undefined;
}): CanonicalBucket {
  if ((input.pendingPermissionCount ?? 0) > 0 || input.attentionReason === "permission") {
    return "needs_input";
  }
  if (input.status === "error" || input.attentionReason === "error") return "failed";
  if (input.status === "running") return "running";
  if (input.requiresAttention) return "attention";
  return "done";
}

/**
 * Todo display state. Steps 1–4 follow canonical precedence; only canonical `done` is refined
 * into the Todo-specific initializing/unavailable/closed/waiting_confirmation projection.
 */
export function deriveDisplayState(input: AgentStateInput): TodoAgentDisplayState {
  const bucket = deriveCanonicalBucket(input);
  switch (bucket) {
    case "needs_input":
      return "permission";
    case "failed":
      return "error";
    case "running":
      return "running";
    case "attention":
      return "waiting_confirmation";
    case "done":
      if (input.status === "initializing") return "initializing";
      if (input.providerUnavailable) return "unavailable";
      if (input.archived || input.status === "closed") return "closed";
      return "waiting_confirmation";
  }
}

const ACTIVE_STATES: ReadonlySet<TodoAgentDisplayState> = new Set([
  "initializing",
  "running",
  "permission",
]);

export function isActiveDisplayState(state: TodoAgentDisplayState): boolean {
  return ACTIVE_STATES.has(state);
}

/** Aggregate state of one work item, in priority order (plan §12). */
export type WorkItemAggregateState =
  | "permission"
  | "error"
  | "running"
  | "pending_launch"
  | "outcome_unknown"
  | "stale"
  | "waiting_confirmation"
  | "closed"
  | "idle";

export interface WorkItemAggregate {
  state: WorkItemAggregateState;
  /** Why a new attempt is currently refused, or null when execution is allowed. */
  blockedReason: "claim_held" | "active_agent" | "stale_agent" | null;
  activeAgentIds: string[];
  staleAgentIds: string[];
  unknownAttemptIds: string[];
  duplicateAttemptIds: string[];
  pendingClaim: LaunchClaim | null;
}

export function aggregateWorkItem(input: {
  item: WorkItem;
  claim: LaunchClaim | undefined;
  attempts: readonly Attempt[];
  links: readonly AgentLink[];
}): WorkItemAggregate {
  const pendingClaim = input.claim?.state === "pending" ? input.claim : null;
  const activeAgentIds: string[] = [];
  const staleAgentIds: string[] = [];
  let permission = false;
  let error = false;
  let running = false;
  let waiting = false;
  let closed = false;
  for (const link of input.links) {
    if (link.staleSince) {
      staleAgentIds.push(link.agentId);
      if (isActiveDisplayState(link.displayState)) activeAgentIds.push(link.agentId);
      continue;
    }
    switch (link.displayState) {
      case "permission":
        permission = true;
        activeAgentIds.push(link.agentId);
        break;
      case "error":
        error = true;
        break;
      case "initializing":
      case "running":
        running = true;
        activeAgentIds.push(link.agentId);
        break;
      case "waiting_confirmation":
        waiting = true;
        break;
      case "closed":
      case "unavailable":
        closed = true;
        break;
    }
  }
  const unknownAttemptIds = input.attempts
    .filter((attempt) => !isAttemptSettled(attempt) && isAttemptOutcomeUnknown(attempt))
    .map((attempt) => attempt.id);
  const linksByAttempt = new Map<string, number>();
  for (const link of input.links) {
    linksByAttempt.set(link.attemptId, (linksByAttempt.get(link.attemptId) ?? 0) + 1);
  }
  const duplicateAttemptIds = [...linksByAttempt.entries()]
    .filter(([, count]) => count > 1)
    .map(([attemptId]) => attemptId);

  let state: WorkItemAggregateState = "idle";
  if (permission) state = "permission";
  else if (error) state = "error";
  else if (running) state = "running";
  else if (pendingClaim && unknownAttemptIds.length === 0) state = "pending_launch";
  else if (unknownAttemptIds.length > 0) state = "outcome_unknown";
  else if (staleAgentIds.length > 0) state = "stale";
  else if (waiting) state = "waiting_confirmation";
  else if (closed) state = "closed";

  const staleActive = input.links.some(
    (link) => link.staleSince && isActiveDisplayState(link.displayState),
  );
  const liveActive = input.links.some(
    (link) => !link.staleSince && isActiveDisplayState(link.displayState),
  );
  const blockedReason = pendingClaim
    ? "claim_held"
    : liveActive
      ? "active_agent"
      : staleActive
        ? "stale_agent"
        : null;

  return {
    state,
    blockedReason,
    activeAgentIds,
    staleAgentIds,
    unknownAttemptIds,
    duplicateAttemptIds,
    pendingClaim,
  };
}
