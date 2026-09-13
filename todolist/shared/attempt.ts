import type { Attempt, AttemptFact } from "./schema";

/**
 * Facts reported through `launch.progress`. Every field is optional; the join below is a
 * field-level lattice, so a later or weaker report can never clear an earlier observation.
 */
export interface AttemptFacts {
  clientInstanceId?: string;
  journalPreparedAt?: string;
  workspaceRequestStartedAt?: string;
  workspaceOutcomeUnknownObservedAt?: string;
  workspaceIdHint?: string;
  workspaceObservedAt?: string;
  agentRequestStartedAt?: string;
  agentOutcomeUnknownObservedAt?: string;
  firstAgentObservedAt?: string;
  lastLaunchErrorCode?: string;
  lastLaunchErrorMessage?: string;
}

const SET_ONCE_TIMESTAMPS = [
  "journalPreparedAt",
  "workspaceRequestStartedAt",
  "workspaceOutcomeUnknownObservedAt",
  "workspaceObservedAt",
  "agentRequestStartedAt",
  "agentOutcomeUnknownObservedAt",
  "firstAgentObservedAt",
] as const satisfies readonly (keyof AttemptFacts & keyof Attempt)[];

function earliest(current: string | undefined, incoming: string | undefined): string | undefined {
  if (!incoming) return current;
  if (!current) return incoming;
  return incoming < current ? incoming : current;
}

export interface JoinResult {
  attempt: Attempt;
  changed: boolean;
}

/**
 * Joins one facet report into the attempt. Timestamps are set-once (earliest wins), identity
 * hints are set-once, and only diagnostics move forward with a higher fact version. The facet
 * version itself only ever increases.
 */
export function joinAttemptFacts(input: {
  attempt: Attempt;
  facet: AttemptFact;
  factVersion: number;
  facts: AttemptFacts;
  now: string;
}): JoinResult {
  const { attempt, facts } = input;
  const next: Attempt = { ...attempt, factVersions: { ...attempt.factVersions } };
  let changed = false;

  for (const key of SET_ONCE_TIMESTAMPS) {
    const merged = earliest(attempt[key], facts[key]);
    if (merged !== attempt[key]) {
      next[key] = merged;
      changed = true;
    }
  }
  if (facts.workspaceIdHint && !attempt.workspaceIdHint) {
    next.workspaceIdHint = facts.workspaceIdHint;
    changed = true;
  }
  if (facts.clientInstanceId && !attempt.initiatorClientInstanceId) {
    next.initiatorClientInstanceId = facts.clientInstanceId;
    changed = true;
  }

  const currentVersion = attempt.factVersions[input.facet] ?? 0;
  if (input.factVersion > currentVersion) {
    next.factVersions[input.facet] = input.factVersion;
    changed = true;
    if (facts.lastLaunchErrorCode !== undefined && facts.lastLaunchErrorCode !== attempt.lastLaunchErrorCode) {
      next.lastLaunchErrorCode = facts.lastLaunchErrorCode;
    }
    if (
      facts.lastLaunchErrorMessage !== undefined &&
      facts.lastLaunchErrorMessage !== attempt.lastLaunchErrorMessage
    ) {
      next.lastLaunchErrorMessage = facts.lastLaunchErrorMessage;
    }
  }

  if (!changed) return { attempt, changed: false };
  next.updatedAt = input.now;
  return { attempt: next, changed: true };
}

/** User abandonment is an independent, irreversible fact. */
export function abandonAttempt(attempt: Attempt, now: string): JoinResult {
  if (attempt.userDisposition === "abandoned") return { attempt, changed: false };
  return {
    attempt: { ...attempt, userDisposition: "abandoned", abandonedAt: now, updatedAt: now },
    changed: true,
  };
}

/** Certainty per stage looks only at that stage's own request-start milestone. */
export function stageCertainty(attempt: Attempt, stage: "workspace" | "agent") {
  const started =
    stage === "workspace" ? attempt.workspaceRequestStartedAt : attempt.agentRequestStartedAt;
  const known = stage === "workspace" ? attempt.workspaceObservedAt : attempt.firstAgentObservedAt;
  const unknownObserved =
    stage === "workspace"
      ? attempt.workspaceOutcomeUnknownObservedAt
      : attempt.agentOutcomeUnknownObservedAt;
  if (known) return "known" as const;
  if (!started) return "not_submitted" as const;
  if (unknownObserved) return "outcome_unknown" as const;
  return "in_flight" as const;
}

/** Derived: a request started, a negative result was observed, and no stronger observation exists. */
export function isAttemptOutcomeUnknown(attempt: Attempt): boolean {
  return (
    stageCertainty(attempt, "workspace") === "outcome_unknown" ||
    stageCertainty(attempt, "agent") === "outcome_unknown"
  );
}

/** True when nothing was ever sent for this attempt, so it can be abandoned safely. */
export function isAttemptNotSubmitted(attempt: Attempt): boolean {
  return (
    !attempt.workspaceRequestStartedAt &&
    !attempt.agentRequestStartedAt &&
    !attempt.workspaceObservedAt &&
    !attempt.firstAgentObservedAt
  );
}

/** An attempt is settled when the user abandoned it or an agent was observed for it. */
export function isAttemptSettled(attempt: Attempt): boolean {
  return attempt.userDisposition === "abandoned" || Boolean(attempt.firstAgentObservedAt);
}
