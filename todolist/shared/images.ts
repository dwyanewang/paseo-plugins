import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Image bytes, deliberately kept out of the main Todo document. The `todo-data` document is
 * written on every card edit, launch milestone, and reconcile, and is migrated across versions;
 * base64 image data would bloat each of those writes. This second document holds the bytes keyed
 * by image id, and work items reference them by id (see `TodoImageRef` in `schema.ts`). Like
 * `todo-prefs`, it is client-written: any client may save it directly.
 */
export const TODO_IMAGES_SETTINGS_ID = "todo-images";
export const TODO_IMAGES_SETTINGS_VERSION = 1;

export const StoredImageSchema = z.object({
  id: z.string().min(1),
  /** Base64-encoded bytes, no `data:` prefix, so it feeds the host agent-create `images` field. */
  data: z.string().min(1),
  mimeType: z.string().min(1),
  name: z.string().optional(),
  byteLength: z.number().int().nonnegative(),
  addedAt: z.string(),
});
export type StoredImage = z.infer<typeof StoredImageSchema>;

export const TodoImagesSchema = z.object({
  /** image id → bytes. Work items reference these ids; unreferenced entries are pruned on save. */
  images: z.record(z.string(), StoredImageSchema).default({}),
});
export type TodoImages = z.output<typeof TodoImagesSchema>;

export const todoImages = defineSettings({
  id: TODO_IMAGES_SETTINGS_ID,
  scope: "host",
  version: TODO_IMAGES_SETTINGS_VERSION,
  schema: TodoImagesSchema,
});

export function emptyTodoImages(): TodoImages {
  return TodoImagesSchema.parse({});
}
