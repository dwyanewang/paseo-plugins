import type { WorkItem } from "./schema";

/**
 * Returns the initial composer seed for a work item.
 *
 * An explicit default prompt wins. When it is empty, the Todo itself still contains enough
 * intent to start a native launch, so fall back to its title and optional details.
 */
export function deriveSeedPrompt(
  item: Pick<WorkItem, "title" | "details" | "defaultPrompt">,
): string {
  if (item.defaultPrompt.trim().length > 0) return item.defaultPrompt;
  const title = item.title.trim();
  const details = item.details.trim();
  return details.length > 0 ? `${title}\n\n${details}` : title;
}
