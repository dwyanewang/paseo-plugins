/**
 * Web/desktop-only helpers. Plugin client bundles also run on iOS and Android, where these DOM
 * APIs do not exist; every export here is therefore guarded by a runtime capability check and must
 * only be reached through a caller that tolerates a null (unavailable) result. This is the one file
 * the client DOM audit permits to touch `document`, `window`, and `FileReader`.
 */
import { base64ByteLength, IMAGE_ALLOWED_MIME_TYPES } from "../shared/limits";
import { createId } from "../shared/ids";
import type { DraftImage } from "./images";

/**
 * Opens the browser file chooser and returns the picked images as drafts with fresh ids. Returns
 * an empty list when the user cancels, and null when no chooser is available (native runtimes have
 * no DOM file input).
 */
export async function pickImageDraftsWeb(): Promise<DraftImage[] | null> {
  if (typeof document === "undefined" || typeof FileReader === "undefined") return null;
  const files = await chooseFiles();
  if (!files || files.length === 0) return [];
  const drafts: DraftImage[] = [];
  for (const file of Array.from(files)) {
    const data = await readFileAsBase64(file);
    if (!data) continue;
    drafts.push({
      id: createId("img"),
      data,
      mimeType: file.type || "image/png",
      ...(file.name ? { name: file.name } : {}),
      byteLength: base64ByteLength(data),
    });
  }
  return drafts;
}

function chooseFiles(): Promise<FileList | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = IMAGE_ALLOWED_MIME_TYPES.join(",");
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

function readFileAsBase64(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onerror = () => resolve(null);
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : null);
    };
    reader.readAsDataURL(file);
  });
}
