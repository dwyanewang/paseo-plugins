/**
 * Web/desktop-only helpers. Plugin client bundles also run on iOS and Android, where these DOM
 * APIs do not exist; every export here is therefore guarded by a runtime capability check and must
 * only be reached through a caller that tolerates a null (unavailable) result. This is the one file
 * the client DOM audit permits to touch `document`, `window`, and `FileReader`.
 */
import { base64ByteLength, IMAGE_ALLOWED_MIME_TYPES, IMAGE_MAX_BYTES } from "../shared/limits";
import { createId } from "../shared/ids";
import type { PickedFile } from "./files";
import type { DraftImage } from "./images";

/** Claude scales anything larger down to this edge anyway, so a shrunk image loses nothing. */
const SHRINK_EDGES = [1568, 1200, 900] as const;
const JPEG_QUALITIES = [0.85, 0.7] as const;

function hasDom(): boolean {
  return typeof document !== "undefined" && typeof FileReader !== "undefined";
}

/** Whether this runtime can choose, paste, or drop images at all. */
export function canTakeImagesWeb(): boolean {
  return hasDom();
}

/**
 * Opens the browser file chooser and returns the picked images as drafts with fresh ids. Returns
 * an empty list when the user cancels, and null when no chooser is available (native runtimes have
 * no DOM file input).
 */
export async function pickImageDraftsWeb(): Promise<DraftImage[] | null> {
  if (!hasDom()) return null;
  const files = await chooseFiles(IMAGE_ALLOWED_MIME_TYPES.join(","));
  if (!files || files.length === 0) return [];
  return filesToDrafts(Array.from(files));
}

/**
 * Opens the browser file chooser for any kind of file. Returns an empty list when the user
 * cancels, and null without a DOM.
 */
export async function pickFilesWeb(): Promise<PickedFile[] | null> {
  if (!hasDom()) return null;
  const files = await chooseFiles(null);
  return files ? Array.from(files).map(toPickedFile) : [];
}

function toPickedFile(file: File): PickedFile {
  return {
    name: file.name || "file",
    mimeType: file.type,
    size: file.size,
    read: (offset, length) => readBlobAsBase64(file.slice(offset, offset + length)),
  };
}

/** Whether shortcuts read ⌘ rather than Ctrl here: a Mac or iPad browser or desktop app. */
export function usesCommandKeyWeb(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);
}

/** The scroll offset a text area reports in its React Native Web `onScroll` event, or null. */
export function scrollTopOfWeb(event: unknown): number | null {
  const target = (event as { nativeEvent?: { target?: unknown } } | null)?.nativeEvent?.target;
  return typeof Element !== "undefined" && target instanceof Element ? target.scrollTop : null;
}

/**
 * Makes a React Native modal (rendered with `nativeID` `modalId`) live with the host's own dialogs.
 * Both trap focus: when a host dialog opens over the modal (the command center, say), each would
 * pull focus back from the other forever and hang the page. While the modal is in the page,
 * including its fade out, focus moving into another dialog is kept from the modal's trap, which
 * listens after this does. Escape goes to `onEscape` on key down unless another dialog holds focus;
 * it returns whether it handled the key. The modal's own Escape runs on key up, after a host dialog
 * has already closed on key down, so callers ignore that one. Returns an unsubscribe, or null
 * without a DOM.
 */
export function guardModalWeb(modalId: string, onEscape: () => boolean): (() => void) | null {
  if (!hasDom()) return null;
  const inOtherDialog = (node: Element | null): boolean => {
    const modal = document.getElementById(modalId);
    return Boolean(modal && node && !modal.contains(node) && node.closest('[role="dialog"], [aria-modal="true"]'));
  };
  const onFocus = (event: FocusEvent) => {
    if (inOtherDialog(event.target instanceof Element ? event.target : null)) event.stopImmediatePropagation();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.isComposing || !document.getElementById(modalId)) return;
    if (inOtherDialog(document.activeElement)) return;
    if (onEscape()) event.preventDefault();
  };
  document.addEventListener("focus", onFocus, true);
  // Capture: text fields stop their key events from bubbling.
  document.addEventListener("keydown", onKeyDown, true);
  return () => {
    document.removeEventListener("focus", onFocus, true);
    document.removeEventListener("keydown", onKeyDown, true);
  };
}

/** Keys an open floating menu reacts to, wherever focus is inside the box. */
export type MenuKeyWeb = "up" | "down" | "choose";

/**
 * Arrow keys and Enter for an open menu, read before any text field sees them, so the same keys
 * work from a filter box, the box's own text, or a button. `onKey` returns whether it used the key.
 * Returns an unsubscribe, or null without a DOM.
 */
export function subscribeMenuKeysWeb(onKey: (key: MenuKeyWeb) => boolean): (() => void) | null {
  if (!hasDom()) return null;
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.isComposing || event.key === "Process" || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    const key: MenuKeyWeb | null = event.key === "ArrowUp" ? "up" : event.key === "ArrowDown" ? "down" : event.key === "Enter" ? "choose" : null;
    if (!key || !onKey(key)) return;
    event.preventDefault();
    event.stopPropagation();
  };
  document.addEventListener("keydown", onKeyDown, true);
  return () => document.removeEventListener("keydown", onKeyDown, true);
}

/**
 * Left and right arrow keys, for paging through images, unless a text field has focus. `onKey`
 * returns whether it used the key. Returns an unsubscribe, or null without a DOM.
 */
export function subscribeArrowKeysWeb(onKey: (direction: -1 | 1) => boolean): (() => void) | null {
  if (!hasDom()) return null;
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.isComposing || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    const direction = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : null;
    const active = document.activeElement;
    if (!direction || (active && /^(?:INPUT|TEXTAREA)$/.test(active.tagName))) return;
    if (onKey(direction)) event.preventDefault();
  };
  document.addEventListener("keydown", onKeyDown, true);
  return () => document.removeEventListener("keydown", onKeyDown, true);
}

/** How far a mouse moves with its button down before a press on a scrolling row becomes a drag. */
const DRAG_THRESHOLD = 5;

/**
 * Lets a mouse scroll the sideways-scrolling element with DOM id `elementId` (a React Native
 * `nativeID`): drag it left and right, or turn the wheel over it. A mouse has no other way to
 * reach what overflows a row whose scroll bar is hidden. A drag starts once the pointer has moved
 * a few pixels, so a plain click still presses what is under it, and the click that ends a drag is
 * swallowed. The wheel scrolls the row only while it can still move that way, then lets the page
 * or panel around it scroll. Touch keeps the platform's own scrolling. Returns an unsubscribe, or
 * null without a DOM.
 */
export function attachMouseScrollWeb(elementId: string): (() => void) | null {
  if (!hasDom()) return null;
  const element = document.getElementById(elementId);
  if (!element) return null;
  let drag: { pointerId: number; startX: number; startLeft: number; moved: boolean } | null = null;
  const overflows = () => element.scrollWidth - element.clientWidth > 1;
  const swallowClick = (event: MouseEvent) => {
    event.stopPropagation();
    event.preventDefault();
  };
  const end = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const moved = drag.moved;
    drag = null;
    if (!moved) return;
    if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
    element.style.cursor = "";
    element.style.userSelect = "";
    // The click that ends a drag is not a press on the pill it started on.
    element.addEventListener("click", swallowClick, { capture: true, once: true });
    setTimeout(() => element.removeEventListener("click", swallowClick, true), 0);
  };
  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType !== "mouse" || event.button !== 0 || !overflows()) return;
    drag = { pointerId: event.pointerId, startX: event.clientX, startLeft: element.scrollLeft, moved: false };
  };
  const onPointerMove = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const dx = event.clientX - drag.startX;
    if (!drag.moved) {
      if (Math.abs(dx) < DRAG_THRESHOLD) return;
      drag.moved = true;
      element.setPointerCapture(event.pointerId);
      element.style.cursor = "grabbing";
      element.style.userSelect = "none";
      window.getSelection()?.removeAllRanges();
    }
    element.scrollLeft = drag.startLeft - dx;
    event.preventDefault();
  };
  const onWheel = (event: WheelEvent) => {
    // Sideways gestures (a trackpad, Shift+wheel) already scroll the row.
    if (Math.abs(event.deltaX) >= Math.abs(event.deltaY) || !overflows()) return;
    const max = element.scrollWidth - element.clientWidth;
    const atStart = element.scrollLeft <= 0;
    const atEnd = element.scrollLeft >= max - 1;
    if ((event.deltaY < 0 && atStart) || (event.deltaY > 0 && atEnd)) return;
    element.scrollLeft = Math.min(max, Math.max(0, element.scrollLeft + event.deltaY));
    event.preventDefault();
  };
  element.addEventListener("pointerdown", onPointerDown);
  element.addEventListener("pointermove", onPointerMove);
  element.addEventListener("pointerup", end);
  element.addEventListener("pointercancel", end);
  element.addEventListener("wheel", onWheel, { passive: false });
  return () => {
    element.removeEventListener("pointerdown", onPointerDown);
    element.removeEventListener("pointermove", onPointerMove);
    element.removeEventListener("pointerup", end);
    element.removeEventListener("pointercancel", end);
    element.removeEventListener("wheel", onWheel);
    element.removeEventListener("click", swallowClick, true);
  };
}

/** A drag over the target keeps this long before it counts as gone; `dragover` repeats faster. */
const DRAG_LINGER_MS = 150;

/**
 * Takes images and other files pasted or dropped onto the element whose DOM id is `targetId` (a
 * React Native `nativeID`, which React Native Web renders as `id`). Images go to `onImages`, other
 * files to `onFiles`, or nowhere without it. Pastes and drops elsewhere are left alone, so the
 * host's own composer never loses an attachment to an open Todo box. `onDragging` hears when files
 * are held over the target and when they leave. Returns an unsubscribe, or null without a DOM.
 */
export function subscribeDroppedFilesWeb(
  targetId: string,
  handlers: { onImages: (drafts: DraftImage[]) => void; onFiles?: (files: PickedFile[]) => void; onDragging?: (dragging: boolean) => void },
): (() => void) | null {
  if (!hasDom()) return null;
  const inside = (target: EventTarget | null): boolean => {
    for (let node = target instanceof Element ? target : null; node; node = node.parentElement) {
      if (node.id === targetId) return true;
    }
    return false;
  };
  /** Whether anything was taken. */
  const take = (data: DataTransfer): boolean => {
    const { images, others } = splitFiles(data);
    const kept = handlers.onFiles ? others : [];
    if (images.length > 0) void filesToDrafts(images).then(handlers.onImages);
    if (kept.length > 0) handlers.onFiles?.(kept.map(toPickedFile));
    return images.length > 0 || kept.length > 0;
  };
  const onPaste = (event: ClipboardEvent) => {
    if (!inside(event.target) || !event.clipboardData) return;
    // A screenshot carries no text; keep the default when there is text to paste alongside.
    const text = event.clipboardData.types.includes("text/plain");
    if (take(event.clipboardData) && !text) event.preventDefault();
  };
  // `dragleave` also fires when crossing into a child, so the drag counts as over the target for
  // as long as `dragover` keeps repeating there.
  let dragging = false;
  let lingering: ReturnType<typeof setTimeout> | null = null;
  const setDragging = (next: boolean) => {
    if (lingering) clearTimeout(lingering);
    lingering = next ? setTimeout(() => setDragging(false), DRAG_LINGER_MS) : null;
    if (next === dragging) return;
    dragging = next;
    handlers.onDragging?.(next);
  };
  const onDragOver = (event: DragEvent) => {
    if (!inside(event.target) || !event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDragging(true);
  };
  const onDrop = (event: DragEvent) => {
    if (!inside(event.target) || !event.dataTransfer) return;
    setDragging(false);
    if (take(event.dataTransfer)) event.preventDefault();
  };
  document.addEventListener("paste", onPaste, true);
  document.addEventListener("dragover", onDragOver, true);
  document.addEventListener("drop", onDrop, true);
  return () => {
    document.removeEventListener("paste", onPaste, true);
    document.removeEventListener("dragover", onDragOver, true);
    document.removeEventListener("drop", onDrop, true);
    if (lingering) clearTimeout(lingering);
  };
}

function splitFiles(data: DataTransfer): { images: File[]; others: File[] } {
  const images: File[] = [];
  const others: File[] = [];
  for (const item of Array.from(data.items)) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file) (item.type.startsWith("image/") ? images : others).push(file);
  }
  return { images, others };
}

async function filesToDrafts(files: File[]): Promise<DraftImage[]> {
  const drafts: DraftImage[] = [];
  for (const file of files) {
    const draft = await fileToDraft(file);
    if (draft) drafts.push(draft);
  }
  return drafts;
}

/**
 * Reads one file as a draft. A supported image over the size cap is shrunk and re-encoded rather
 * than refused, since a full-screen screenshot is exactly what people paste; anything it cannot
 * shrink keeps its bytes and is refused by the caller's validation.
 */
async function fileToDraft(file: File): Promise<DraftImage | null> {
  const data = await readBlobAsBase64(file);
  if (!data) return null;
  let image = { data, mimeType: file.type || "image/png", name: file.name || undefined };
  const supported = (IMAGE_ALLOWED_MIME_TYPES as readonly string[]).includes(image.mimeType);
  if (supported && base64ByteLength(data) > IMAGE_MAX_BYTES) {
    const shrunk = await shrink(file, image.mimeType);
    if (shrunk) image = { ...shrunk, name: image.name?.replace(/\.[^.]+$/, `.${shrunk.mimeType === "image/png" ? "png" : "jpg"}`) };
  }
  return {
    id: createId("img"),
    data: image.data,
    mimeType: image.mimeType,
    ...(image.name ? { name: image.name } : {}),
    byteLength: base64ByteLength(image.data),
  };
}

/** Scales the image down until it fits the cap: PNG first for crisp text, then JPEG. */
async function shrink(file: File, mimeType: string): Promise<{ data: string; mimeType: string } | null> {
  const element = await loadImage(file);
  if (!element) return null;
  const longest = Math.max(element.naturalWidth, element.naturalHeight);
  if (longest === 0) return null;
  for (const edge of SHRINK_EDGES) {
    const scale = Math.min(1, edge / longest);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(element.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(element.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) return null;
    const encodings: [string, number | undefined][] = [
      ...(mimeType === "image/png" ? [["image/png", undefined] as [string, undefined]] : []),
      ...JPEG_QUALITIES.map((quality) => ["image/jpeg", quality] as [string, number]),
    ];
    for (const [type, quality] of encodings) {
      context.clearRect(0, 0, canvas.width, canvas.height);
      if (type === "image/jpeg") {
        // JPEG has no alpha: paint white first, or transparent pixels turn black.
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, canvas.width, canvas.height);
      }
      context.drawImage(element, 0, 0, canvas.width, canvas.height);
      const url = canvas.toDataURL(type, quality);
      const data = url.slice(url.indexOf(",") + 1);
      if (url.startsWith(`data:${type}`) && base64ByteLength(data) <= IMAGE_MAX_BYTES) return { data, mimeType: type };
    }
  }
  return null;
}

function loadImage(file: File): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const element = document.createElement("img");
    element.onload = () => {
      URL.revokeObjectURL(url);
      resolve(element);
    };
    element.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    element.src = url;
  });
}

/** `accept` narrows the chooser to those types; null offers every file. */
function chooseFiles(accept: string | null): Promise<FileList | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    if (accept) input.accept = accept;
    input.multiple = true;
    input.style.position = "fixed";
    input.style.left = "-9999px";
    let settled = false;
    const finish = (value: FileList | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(value);
    };
    input.addEventListener("change", () => finish(input.files));
    // A cancelled chooser fires no `change`; `cancel` is not universal, so also settle on focus.
    input.addEventListener("cancel", () => finish(null));
    window.addEventListener("focus", () => setTimeout(() => finish(input.files), 300), { once: true });
    document.body.appendChild(input);
    input.click();
  });
}

function readBlobAsBase64(blob: Blob): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onerror = () => resolve(null);
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : null);
    };
    reader.readAsDataURL(blob);
  });
}
