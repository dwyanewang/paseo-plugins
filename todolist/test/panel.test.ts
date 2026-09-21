import { describe, expect, it } from "vitest";
import { buildWorkItemViews } from "../client/data";
import { parseQuickAdd, priorityTokenFor } from "../client/quick-add";
import { buildPanelContents, needsYou, summarizeProject } from "../client/summary";
import { moveWorkItemMutation } from "../server/mutations";
import type { TodoDocument, WorkItemStatus } from "../shared/schema";
import { baseDocument, NOW, withWorkItem } from "./helpers/setup";

function moved(document: TodoDocument, id: string, status: WorkItemStatus): TodoDocument {
  const outcome = moveWorkItemMutation(document, { expectedIncarnationId: "inc-1", id, status }, NOW);
  if (outcome.status !== "commit") throw new Error(`move failed: ${outcome.status}`);
  return outcome.values;
}

describe("quick add text", () => {
  it("makes the first line the title and keeps the rest as details", () => {
    expect(parseQuickAdd("Fix the login redirect\nIt drops the return path.\nAlso the mobile case.")).toMatchObject({
      title: "Fix the login redirect",
      details: "It drops the return path.\nAlso the mobile case.",
      priority: "none",
    });
  });

  it("reads a priority token out of the title and leaves the words", () => {
    expect(parseQuickAdd("!2 Cursor-paginate the device list")).toMatchObject({
      title: "Cursor-paginate the device list",
      priority: "high",
      priorityToken: "!2",
    });
    expect(parseQuickAdd("Cursor-paginate the device list !4")).toMatchObject({
      title: "Cursor-paginate the device list",
      priority: "low",
    });
  });

  it("leaves text that only looks like a token alone", () => {
    expect(parseQuickAdd("Handle !5 and foo!2 without tokens")).toMatchObject({
      title: "Handle !5 and foo!2 without tokens",
      priority: "none",
    });
    // A token below the first line belongs to the details, where it is ordinary text.
    expect(parseQuickAdd("Title\n!1 in the body")).toMatchObject({ title: "Title", priority: "none" });
  });

  it("has no title to submit when the text is blank", () => {
    expect(parseQuickAdd("   \n details only ").title).toBe("");
  });
});

describe("panel contents", () => {
  function fixture(): TodoDocument {
    let document = withWorkItem(baseDocument(), "wi-todo");
    document = withWorkItem(document, "wi-review");
    document = withWorkItem(document, "wi-backlog");
    document = withWorkItem(document, "wi-other", "project-2");
    document = moved(document, "wi-review", "in_review");
    document = moved(document, "wi-backlog", "backlog");
    return document;
  }

  it("counts only this project's To do, and everything waiting on you", () => {
    const views = buildWorkItemViews(fixture());
    expect(summarizeProject(views.values(), "project-1")).toEqual({ todoCount: 1, needsYouCount: 1 });
    expect(summarizeProject(views.values(), "project-2")).toEqual({ todoCount: 1, needsYouCount: 0 });
    expect([...views.values()].filter(needsYou)).toHaveLength(1);
  });

  it("lists the columns that mean now, and reports Backlog as a count", () => {
    const contents = buildPanelContents(buildWorkItemViews(fixture()).values(), "project-1");
    expect(contents.groups.map((group) => group.status)).toEqual(["in_review", "todo"]);
    expect(contents.backlogCount).toBe(1);
  });

  it("caps a long column and says how many are left", () => {
    let document = baseDocument();
    for (let index = 0; index < 7; index += 1) document = withWorkItem(document, `wi-${index}`);
    const contents = buildPanelContents(buildWorkItemViews(document).values(), "project-1");
    expect(contents.groups[0]).toMatchObject({ status: "todo", overflow: 2 });
    expect(contents.groups[0]?.views).toHaveLength(5);
  });
});

describe("priority token round trip", () => {
  it("writes the token back so editing a card shows how its priority was set", () => {
    expect(priorityTokenFor("urgent")).toBe("!1");
    expect(priorityTokenFor("low")).toBe("!4");
    expect(priorityTokenFor("none")).toBeNull();
    expect(parseQuickAdd(`Ship it ${priorityTokenFor("high")}`)).toMatchObject({ title: "Ship it", priority: "high" });
  });
});
