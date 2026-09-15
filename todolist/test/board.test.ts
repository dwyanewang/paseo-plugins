import { describe, expect, it } from "vitest";
import { applyAgentSnapshotMutation, canonicalizeAgentSnapshot, markAgentLinkStaleMutation } from "../server/apply";
import { moveWorkItemMutation, reportLaunchProgressMutation } from "../server/mutations";
import {
  boardLayout,
  buildBoard,
  deriveAutoMove,
  formatRelativeTime,
  latestLink,
  matchesSearch,
  neighboursAt,
  resolveInProgressIntent,
} from "../shared/board";
import { buildTodoLabels } from "../shared/labels";
import { rankFromInteger } from "../shared/rank";
import type { AgentLink, TodoDocument, WorkItem, WorkItemStatus } from "../shared/schema";
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

function card(id: string, patch: Partial<WorkItem> = {}): { item: WorkItem } {
  const index = Number(id.replace(/\D/g, "")) || 1;
  return {
    item: {
      id,
      creationFingerprint: "f",
      version: 1,
      number: index,
      projectId: "project-1",
      projectNameSnapshot: "Project",
      title: `Item ${id}`,
      details: "",
      defaultPrompt: "",
      status: "todo",
      statusChangedAt: NOW,
      statusReason: "created",
      rank: rankFromInteger(index * 1000),
      createdAt: NOW,
      updatedAt: NOW,
      ...patch,
    },
  };
}

describe("board grouping", () => {
  const cards = [
    card("wi-3", { status: "in_progress" }),
    card("wi-1"),
    card("wi-2", { rank: rankFromInteger(500) }),
    card("wi-4", { status: "backlog" }),
    card("wi-5", { status: "cancelled" }),
    card("wi-6", { status: "done", archivedAt: "2026-09-11T11:00:00.000Z" }),
    card("wi-7", { archivedAt: "2026-09-11T12:00:00.000Z" }),
    card("wi-8", { projectId: "project-2" }),
  ];
  const ids = (views: readonly { item: WorkItem }[]) => views.map((view) => view.item.id);

  it("shows the four active columns in rank order and leaves other projects and archived cards out", () => {
    const board = buildBoard(cards, { projectId: "project-1", filter: "active", query: "" });
    expect(board.columns.map((column) => column.status)).toEqual(["todo", "in_progress", "in_review", "done"]);
    expect(ids(board.columns[0]!.views)).toEqual(["wi-2", "wi-1"]);
    expect(ids(board.columns[1]!.views)).toEqual(["wi-3"]);
    expect(board.columns[3]!.views).toEqual([]);
    expect(board.archived).toEqual([]);
  });

  it("maps each filter to its columns and lists archived cards newest first", () => {
    const statuses = (filter: "all" | "backlog" | "cancelled") =>
      buildBoard(cards, { projectId: "project-1", filter, query: "" }).columns.map((column) => column.status);
    expect(statuses("all")).toEqual(["backlog", "todo", "in_progress", "in_review", "done", "cancelled"]);
    expect(statuses("backlog")).toEqual(["backlog"]);
    expect(statuses("cancelled")).toEqual(["cancelled"]);
    const archived = buildBoard(cards, { projectId: "project-1", filter: "archived", query: "" });
    expect(archived.columns).toEqual([]);
    expect(ids(archived.archived)).toEqual(["wi-7", "wi-6"]);
  });

  it("searches the number, title and details without case", () => {
    const item = card("wi-12", { title: "Fix Login", details: "OAuth callback" }).item;
    expect(matchesSearch(item, "#12")).toBe(true);
    expect(matchesSearch(item, "12")).toBe(true);
    expect(matchesSearch(item, "#1")).toBe(false);
    expect(matchesSearch(item, "login")).toBe(true);
    expect(matchesSearch(item, "  oauth ")).toBe(true);
    expect(matchesSearch(item, "logout")).toBe(false);
    expect(ids(buildBoard(cards, { projectId: "project-1", filter: "active", query: "#3" }).columns.flatMap((column) => column.views))).toEqual(["wi-3"]);
  });

  it("finds drop neighbours for moving a card up or down a column", () => {
    const column = ["a", "b", "c", "d"];
    expect(neighboursAt(column, "c", 1)).toEqual({ beforeId: "a", afterId: "b" });
    expect(neighboursAt(column, "b", 2)).toEqual({ beforeId: "c", afterId: "d" });
    expect(neighboursAt(column, "b", 0)).toEqual({ afterId: "a" });
    expect(neighboursAt(column, "c", 3)).toEqual({ beforeId: "d" });
    expect(neighboursAt(column, "c", 99)).toEqual({ beforeId: "d" });
  });
});

describe("board presentation", () => {
  it("lays columns side by side, scrolls them, or falls back to tabs by width", () => {
    expect(boardLayout(4 * 240 + 3 * 12, 4, 12)).toBe("columns");
    expect(boardLayout(4 * 240 + 3 * 12 - 1, 4, 12)).toBe("scroll");
    expect(boardLayout(2 * 240 + 12, 4, 12)).toBe("scroll");
    expect(boardLayout(2 * 240 + 11, 4, 12)).toBe("tabs");
    expect(boardLayout(100, 1, 12)).toBe("columns");
  });

  it("picks the agent whose state changed last", () => {
    const link = (agentId: string, stateChangedAt: string) => ({ agentId, stateChangedAt }) as AgentLink;
    expect(latestLink([])).toBeUndefined();
    expect(latestLink([link("a", "2026-09-11T10:00:00.000Z"), link("b", "2026-09-11T11:00:00.000Z"), link("c", "2026-09-11T09:00:00.000Z")])?.agentId).toBe("b");
  });

  it("formats relative times", () => {
    const now = Date.parse("2026-09-15T12:00:00.000Z");
    expect(formatRelativeTime("2026-09-15T11:59:30.000Z", now)).toBe("just now");
    expect(formatRelativeTime("2026-09-15T11:55:00.000Z", now)).toBe("5 min ago");
    expect(formatRelativeTime("2026-09-15T09:00:00.000Z", now)).toBe("3 h ago");
    expect(formatRelativeTime("2026-09-13T12:00:00.000Z", now)).toBe("2 d ago");
    expect(formatRelativeTime("2026-09-15T12:01:00.000Z", now)).toBe("just now");
    expect(formatRelativeTime("not a date", now)).toBe("");
  });
});

describe("moving a card into In progress", () => {
  const link = (agentId: string, displayState: AgentLink["displayState"], stateChangedAt: string, patch: Partial<AgentLink> = {}) =>
    ({ agentId, displayState, stateChangedAt, ...patch }) as AgentLink;
  const settled = { pendingClaim: null, unknownAttemptIds: [] as string[] };
  const intent = (links: AgentLink[], aggregate: { pendingClaim: unknown; unknownAttemptIds: string[] } = settled) =>
    resolveInProgressIntent({ links, aggregate: aggregate as Parameters<typeof resolveInProgressIntent>[0]["aggregate"] });

  it("starts a new run when no agent ever worked on the card", () => {
    expect(intent([])).toEqual({ kind: "execute" });
  });

  it("only moves while an agent runs or a launch is in flight, so nothing interrupts a turn", () => {
    expect(intent([link("a", "running", "2"), link("b", "waiting_confirmation", "3")])).toEqual({ kind: "move_only", reason: "agent_active" });
    expect(intent([link("a", "initializing", "1")])).toEqual({ kind: "move_only", reason: "agent_active" });
    expect(intent([link("a", "running", "1", { staleSince: "x" })])).toEqual({ kind: "move_only", reason: "agent_active" });
    expect(intent([link("a", "waiting_confirmation", "1")], { pendingClaim: { attemptId: "att" }, unknownAttemptIds: [] })).toEqual({ kind: "move_only", reason: "launch_in_flight" });
    expect(intent([], { pendingClaim: null, unknownAttemptIds: ["att"] })).toEqual({ kind: "move_only", reason: "launch_in_flight" });
  });

  it("sends an agent waiting for approval to its page", () => {
    expect(intent([link("a", "waiting_confirmation", "3"), link("b", "permission", "1")])).toEqual({ kind: "permission", agentId: "b" });
  });

  it("continues the most recently settled agent first, including failed and closed ones", () => {
    expect(intent([link("old", "closed", "1"), link("new", "waiting_confirmation", "3"), link("mid", "error", "2")])).toEqual({
      kind: "continue",
      agentIds: ["new", "mid", "old"],
    });
  });

  it("does not trust stale or provider-less agents to take a message", () => {
    expect(intent([link("a", "waiting_confirmation", "1", { staleSince: "x" }), link("b", "unavailable", "2")])).toEqual({ kind: "execute" });
  });
});
