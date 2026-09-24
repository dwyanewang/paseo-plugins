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

/** The composer takes only text, so a card's images reach it as paths the agent can open. */
export function appendImagePaths(prompt: string, files: readonly { path: string }[]): string {
  if (files.length === 0) return prompt;
  const lines = files.map((file) => `- ${file.path}`);
  return `${prompt}\n\nImages attached to this task (open them to view):\n${lines.join("\n")}`;
}
