import { describe, expect, it } from "vitest";
import {
  abandonLaunchMutation,
  acquireLaunchMutation,
  createWorkItemMutation,
  forgetAttemptMutation,
  purgeWorkItemMutation,
  rebindWorkItemProjectMutation,
  reorderWorkItemMutation,
  reportLaunchProgressMutation,
  setWorkItemArchivedMutation,
  setWorkItemStatusMutation,
  updateWorkItemMutation,
  projectItems,
} from "../server/mutations";
import { applyAgentSnapshotMutation, canonicalizeAgentSnapshot } from "../server/apply";
import { RANK_STEP, rankFromInteger } from "../shared/rank";
import type { TodoDocument } from "../shared/schema";
import { buildTodoLabels } from "../shared/labels";
import { fakeAgent } from "./helpers/fake-paseo";
import { NOW, baseDocument, createInput, launchInput, withClaim, withWorkItem } from "./helpers/setup";

function commit<T>(outcome: { status: string; values?: TodoDocument; result?: T }): TodoDocument {
  if (outcome.status !== "commit" || !outcome.values) throw new Error(`expected commit, got ${outcome.status}`);
  return outcome.values;
}

function linkAgent(document: TodoDocument, agentId: string, workItemId: string, attemptId: string, status: "running" | "idle" | "closed" = "running") {
  return commit(
    applyAgentSnapshotMutation(
      document,
      {
        projection: canonicalizeAgentSnapshot({
          agent: fakeAgent({ id: agentId, labels: buildTodoLabels(workItemId, attemptId), status, workspaceId: "wks-1" }),
          projectId: "project-1",
        }),
        allowProjection: true,
        promptObserved: false,
      },
      NOW,
    ),
  );
}

describe("work item create", () => {
  it("is idempotent for the same ID and fingerprint even after later edits", () => {
    const first = withWorkItem(baseDocument(), "wi-1");
    const edited = commit(
      updateWorkItemMutation(first, { expectedIncarnationId: "inc-1", id: "wi-1", expectedVersion: 1, patch: { title: "Renamed" } }, NOW),
    );
    const retry = createWorkItemMutation(edited, createInput("wi-1"), NOW);
    expect(retry.status).toBe("unchanged");
    if (retry.status === "unchanged") expect(retry.result.workItem.title).toBe("Renamed");
  });

  it("rejects a different fingerprint for the same ID and rejects retired IDs", () => {
    const document = withWorkItem(baseDocument(), "wi-1");
    expect(createWorkItemMutation(document, createInput("wi-1", "project-1", "Other"), NOW)).toMatchObject({
      status: "id_conflict",
    });
    const archived = commit(
      setWorkItemArchivedMutation(document, { expectedIncarnationId: "inc-1", id: "wi-1", expectedVersion: 1, archived: true }, NOW),
    );
    const purged = commit(
      purgeWorkItemMutation(archived, { expectedIncarnationId: "inc-1", id: "wi-1", expectedVersion: 2, confirm: true, force: false }, NOW),
    );
    expect(purged.retiredWorkItemIds).toHaveLength(1);
    expect(createWorkItemMutation(purged, createInput("wi-1"), NOW)).toMatchObject({ status: "retired_id" });
    expect(createWorkItemMutation(purged, createInput("wi-1", "project-1", "Other"), NOW)).toMatchObject({
      status: "id_conflict",
    });
  });

  it("validates field limits with stable codes", () => {
    const outcome = createWorkItemMutation(baseDocument(), { ...createInput("wi-x"), title: "   " }, NOW);
    expect(outcome).toMatchObject({ status: "invalid_input", details: { field: "title", reason: "empty" } });
    const long = createWorkItemMutation(baseDocument(), { ...createInput("wi-y"), title: "x".repeat(201) }, NOW);
    expect(long).toMatchObject({ status: "invalid_input", details: { field: "title", reason: "too_long" } });
  });

  it("appends at the end of the project order and bumps the project order version", () => {
    let document = withWorkItem(baseDocument(), "wi-1");
    document = withWorkItem(document, "wi-2");
    expect(projectItems(document, "project-1").map((item) => item.id)).toEqual(["wi-1", "wi-2"]);
    expect(document.projectOrderVersions["project-1"]).toBe(2);
  });
});

describe("versioned edits", () => {
  it("rejects a stale expectedVersion without overwriting the newer edit", () => {
    const document = withWorkItem(baseDocument(), "wi-1");
    const edited = commit(
      updateWorkItemMutation(document, { expectedIncarnationId: "inc-1", id: "wi-1", expectedVersion: 1, patch: { title: "New" } }, NOW),
    );
    const stale = updateWorkItemMutation(edited, { expectedIncarnationId: "inc-1", id: "wi-1", expectedVersion: 1, patch: { title: "Old" } }, NOW);
    expect(stale).toMatchObject({ status: "conflict", details: { currentVersion: 2 } });
    expect(edited.workItems["wi-1"]?.title).toBe("New");
  });

  it("status and archive transitions are versioned and idempotent", () => {
    const document = withWorkItem(baseDocument(), "wi-1");
    const done = commit(setWorkItemStatusMutation(document, { expectedIncarnationId: "inc-1", id: "wi-1", expectedVersion: 1, status: "done" }, NOW));
    expect(done.workItems["wi-1"]).toMatchObject({ status: "done", completedAt: NOW, version: 2 });
    expect(setWorkItemStatusMutation(done, { expectedIncarnationId: "inc-1", id: "wi-1", expectedVersion: 2, status: "done" }, NOW).status).toBe("unchanged");
    const reopened = commit(setWorkItemStatusMutation(done, { expectedIncarnationId: "inc-1", id: "wi-1", expectedVersion: 2, status: "open" }, NOW));
    expect(reopened.workItems["wi-1"]?.completedAt).toBeUndefined();
    const archived = commit(setWorkItemArchivedMutation(reopened, { expectedIncarnationId: "inc-1", id: "wi-1", expectedVersion: 3, archived: true }, NOW));
    expect(archived.workItems["wi-1"]?.archivedAt).toBe(NOW);
    const restored = commit(setWorkItemArchivedMutation(archived, { expectedIncarnationId: "inc-1", id: "wi-1", expectedVersion: 4, archived: false }, NOW));
    expect(restored.workItems["wi-1"]?.archivedAt).toBeUndefined();
  });
});

describe("reorder and rebind", () => {
  it("moves between neighbours and rejects a stale project order version", () => {
    let document = withWorkItem(baseDocument(), "wi-1");
    document = withWorkItem(document, "wi-2");
    document = withWorkItem(document, "wi-3");
    const moved = commit(
      reorderWorkItemMutation(document, {
        expectedIncarnationId: "inc-1",
        id: "wi-3",
        expectedVersion: 1,
        expectedProjectOrderVersion: 3,
        afterId: "wi-1",
      }, NOW),
    );
    expect(projectItems(moved, "project-1").map((item) => item.id)).toEqual(["wi-3", "wi-1", "wi-2"]);
    expect(moved.projectOrderVersions["project-1"]).toBe(4);
    expect(
      reorderWorkItemMutation(moved, {
        expectedIncarnationId: "inc-1",
        id: "wi-2",
        expectedVersion: 1,
        expectedProjectOrderVersion: 3,
        beforeId: "wi-3",
      }, NOW),
    ).toMatchObject({ status: "order_conflict", details: { currentProjectOrderVersion: 4 } });
  });

  it("rebalances the project when the rank gap is exhausted", () => {
    let document = withWorkItem(baseDocument(), "wi-1");
    document = withWorkItem(document, "wi-2");
    document = withWorkItem(document, "wi-3");
    document = {
      ...document,
      workItems: {
        ...document.workItems,
        "wi-1": { ...document.workItems["wi-1"]!, rank: rankFromInteger(10) },
        "wi-2": { ...document.workItems["wi-2"]!, rank: rankFromInteger(11) },
      },
    };
    const moved = commit(
      reorderWorkItemMutation(document, {
        expectedIncarnationId: "inc-1",
        id: "wi-3",
        expectedVersion: 1,
        expectedProjectOrderVersion: 3,
        beforeId: "wi-1",
        afterId: "wi-2",
      }, NOW),
    );
    const ordered = projectItems(moved, "project-1");
    expect(ordered.map((item) => item.id)).toEqual(["wi-1", "wi-3", "wi-2"]);
    expect(ordered.map((item) => item.rank)).toEqual([
      rankFromInteger(RANK_STEP),
      rankFromInteger(2 * RANK_STEP),
      rankFromInteger(3 * RANK_STEP),
    ]);
  });

  it("rebind moves the item to the end of the target project and bumps both order versions", () => {
    const document = withWorkItem(withWorkItem(baseDocument(), "wi-1"), "wi-2", "project-2");
    const moved = commit(
      rebindWorkItemProjectMutation(document, {
        expectedIncarnationId: "inc-1",
        id: "wi-1",
        expectedVersion: 1,
        projectId: "project-2",
        projectNameSnapshot: "Second",
      }, NOW),
    );
    expect(projectItems(moved, "project-2").map((item) => item.id)).toEqual(["wi-2", "wi-1"]);
    expect(moved.projectOrderVersions).toEqual({ "project-1": 2, "project-2": 2 });
    expect(moved.workItems["wi-1"]).toMatchObject({ projectNameSnapshot: "Second", version: 2 });
  });
});

describe("launch claims", () => {
  it("rejects a blank seed prompt before acquiring a claim", () => {
    const document = withWorkItem(baseDocument(), "wi-1");
    expect(acquireLaunchMutation(document, launchInput("wi-1", "att-blank", "   "), NOW)).toMatchObject({
      status: "invalid_input",
      details: { field: "seedPrompt", reason: "empty" },
    });
    expect(document.claims["wi-1"]).toBeUndefined();
  });

  it("returns the same claim for the same attempt and fingerprint, and conflicts otherwise", () => {
    const document = withClaim(withWorkItem(baseDocument(), "wi-1"), "wi-1", "att-1");
    const retry = acquireLaunchMutation(document, launchInput("wi-1", "att-1"), NOW);
    expect(retry.status).toBe("unchanged");
    const conflict = acquireLaunchMutation(document, launchInput("wi-1", "att-1", "different seed"), NOW);
    expect(conflict).toMatchObject({ status: "launch_key_conflict" });
    const held = acquireLaunchMutation(document, launchInput("wi-1", "att-2"), NOW);
    expect(held).toMatchObject({ status: "claim_held", details: { attemptId: "att-1" } });
  });

  it("refuses new attempts while a linked agent is active, stale-active, or the project is gone", () => {
    let document = withClaim(withWorkItem(baseDocument(), "wi-1"), "wi-1", "att-1");
    document = linkAgent(document, "agent-1", "wi-1", "att-1", "running");
    expect(document.claims["wi-1"]).toMatchObject({ state: "resolved", resolvedAgentId: "agent-1" });
    expect(acquireLaunchMutation(document, launchInput("wi-1", "att-2"), NOW)).toMatchObject({ status: "active_agent" });
    const stale = { ...document, agentLinks: { "agent-1": { ...document.agentLinks["agent-1"]!, staleSince: NOW } } };
    expect(acquireLaunchMutation(stale, launchInput("wi-1", "att-2"), NOW)).toMatchObject({ status: "stale_agent" });
    const closed = linkAgent(document, "agent-1", "wi-1", "att-1", "closed");
    expect(acquireLaunchMutation(closed, launchInput("wi-1", "att-2"), NOW).status).toBe("commit");
    expect(acquireLaunchMutation(closed, { ...launchInput("wi-1", "att-2"), projectAvailable: false }, NOW)).toMatchObject({
      status: "project_unavailable",
    });
  });

  it("progress joins facts monotonically and never clears earlier ones", () => {
    let document = withClaim(withWorkItem(baseDocument(), "wi-1"), "wi-1", "att-1");
    const progress = (facet: "journal" | "agent-request" | "workspace-observation", factVersion: number, facts: Record<string, string>) =>
      reportLaunchProgressMutation(document, { expectedIncarnationId: "inc-1", attemptId: "att-1", generation: 1, facet, factVersion, facts }, NOW);
    document = commit(progress("journal", 1, { clientInstanceId: "cid-a", journalPreparedAt: NOW }));
    expect(document.claims["wi-1"]?.initiatorClientInstanceId).toBe("cid-a");
    document = commit(progress("agent-request", 1, { agentRequestStartedAt: "2026-09-11T10:00:05.000Z" }));
    document = commit(
      progress("agent-request", 3, {
        agentOutcomeUnknownObservedAt: "2026-09-11T10:00:09.000Z",
        lastLaunchErrorCode: "agent_create_failed",
      }),
    );
    // A late, lower-version failure report for the same facet cannot clear the request-start.
    const late = progress("agent-request", 2, { lastLaunchErrorCode: "timeout" });
    expect(late.status).toBe("unchanged");
    expect(document.attempts["att-1"]).toMatchObject({
      agentRequestStartedAt: "2026-09-11T10:00:05.000Z",
      agentOutcomeUnknownObservedAt: "2026-09-11T10:00:09.000Z",
      lastLaunchErrorCode: "agent_create_failed",
      factVersions: { journal: 1, "agent-request": 3 },
    });
    expect(document.claims["wi-1"]).toMatchObject({ state: "pending", lastErrorCode: "agent_create_failed" });
    // Client-reported agent observation is stripped until a verified link exists.
    const spoofed = reportLaunchProgressMutation(document, {
      expectedIncarnationId: "inc-1",
      attemptId: "att-1",
      generation: 1,
      facet: "agent-observation",
      factVersion: 1,
      facts: { firstAgentObservedAt: NOW },
    }, NOW);
    expect(commit(spoofed).attempts["att-1"]?.firstAgentObservedAt).toBeUndefined();
    expect(progress("workspace-observation", 1, { workspaceIdHint: "wks-1", workspaceObservedAt: NOW }).status).toBe("commit");
    expect(reportLaunchProgressMutation(document, { expectedIncarnationId: "inc-1", attemptId: "att-1", generation: 2, facet: "journal", factVersion: 9, facts: {} }, NOW)).toMatchObject({
      status: "stale_launch",
    });
  });

  it("keeps unknown and known facts together and resolves only the matching pending claim", () => {
    let document = withClaim(withWorkItem(baseDocument(), "wi-1"), "wi-1", "att-1");
    document = commit(
      reportLaunchProgressMutation(document, {
        expectedIncarnationId: "inc-1",
        attemptId: "att-1",
        generation: 1,
        facet: "agent-request",
        factVersion: 1,
        facts: { agentRequestStartedAt: NOW, agentOutcomeUnknownObservedAt: NOW, lastLaunchErrorCode: "agent_create_failed" },
      }, NOW),
    );
    // Lifecycle later observes the agent: known and unknown coexist, claim resolves.
    document = linkAgent(document, "agent-1", "wi-1", "att-1");
    expect(document.attempts["att-1"]).toMatchObject({
      agentOutcomeUnknownObservedAt: NOW,
      firstAgentObservedAt: NOW,
      workspaceIdHint: "wks-1",
    });
    expect(document.claims["wi-1"]).toMatchObject({ state: "resolved", resolvedAgentId: "agent-1" });
    // A second agent for the same attempt is retained, not overwritten.
    document = linkAgent(document, "agent-2", "wi-1", "att-1");
    expect(Object.keys(document.agentLinks).sort()).toEqual(["agent-1", "agent-2"]);
  });

  it("abandon requires not_submitted certainty only before any request-start; late agents keep the abandoned fact", () => {
    let document = withClaim(withWorkItem(baseDocument(), "wi-1"), "wi-1", "att-1");
    document = commit(
      reportLaunchProgressMutation(document, {
        expectedIncarnationId: "inc-1",
        attemptId: "att-1",
        generation: 1,
        facet: "workspace-request",
        factVersion: 1,
        facts: { workspaceRequestStartedAt: NOW },
      }, NOW),
    );
    expect(abandonLaunchMutation(document, { expectedIncarnationId: "inc-1", workItemId: "wi-1", attemptId: "att-1", generation: 1, certainty: "not_submitted" }, NOW)).toMatchObject({
      status: "invalid_transition",
    });
    document = commit(
      abandonLaunchMutation(document, { expectedIncarnationId: "inc-1", workItemId: "wi-1", attemptId: "att-1", generation: 1, certainty: "outcome_unknown_confirmed" }, NOW),
    );
    expect(document.claims["wi-1"]?.state).toBe("abandoned");
    expect(document.attempts["att-1"]?.userDisposition).toBe("abandoned");
    // New attempt after abandon; the late agent for the old attempt links to the old attempt only.
    document = withClaim(document, "wi-1", "att-2");
    expect(document.claims["wi-1"]).toMatchObject({ attemptId: "att-2", generation: 2, state: "pending" });
    document = linkAgent(document, "agent-late", "wi-1", "att-1");
    expect(document.agentLinks["agent-late"]?.attemptId).toBe("att-1");
    expect(document.attempts["att-1"]).toMatchObject({ userDisposition: "abandoned", firstAgentObservedAt: NOW });
    expect(document.claims["wi-1"]).toMatchObject({ attemptId: "att-2", state: "pending" });
    // Stale progress for the old attempt cannot release the new claim.
    const stale = reportLaunchProgressMutation(document, {
      expectedIncarnationId: "inc-1",
      attemptId: "att-1",
      generation: 1,
      facet: "journal",
      factVersion: 5,
      facts: { lastLaunchErrorCode: "late" },
    }, NOW);
    expect(commit(stale).claims["wi-1"]).toMatchObject({ attemptId: "att-2", state: "pending" });
  });
});

describe("purge", () => {
  it("rejects pending, unknown, active, and stale-active, and cascades on success", () => {
    let document = withClaim(withWorkItem(baseDocument(), "wi-1"), "wi-1", "att-1");
    const archive = (doc: TodoDocument) =>
      commit(setWorkItemArchivedMutation(doc, { expectedIncarnationId: "inc-1", id: "wi-1", expectedVersion: doc.workItems["wi-1"]!.version, archived: true }, NOW));
    const purge = (doc: TodoDocument, force = false) =>
      purgeWorkItemMutation(doc, { expectedIncarnationId: "inc-1", id: "wi-1", expectedVersion: doc.workItems["wi-1"]!.version, confirm: true, force }, NOW);
    expect(purge(document)).toMatchObject({ status: "invalid_transition" });
    document = archive(document);
    expect(purge(document)).toMatchObject({ status: "claim_held" });
    document = linkAgent(document, "agent-1", "wi-1", "att-1", "running");
    expect(purge(document)).toMatchObject({ status: "active_agent" });
    const stale = { ...document, agentLinks: { "agent-1": { ...document.agentLinks["agent-1"]!, staleSince: NOW } } };
    expect(purge(stale)).toMatchObject({ status: "stale_agent" });
    const closed = linkAgent(document, "agent-1", "wi-1", "att-1", "closed");
    const purged = commit(purge(closed));
    expect(purged.workItems["wi-1"]).toBeUndefined();
    expect(purged.claims["wi-1"]).toBeUndefined();
    expect(Object.keys(purged.attempts)).toEqual([]);
    expect(Object.keys(purged.agentLinks)).toEqual([]);
    expect(purged.retiredWorkItemIds[0]).toMatchObject({ id: "wi-1" });
  });

  it("force purge still requires the claim to be abandoned first", () => {
    let document = withClaim(withWorkItem(baseDocument(), "wi-1"), "wi-1", "att-1");
    document = commit(
      reportLaunchProgressMutation(document, { expectedIncarnationId: "inc-1", attemptId: "att-1", generation: 1, facet: "agent-request", factVersion: 1, facts: { agentRequestStartedAt: NOW, agentOutcomeUnknownObservedAt: NOW } }, NOW),
    );
    document = commit(setWorkItemArchivedMutation(document, { expectedIncarnationId: "inc-1", id: "wi-1", expectedVersion: 1, archived: true }, NOW));
    expect(purgeWorkItemMutation(document, { expectedIncarnationId: "inc-1", id: "wi-1", expectedVersion: 2, confirm: true, force: true }, NOW)).toMatchObject({ status: "claim_held" });
    document = commit(abandonLaunchMutation(document, { expectedIncarnationId: "inc-1", workItemId: "wi-1", attemptId: "att-1", generation: 1, certainty: "outcome_unknown_confirmed" }, NOW));
    expect(purgeWorkItemMutation(document, { expectedIncarnationId: "inc-1", id: "wi-1", expectedVersion: 2, confirm: true, force: false }, NOW)).toMatchObject({ status: "invalid_transition" });
    expect(purgeWorkItemMutation(document, { expectedIncarnationId: "inc-1", id: "wi-1", expectedVersion: 2, confirm: true, force: true }, NOW).status).toBe("commit");
  });
});

describe("forget attempt", () => {
  function settledHistory() {
    // Two attempts: the first finished with a closed agent, the second holds the current claim.
    let document = withClaim(withWorkItem(baseDocument(), "wi-1"), "wi-1", "att-1");
    document = linkAgent(document, "agent-1", "wi-1", "att-1", "closed");
    document = withClaim(document, "wi-1", "att-2");
    return document;
  }

  it("drops a finished attempt and its links without touching the rest of the history", () => {
    const document = settledHistory();
    const outcome = forgetAttemptMutation(document, { expectedIncarnationId: "inc-1", workItemId: "wi-1", attemptId: "att-1" }, NOW);
    expect(outcome).toMatchObject({ status: "commit", result: { removedAgentIds: ["agent-1"] } });
    const next = commit(outcome);
    expect(next.attempts["att-1"]).toBeUndefined();
    expect(next.agentLinks["agent-1"]).toBeUndefined();
    expect(next.attempts["att-2"]).toBeDefined();
    // The claim record survives so the generation counter keeps producing fresh generations.
    expect(next.claims["wi-1"]).toMatchObject({ attemptId: "att-2", generation: 2 });
  });

  it("ignores a late agent for a forgotten attempt instead of resurrecting it", () => {
    const document = commit(
      forgetAttemptMutation(settledHistory(), { expectedIncarnationId: "inc-1", workItemId: "wi-1", attemptId: "att-1" }, NOW),
    );
    const late = applyAgentSnapshotMutation(
      document,
      {
        projection: canonicalizeAgentSnapshot({
          agent: fakeAgent({ id: "agent-late", labels: buildTodoLabels("wi-1", "att-1"), status: "running", workspaceId: "wks-1" }),
          projectId: "project-1",
        }),
        allowProjection: true,
        promptObserved: false,
      },
      NOW,
    );
    expect(late).toMatchObject({ status: "unchanged", result: { rejection: "unknown_attempt" } });
  });

  it("refuses an unsettled attempt, a pending claim holder and an active agent", () => {
    const pending = withClaim(withWorkItem(baseDocument(), "wi-1"), "wi-1", "att-1");
    expect(forgetAttemptMutation(pending, { expectedIncarnationId: "inc-1", workItemId: "wi-1", attemptId: "att-1" }, NOW)).toMatchObject({
      status: "invalid_transition",
    });
    // Settled by an observed agent, but that agent is still running and still holds the claim.
    const running = linkAgent(pending, "agent-1", "wi-1", "att-1", "running");
    expect(forgetAttemptMutation(running, { expectedIncarnationId: "inc-1", workItemId: "wi-1", attemptId: "att-1" }, NOW)).toMatchObject({
      status: "active_agent",
    });
    expect(forgetAttemptMutation(running, { expectedIncarnationId: "inc-1", workItemId: "wi-1", attemptId: "att-404" }, NOW)).toMatchObject({
      status: "not_found",
    });
  });
});

describe("abandon by attempt generation", () => {
  it("abandons an older attempt after a newer one took the claim", () => {
    // The first attempt reported an unknown outcome, the user retried, and the retry now holds the
    // claim. The old attempt must still be actionable, which is what its own generation buys.
    let document = withClaim(withWorkItem(baseDocument(), "wi-1"), "wi-1", "att-1");
    document = commit(
      reportLaunchProgressMutation(document, {
        expectedIncarnationId: "inc-1",
        attemptId: "att-1",
        generation: 1,
        facet: "agent-request",
        factVersion: 1,
        facts: { agentRequestStartedAt: NOW, agentOutcomeUnknownObservedAt: NOW },
      }, NOW),
    );
    document = commit(
      abandonLaunchMutation(document, { expectedIncarnationId: "inc-1", workItemId: "wi-1", attemptId: "att-1", generation: 1, certainty: "outcome_unknown_confirmed" }, NOW),
    );
    document = withClaim(document, "wi-1", "att-2");
    document = commit(
      reportLaunchProgressMutation(document, {
        expectedIncarnationId: "inc-1",
        attemptId: "att-2",
        generation: 2,
        facet: "agent-request",
        factVersion: 1,
        facts: { agentRequestStartedAt: NOW, agentOutcomeUnknownObservedAt: NOW },
      }, NOW),
    );
    // att-2 holds the claim at generation 2; abandoning it uses its own generation, not the claim's.
    const outcome = abandonLaunchMutation(
      document,
      { expectedIncarnationId: "inc-1", workItemId: "wi-1", attemptId: "att-2", generation: document.attempts["att-2"]!.claimGeneration, certainty: "outcome_unknown_confirmed" },
      NOW,
    );
    expect(commit(outcome).attempts["att-2"]?.userDisposition).toBe("abandoned");
    // The already abandoned older attempt can now be removed from the history.
    const forgotten = commit(
      forgetAttemptMutation(commit(outcome), { expectedIncarnationId: "inc-1", workItemId: "wi-1", attemptId: "att-1" }, NOW),
    );
    expect(forgotten.attempts["att-1"]).toBeUndefined();
  });
});
