import { useSettings } from "@getpaseo/plugin/client";
import { useCallback } from "react";
import type { WorkItemImageInput } from "../shared/contracts";
import { todoImages, type StoredImage } from "../shared/images";
import { IMAGE_MAX_COUNT, type FieldError } from "../shared/limits";
import type { TodoImageRef } from "../shared/schema";
import { pickImages } from "@getpaseo/plugin/client/react-native";
import { createId } from "../shared/ids";
import { canTakeImagesWeb, pickImageDraftsWeb, subscribeImageInput } from "./web";

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

/** Undefined on hosts that predate the plugin image picker. */
const hostPickImages = typeof pickImages === "function" ? pickImages : null;

/** Whether this runtime can attach images at all: the host's picker, or the browser's. */
export function canTakeImages(): boolean {
  return hostPickImages !== null || canTakeImagesWeb();
}

/** Whether images can also be pasted or dropped onto a box; only the browser can. */
export function canPasteImages(): boolean {
  return canTakeImagesWeb();
}

/**
 * Opens the platform chooser and returns the picked images as drafts with fresh ids, at most
 * `limit`. Returns an empty list when the user cancels, and null when no chooser is available.
 * The browser keeps its own chooser, which scales oversized images down (`client/web.ts`); the
 * host's picker does not resize, so an oversized image there is refused by the caller instead.
 * Rejects when the platform refuses, such as denied photo access.
 */
export async function pickImageDrafts(limit: number): Promise<DraftImage[] | null> {
  if (canTakeImagesWeb()) return pickImageDraftsWeb();
  if (!hostPickImages) return null;
  const picked = await hostPickImages({ multiple: true, limit });
  return picked.map((image) => ({
    id: createId("img"),
    data: image.base64,
    mimeType: image.mimeType,
    ...(image.fileName ? { name: image.fileName } : {}),
    byteLength: image.byteLength,
  }));
}

/**
 * Delivers images pasted or dropped inside the view with this `nativeID`, and tells `onDragging`
 * while files are held over it; null without a DOM.
 */
export function subscribePastedImages(
  targetId: string,
  onImages: (drafts: DraftImage[]) => void,
  onDragging?: (dragging: boolean) => void,
): (() => void) | null {
  return subscribeImageInput(targetId, onImages, onDragging);
}

export function describeImageError(reason: Extract<FieldError, { field: "images" }>["reason"]): string {
  switch (reason) {
    case "too_many":
      return `Up to ${IMAGE_MAX_COUNT} images per card.`;
    case "too_large":
      return "That image is too large to attach, even scaled down.";
    case "unsupported_type":
      return "Only PNG, JPEG, GIF, and WebP images are supported.";
    default:
      return "That image could not be read.";
  }
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

/**
 * Saves the bytes of a card's edited image set, then returns the references for the work-item RPC,
 * or null when the bytes could not be written. Bytes go first so a reference never points at data
 * that was never stored. Only images this edit dropped, and no other known card uses, are deleted.
 */
export async function persistCardImages(
  store: TodoImageStore,
  images: readonly DraftImage[],
  previous: readonly TodoImageRef[],
  usedElsewhere: ReadonlySet<string>,
): Promise<WorkItemImageInput[] | null> {
  const kept = new Set(images.map((image) => image.id));
  const removeIds = previous.map((ref) => ref.id).filter((id) => !kept.has(id) && !usedElsewhere.has(id));
  if (images.length > 0 || removeIds.length > 0) {
    if (!(await store.save(images, removeIds))) return null;
  }
  return images.map(draftToRef);
}
