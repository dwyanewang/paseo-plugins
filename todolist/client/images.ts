import { useSettings } from "@getpaseo/plugin/client";
import { useCallback } from "react";
import type { WorkItemImageInput } from "../shared/contracts";
import { todoImages, type StoredImage } from "../shared/images";
import type { TodoImageRef } from "../shared/schema";
import { pickImageDraftsWeb } from "./web";

/**
 * An image the editor is working with: metadata plus the in-memory base64 bytes. Existing images
 * are hydrated from the `todo-images` document; freshly picked ones carry a new id.
 */
export interface DraftImage {
  id: string;
  data: string;
  mimeType: string;
  name?: string;
  byteLength: number;
}

/** Builds the `data:` URL an RN `Image` needs from stored base64 bytes. */
export function imageDataUri(image: { data: string; mimeType: string }): string {
  return `data:${image.mimeType};base64,${image.data}`;
}

/** The reference metadata that goes into the main document. */
export function draftToRef(image: DraftImage): WorkItemImageInput {
  return {
    id: image.id,
    mimeType: image.mimeType,
    ...(image.name ? { name: image.name } : {}),
    byteLength: image.byteLength,
  };
}

function storedToDraft(image: StoredImage): DraftImage {
  return {
    id: image.id,
    data: image.data,
    mimeType: image.mimeType,
    ...(image.name ? { name: image.name } : {}),
    byteLength: image.byteLength,
  };
}

/**
 * Opens the platform file chooser and returns the picked images as drafts with fresh ids. Returns
 * an empty list when the user cancels, and null when no chooser is available (native surfaces have
 * no DOM file input; only the desktop/web runtime does). The DOM work lives in `client/web.ts`.
 */
export function pickImageDrafts(): Promise<DraftImage[] | null> {
  return pickImageDraftsWeb();
}

export interface TodoImageStore {
  /** Whether the bytes document is loaded; hydration and preview need it. */
  ready: boolean;
  /** Resolves references to drafts (with bytes). References whose bytes are missing are dropped. */
  resolve: (refs: readonly TodoImageRef[]) => DraftImage[];
  /**
   * Persists the bytes for `drafts` and deletes exactly `removeIds`. Call this before sending the
   * work-item RPC so a reference never points at bytes that were never written. Only ids the caller
   * knows are safe to drop are deleted, so a stale replica never wipes another card's image.
   */
  save: (drafts: readonly DraftImage[], removeIds: readonly string[]) => Promise<boolean>;
}

/** Client-owned access to the `todo-images` bytes document, mirroring the prefs pattern. */
export function useTodoImageStore(): TodoImageStore {
  const settings = useSettings(todoImages);
  const values = settings.status === "ready" ? settings.values : null;

  const resolve = useCallback(
    (refs: readonly TodoImageRef[]): DraftImage[] => {
      if (!values) return [];
      const out: DraftImage[] = [];
      for (const ref of refs) {
        const stored = values.images[ref.id];
        if (stored) out.push(storedToDraft(stored));
      }
      return out;
    },
    [values],
  );

  const save = useCallback(
    async (drafts: readonly DraftImage[], removeIds: readonly string[]): Promise<boolean> => {
      if (settings.status !== "ready") return false;
      const now = new Date().toISOString();
      const remove = new Set(removeIds);
      const nextImages: Record<string, StoredImage> = {};
      for (const [id, image] of Object.entries(settings.values.images)) {
        if (!remove.has(id)) nextImages[id] = image;
      }
      for (const draft of drafts) {
        nextImages[draft.id] = nextImages[draft.id] ?? {
          id: draft.id,
          data: draft.data,
          mimeType: draft.mimeType,
          ...(draft.name ? { name: draft.name } : {}),
          byteLength: draft.byteLength,
          addedAt: now,
        };
      }
      const before = Object.keys(settings.values.images);
      const unchanged =
        before.length === Object.keys(nextImages).length &&
        before.every((id) => nextImages[id] !== undefined);
      if (unchanged) return true;
      return settings.save({ images: nextImages }, settings.revision);
    },
    [settings],
  );

  return { ready: settings.status === "ready", resolve, save };
}
