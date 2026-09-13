import { describe, expect, it } from "vitest";
import { deriveAgentStateBucket } from "@getpaseo/protocol/agent-state-bucket";
import { abandonAttempt, isAttemptOutcomeUnknown, joinAttemptFacts, stageCertainty } from "../shared/attempt";
import type { AgentLink, Attempt, WorkItem } from "../shared/schema";
import { aggregateWorkItem, deriveCanonicalBucket, deriveDisplayState, type AgentStateInput } from "../shared/state";
import { computeCreationFingerprint, computeRequestFingerprint } from "../shared/fingerprint";
import { evaluateCapacity, utf8ByteLength, validateWorkItemFields } from "../shared/limits";
import { rankBetween, rankFromInteger } from "../shared/rank";
import { NOW } from "./helpers/setup";

/** Shared fixtures: every combination the plan calls out, plus precedence collisions. */
const FIXTURES: Array<{ name: string; input: AgentStateInput; display: string }> = [
  { name: "closed+permission", input: { status: "closed", pendingPermissionCount: 1, requiresAttention: false, attentionReason: null, providerUnavailable: false, archived: false }, display: "permission" },
  { name: "closed+error", input: { status: "closed", pendingPermissionCount: 0, requiresAttention: true, attentionReason: "error", providerUnavailable: false, archived: false }, display: "error" },
  { name: "running+attention", input: { status: "running", pendingPermissionCount: 0, requiresAttention: true, attentionReason: "finished", providerUnavailable: false, archived: false }, display: "running" },
  { name: "initializing+attention", input: { status: "initializing", pendingPermissionCount: 0, requiresAttention: true, attentionReason: "finished", providerUnavailable: false, archived: false }, display: "waiting_confirmation" },
  { name: "initializing", input: { status: "initializing", pendingPermissionCount: 0, requiresAttention: false, attentionReason: null, providerUnavailable: false, archived: false }, display: "initializing" },
  { name: "idle unavailable", input: { status: "idle", pendingPermissionCount: 0, requiresAttention: false, attentionReason: null, providerUnavailable: true, archived: false }, display: "unavailable" },
  { name: "idle archived", input: { status: "idle", pendingPermissionCount: 0, requiresAttention: false, attentionReason: null, providerUnavailable: false, archived: true }, display: "closed" },
  { name: "closed", input: { status: "closed", pendingPermissionCount: 0, requiresAttention: false, attentionReason: null, providerUnavailable: false, archived: false }, display: "closed" },
  { name: "idle", input: { status: "idle", pendingPermissionCount: 0, requiresAttention: false, attentionReason: null, providerUnavailable: false, archived: false }, display: "waiting_confirmation" },
  { name: "error status", input: { status: "error", pendingPermissionCount: 0, requiresAttention: false, attentionReason: null, providerUnavailable: false, archived: false }, display: "error" },
  { name: "permission reason", input: { status: "idle", pendingPermissionCount: 0, requiresAttention: true, attentionReason: "permission", providerUnavailable: false, archived: false }, display: "permission" },
];

describe("canonical state mirror", () => {
  for (const fixture of FIXTURES) {
    it(`matches main precedence for ${fixture.name}`, () => {
      const canonical = deriveAgentStateBucket({
        status: fixture.input.status,
        pendingPermissionCount: fixture.input.pendingPermissionCount,
        requiresAttention: fixture.input.requiresAttention,
        attentionReason: fixture.input.attentionReason,
      });
      expect(deriveCanonicalBucket(fixture.input)).toBe(canonical);
      expect(deriveDisplayState(fixture.input)).toBe(fixture.display);
    });
  }
});

function item(): WorkItem {
  return { id: "wi-1", creationFingerprint: "f", version: 1, projectId: "p", projectNameSnapshot: "P", title: "T", details: "", defaultPrompt: "", status: "open", rank: rankFromInteger(1), createdAt: NOW, updatedAt: NOW };
}
function attempt(overrides: Partial<Attempt> = {}): Attempt {
  return { id: "att-1", workItemId: "wi-1", claimGeneration: 1, requestFingerprint: "fp", projectIdSnapshot: "p", projectNameSnapshot: "P", titleSnapshot: "T", seedPromptSnapshot: "s", seedPromptSource: "work-item-default", clientMessageId: "m", initiatorLabel: "d", factVersions: {}, userDisposition: "active", createdAt: NOW, updatedAt: NOW, ...overrides };
}
function link(overrides: Partial<AgentLink> = {}): AgentLink {
  return { agentId: "a", attemptId: "att-1", workItemId: "wi-1", provider: "codex", displayState: "running", promptDelivery: "unknown", firstObservedAt: NOW, stateChangedAt: NOW, ...overrides };
}

describe("aggregation", () => {
  it("follows permission > error > running > pending > unknown > stale > waiting > closed", () => {
    const base = { item: item(), claim: undefined, attempts: [] as Attempt[], links: [] as AgentLink[] };
    expect(aggregateWorkItem(base).state).toBe("idle");
    expect(aggregateWorkItem({ ...base, links: [link({ displayState: "closed" }), link({ agentId: "b", displayState: "waiting_confirmation" })] }).state).toBe("waiting_confirmation");
    expect(aggregateWorkItem({ ...base, links: [link({ displayState: "waiting_confirmation" }), link({ agentId: "b", displayState: "closed", staleSince: NOW })] }).state).toBe("stale");
    const unknown = attempt({ agentRequestStartedAt: NOW, agentOutcomeUnknownObservedAt: NOW });
    expect(aggregateWorkItem({ ...base, attempts: [unknown], links: [link({ displayState: "closed", staleSince: NOW })] }).state).toBe("outcome_unknown");
    const pending = { workItemId: "wi-1", attemptId: "att-1", generation: 1, state: "pending" as const, initiatorLabel: "d", createdAt: NOW, updatedAt: NOW };
    expect(aggregateWorkItem({ ...base, claim: pending, attempts: [attempt()] }).state).toBe("pending_launch");
    expect(aggregateWorkItem({ ...base, claim: pending, attempts: [unknown] }).state).toBe("outcome_unknown");
    expect(aggregateWorkItem({ ...base, claim: pending, attempts: [unknown], links: [link({ displayState: "running" })] }).state).toBe("running");
    expect(aggregateWorkItem({ ...base, links: [link({ displayState: "running" }), link({ agentId: "b", displayState: "error" })] }).state).toBe("error");
    expect(aggregateWorkItem({ ...base, links: [link({ displayState: "error" }), link({ agentId: "b", displayState: "permission" })] }).state).toBe("permission");
  });

  it("known observation overrides unknown, abandoned stays, duplicates are reported", () => {
    const known = attempt({ agentRequestStartedAt: NOW, agentOutcomeUnknownObservedAt: NOW, firstAgentObservedAt: NOW });
    expect(isAttemptOutcomeUnknown(known)).toBe(false);
    expect(stageCertainty(known, "agent")).toBe("known");
    expect(stageCertainty(attempt({ workspaceRequestStartedAt: NOW }), "workspace")).toBe("in_flight");
    expect(stageCertainty(attempt({ workspaceObservedAt: NOW }), "agent")).toBe("not_submitted");
    const abandoned = abandonAttempt(known, NOW).attempt;
    expect(abandonAttempt(abandoned, NOW).changed).toBe(false);
    const aggregate = aggregateWorkItem({ item: item(), claim: undefined, attempts: [abandoned], links: [link(), link({ agentId: "b" })] });
    expect(aggregate.duplicateAttemptIds).toEqual(["att-1"]);
    expect(aggregate.blockedReason).toBe("active_agent");
  });

  it("joins timestamps as earliest-wins and diagnostics by version", () => {
    const first = joinAttemptFacts({ attempt: attempt(), facet: "agent-request", factVersion: 2, facts: { agentRequestStartedAt: "2026-09-11T10:00:05.000Z", lastLaunchErrorCode: "b" }, now: NOW });
    const second = joinAttemptFacts({ attempt: first.attempt, facet: "agent-request", factVersion: 1, facts: { agentRequestStartedAt: "2026-09-11T10:00:01.000Z", lastLaunchErrorCode: "a" }, now: NOW });
    expect(second.attempt.agentRequestStartedAt).toBe("2026-09-11T10:00:01.000Z");
    expect(second.attempt.lastLaunchErrorCode).toBe("b");
    expect(second.attempt.factVersions["agent-request"]).toBe(2);
  });
});

describe("helpers", () => {
  it("fingerprints are deterministic and input-sensitive", () => {
    const base = { projectId: "p", workItemId: "w", attemptId: "a", clientMessageId: "m", labels: { x: "1", y: "2" }, seedPrompt: "s" };
    expect(computeRequestFingerprint(base)).toBe(computeRequestFingerprint({ ...base, labels: { y: "2", x: "1" } }));
    expect(computeRequestFingerprint(base)).not.toBe(computeRequestFingerprint({ ...base, seedPrompt: "t" }));
    const creation = { id: "w", projectId: "p", title: "t", details: "d", defaultPrompt: "p" };
    expect(computeCreationFingerprint(creation)).toBe(computeCreationFingerprint({ ...creation }));
  });

  it("limits use UTF-8 bytes and code points", () => {
    expect(utf8ByteLength("héllo 😀")).toBe(Buffer.byteLength("héllo 😀"));
    expect(validateWorkItemFields({ title: "😀".repeat(200) })).toBeNull();
    expect(validateWorkItemFields({ details: "é".repeat(16 * 1024 + 1) })).toMatchObject({ field: "details" });
    expect(evaluateCapacity({ beforeBytes: 10, afterBytes: 10, kind: "user", limits: { softLimitBytes: 5, recoveryReserveBytes: 1, absoluteLimitBytes: 8 } })).toMatchObject({ allowed: false, tier: "absolute" });
    expect(evaluateCapacity({ beforeBytes: 10, afterBytes: 9, kind: "user", limits: { softLimitBytes: 5, recoveryReserveBytes: 1, absoluteLimitBytes: 8 } })).toMatchObject({ allowed: true });
  });

  it("ranks leave gaps and report exhaustion", () => {
    expect(rankBetween(undefined, undefined)).toBe(rankFromInteger(1_000_000));
    expect(rankBetween(rankFromInteger(10), rankFromInteger(11))).toBeNull();
    expect(rankBetween(rankFromInteger(10), rankFromInteger(20))).toBe(rankFromInteger(15));
    expect(rankBetween(undefined, rankFromInteger(1))).toBeNull();
  });
});
