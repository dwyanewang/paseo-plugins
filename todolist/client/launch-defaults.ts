import type { LaunchMode } from "../shared/prefs";

export const NEW_WORKSPACE = "__new__";

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
}): string {
  const options = input.mode === "composer"
    ? [{ value: NEW_WORKSPACE }, ...input.workspaces]
    : input.workspaces;
  return resolveChoice(options, input.selected, input.saved, input.contextual);
}
