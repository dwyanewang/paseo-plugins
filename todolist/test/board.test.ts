import { describe, expect, it } from "vitest";
import { applyAgentSnapshotMutation, canonicalizeAgentSnapshot, markAgentLinkStaleMutation } from "../server/apply";
import { moveWorkItemMutation, reportLaunchProgressMutation } from "../server/mutations";
import { deriveAutoMove } from "../shared/board";
import { buildTodoLabels } from "../shared/labels";
import type { TodoDocument, WorkItemStatus } from "../shared/schema";
import { fakeAgent } from "./helpers/fake-paseo";
import { NOW, baseDocument, withClaim, withWorkItem } from "./helpers/setup";

type Outcome = { status: string; values?: TodoDocument; result?: { autoMove?: unknown } };

function commit(outcome: Outcome): TodoDocument {
  if (outcome.status !== "commit" || !outcome.values) throw new Error(`expected commit, got ${outcome.status}`);
  return outcome.values;
}

let clock = 1;

function snapshot(
  document: TodoDocument,
  agentId: string,
  status: "running" | "idle" | "closed",
  attemptId = "att-1",
) {
  clock += 1;
  return applyAgentSnapshotMutation(
    document,
    {
      projection: canonicalizeAgentSnapshot({
        agent: fakeAgent({
          id: agentId,
          labels: buildTodoLabels("wi-1", attemptId),
          status,
          workspaceId: "wks-1",
          updatedAt: new Date(Date.parse("2026-09-11T00:00:00.000Z") + clock * 1000).toISOString(),
        }),
        projectId: "project-1",
      }),
      allowProjection: true,
      promptObserved: false,
    },
    NOW,
  );
}

function move(document: TodoDocument, status: WorkItemStatus): TodoDocument {
  return commit(moveWorkItemMutation(document, { expectedIncarnationId: "inc-1", id: "wi-1", status }, NOW));
}

function launched(): TodoDocument {
  return withClaim(withWorkItem(baseDocument(), "wi-1"), "wi-1", "att-1");
}

function reportRequestStart(document: TodoDocument, facts: Record<string, string> = { agentRequestStartedAt: NOW }) {
  return reportLaunchProgressMutation(
    document,
    { expectedIncarnationId: "inc-1", attemptId: "att-1", generation: 1, facet: "agent-request", factVersion: 1, facts },
    NOW,
  );
}

const status = (document: TodoDocument) => document.workItems["wi-1"]?.status;

describe("deriveAutoMove", () => {
  const observed = { kind: "agent_observed" as const, busyBefore: false, busyAfter: false, agentFinished: false, launchSettled: true };

  it("pulls Backlog, To do and In review into In progress when a launch starts or an agent becomes active", () => {
    for (const from of ["backlog", "todo", "in_review"] as const) {
      expect(deriveAutoMove(from, { kind: "launch_started" })).toEqual({ from, to: "in_progress", reason: "launch_started" });
      expect(deriveAutoMove(from, { ...observed, busyAfter: true })).toEqual({ from, to: "in_progress", reason: "agent_active" });
    }
    expect(deriveAutoMove("in_progress", { kind: "launch_started" })).toBeNull();
  });

  it("moves In progress to In review only when the last active agent finished and no launch is open", () => {
    const finished = { ...observed, busyBefore: true, agentFinished: true };
    expect(deriveAutoMove("in_progress", finished)).toEqual({ from: "in_progress", to: "in_review", reason: "agent_finished" });
    expect(deriveAutoMove("in_progress", { ...finished, busyAfter: true })).toBeNull();
    expect(deriveAutoMove("in_progress", { ...finished, launchSettled: false })).toBeNull();
    expect(deriveAutoMove("in_progress", { ...finished, agentFinished: false })).toBeNull();
    expect(deriveAutoMove("todo", finished)).toBeNull();
  });

  it("never touches Done or Cancelled", () => {
    for (const from of ["done", "cancelled"] as const) {
      expect(deriveAutoMove(from, { kind: "launch_started" })).toBeNull();
      expect(deriveAutoMove(from, { ...observed, busyAfter: true })).toBeNull();
      expect(deriveAutoMove(from, { ...observed, busyBefore: true, agentFinished: true })).toBeNull();
    }
  });
});

describe("launch-started move (R1)", () => {
  it("moves the card on the first request-start of the current launch, in the same write, without a version bump", () => {
    const outcome = reportRequestStart(launched());
    expect(outcome).toMatchObject({ status: "commit", result: { autoMove: { from: "todo", to: "in_progress", reason: "launch_started" } } });
    const document = commit(outcome);
    expect(document.workItems["wi-1"]).toMatchObject({ status: "in_progress", statusReason: "launch_started", version: 1 });
  });

  it("does not move again on later milestones, so a manual move stands", () => {
    const started = move(commit(reportRequestStart(launched())), "todo");
    const later = reportLaunchProgressMutation(
      started,
      { expectedIncarnationId: "inc-1", attemptId: "att-1", generation: 1, facet: "workspace-request", factVersion: 1, facts: { workspaceRequestStartedAt: NOW } },
      NOW,
    );
    expect(status(commit(later))).toBe("todo");
  });

  it("leaves a card that was moved to Done before the request started", () => {
    expect(status(commit(reportRequestStart(move(launched(), "done"))))).toBe("done");
  });
});

describe("agent-driven moves (R2, R3)", () => {
  it("runs To do → In progress → In review as the agent starts and finishes, and a replay changes nothing", () => {
    const running = snapshot(launched(), "agent-1", "running");
    expect(running).toMatchObject({ result: { autoMove: { from: "todo", to: "in_progress", reason: "agent_active" } } });
    const active = commit(running);
    const finishedOutcome = snapshot(active, "agent-1", "idle");
    expect(finishedOutcome).toMatchObject({ result: { autoMove: { from: "in_progress", to: "in_review", reason: "agent_finished" } } });
    const finished = commit(finishedOutcome);
    expect(finished.workItems["wi-1"]).toMatchObject({ status: "in_review", statusReason: "agent_finished", version: 1 });
    const replay = snapshot(finished, "agent-1", "idle");
    expect(replay.status).toBe("unchanged");
  });

  it("returns a reviewed card to In progress when the agent runs again (a follow-up)", () => {
    const reviewed = commit(snapshot(commit(snapshot(launched(), "agent-1", "running")), "agent-1", "idle"));
    const followUp = commit(snapshot(reviewed, "agent-1", "running"));
    expect(followUp.workItems["wi-1"]).toMatchObject({ status: "in_progress", statusReason: "agent_active" });
  });

  it("moves to In review when a new link is first seen already finished", () => {
    const started = commit(reportRequestStart(launched()));
    const outcome = snapshot(started, "agent-1", "idle");
    expect(outcome).toMatchObject({ result: { linked: true, autoMove: { to: "in_review" } } });
  });

  it("respects a manual move while the agent runs", () => {
    const active = commit(snapshot(launched(), "agent-1", "running"));
    const finished = commit(snapshot(move(active, "todo"), "agent-1", "idle"));
    expect(status(finished)).toBe("todo");
  });

  it("never moves a Done or Cancelled card, even when its agent starts or finishes", () => {
    for (const final of ["done", "cancelled"] as const) {
      const active = commit(snapshot(move(launched(), final), "agent-1", "running"));
      expect(status(active)).toBe(final);
      expect(status(commit(snapshot(active, "agent-1", "idle")))).toBe(final);
    }
  });

  it("waits for every active agent to finish", () => {
    let document = commit(snapshot(launched(), "agent-1", "running"));
    document = commit(snapshot(document, "agent-2", "running"));
    document = commit(snapshot(document, "agent-1", "idle"));
    expect(status(document)).toBe("in_progress");
    document = commit(snapshot(document, "agent-2", "closed"));
    expect(status(document)).toBe("in_review");
  });

  it("keeps In progress while a newer launch is still pending", () => {
    const active = commit(snapshot(launched(), "agent-1", "running"));
    const pending: TodoDocument = {
      ...active,
      claims: { ...active.claims, "wi-1": { ...active.claims["wi-1"]!, attemptId: "att-2", generation: 2, state: "pending" } },
    };
    expect(status(commit(snapshot(pending, "agent-1", "idle")))).toBe("in_progress");
  });

  it("does not move on a stale overlay", () => {
    const active = commit(snapshot(launched(), "agent-1", "running"));
    const stale = markAgentLinkStaleMutation(active, { agentId: "agent-1", errorCode: "transport" }, NOW);
    expect(status(commit(stale))).toBe("in_progress");
  });
});
