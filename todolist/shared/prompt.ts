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

/** The composer takes only text, so a card's images and files reach it as paths the agent can open. */
export function appendAttachmentPaths(
  prompt: string,
  attachments: { images: readonly { path: string }[]; files: readonly { path: string }[] },
): string {
  const sections: string[] = [];
  const list = (files: readonly { path: string }[]) => files.map((file) => `- ${file.path}`).join("\n");
  if (attachments.images.length > 0) sections.push(`Images attached to this task (open them to view):\n${list(attachments.images)}`);
  if (attachments.files.length > 0) sections.push(`Files attached to this task:\n${list(attachments.files)}`);
  return sections.length > 0 ? `${prompt}\n\n${sections.join("\n\n")}` : prompt;
}
