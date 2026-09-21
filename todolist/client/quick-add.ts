import { WORK_ITEM_PRIORITIES, type WorkItemPriority } from "../shared/schema";

/** `!1`–`!4`, highest first, matching the priority order the board sorts by. */
const PRIORITY_TOKENS: Record<string, WorkItemPriority> = {
  "1": "urgent",
  "2": "high",
  "3": "medium",
  "4": "low",
};

export interface QuickAddDraft {
  title: string;
  details: string;
  priority: WorkItemPriority;
  /** The token that set the priority, so the editor can say where the value came from. */
  priorityToken: string | null;
}

const TOKEN = /(^|\s)!([1-4])(?=\s|$)/g;

/**
 * One box of text becomes a card: the first line is the title, the rest is the details, and a
 * `!1`–`!4` anywhere in the first line sets the priority and leaves the title.
 *
 * Running an item sends the title and details together (see `buildSeedPrompt`), so nothing typed
 * here is lost on the way to the agent.
 */
export function parseQuickAdd(text: string): QuickAddDraft {
  const [firstLine = "", ...rest] = text.split("\n");
  let priority: WorkItemPriority = "none";
  let priorityToken: string | null = null;
  const title = firstLine
    .replace(TOKEN, (_match, lead: string, digit: string) => {
      // The last token wins, the way the last edit does.
      priority = PRIORITY_TOKENS[digit] ?? "none";
      priorityToken = `!${digit}`;
      return lead;
    })
    .trim();
  return { title, details: rest.join("\n").trim(), priority, priorityToken };
}

/** Empty titles never reach the daemon: the field validator would reject them anyway. */
export function isQuickAddReady(draft: QuickAddDraft): boolean {
  return draft.title.length > 0;
}

export function priorityTokenFor(priority: WorkItemPriority): string | null {
  const index = WORK_ITEM_PRIORITIES.indexOf(priority);
  return index >= 0 && index < 4 ? `!${index + 1}` : null;
}
