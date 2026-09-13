import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * UI launch defaults, deliberately kept out of the Todo document: that one is only ever written
 * through fenced RPCs, while these are plain preferences any client may save directly.
 */
export const TODO_PREFS_SETTINGS_ID = "todo-prefs";
export const TODO_PREFS_SETTINGS_VERSION = 1;

export const LaunchModeSchema = z.enum(["run", "composer"]);
export type LaunchMode = z.infer<typeof LaunchModeSchema>;

export const TodoPrefsSchema = z.object({
  /** What Execute does by default: start the agent here, or hand off to the native composer. */
  launchMode: LaunchModeSchema.default("run"),
  /** Last `provider/model` used for a direct run; empty until the user picks one. */
  providerModel: z.string().default(""),
  /** Last provider mode id used for a direct run; empty means the provider default. */
  modeId: z.string().default(""),
});
export type TodoPrefs = z.output<typeof TodoPrefsSchema>;

export const todoPrefs = defineSettings({
  id: TODO_PREFS_SETTINGS_ID,
  scope: "host",
  version: TODO_PREFS_SETTINGS_VERSION,
  schema: TodoPrefsSchema,
});

export function emptyTodoPrefs(): TodoPrefs {
  return TodoPrefsSchema.parse({});
}
