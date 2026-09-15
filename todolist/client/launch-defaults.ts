import type { LaunchMode } from "../shared/prefs";

export const NEW_WORKSPACE = "__new__";
/** Direct execution into a worktree created for this run. */
export const NEW_WORKTREE = "__new_worktree__";

/** A choice in this dialog wins; saved choices apply only while they are still available. */
export function resolveChoice(
  options: readonly { value: string }[],
  selected: string | null,
  saved: string | null | undefined,
  fallback: string | null | undefined,
): string {
  return [selected, saved, fallback].find((value) => value && options.some((option) => option.value === value)) ?? options[0]?.value ?? "";
}

export function resolveWorkspaceTarget(input: {
  mode: LaunchMode;
  selected: string | null;
  saved: string | undefined;
  contextual: string | null;
  workspaces: readonly { value: string }[];
  /** Git projects can run in a new worktree; other projects only in existing workspaces. */
  canCreateWorktree?: boolean;
}): string {
  const options =
    input.mode === "composer"
      ? [{ value: NEW_WORKSPACE }, ...input.workspaces]
      : [...input.workspaces, ...(input.canCreateWorktree ? [{ value: NEW_WORKTREE }] : [])];
  return resolveChoice(options, input.selected, input.saved, input.contextual);
}

/**
 * Default branch and worktree name for a run: `todo-12-fix-login-redirect-k3x9`. The number ties
 * the branch to its card, the title makes it readable, and the suffix keeps a second run of the
 * same card from colliding with the first. Titles without ASCII letters keep just the number.
 */
export function worktreeNameFor(item: { number: number; title: string }, suffix: string): string {
  const words = item.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  return ["todo", String(item.number), words, suffix].filter(Boolean).join("-");
}
