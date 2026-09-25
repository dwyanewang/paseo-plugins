import { pickFiles as pickHostFiles } from "@getpaseo/plugin/client/react-native";
import type { z } from "zod";
import type { WorkItemFileInput, writeFile } from "../shared/contracts";
import { FILE_CHUNK_BYTES, FILE_MAX_BYTES, FILE_MAX_COUNT, type FieldError } from "../shared/limits";
import type { TodoFileRef } from "../shared/schema";
import { canTakeImagesWeb, pickFilesWeb } from "./web";

/** A file the platform handed over, read piece by piece so a large one never sits in memory whole. */
export interface PickedFile {
  name: string;
  /** Empty when the platform could not tell. */
  mimeType: string;
  size: number;
  /** Base64 of `length` bytes from `offset`, or null when the file can no longer be read. */
  read: (offset: number, length: number) => Promise<string | null>;
}

/** A file attached to the text box: uploading to the daemon host, or already there. */
export interface DraftFile {
  id: string;
  name: string;
  mimeType: string;
  byteLength: number;
  /** Bytes the host holds so far. */
  uploaded: number;
  ready: boolean;
}

/** Undefined on hosts that predate the plugin file chooser. */
const hostPickFiles = typeof pickHostFiles === "function" ? pickHostFiles : null;

/** Whether this runtime can choose files other than images: the host's chooser, or the browser's. */
export function canPickFiles(): boolean {
  return hostPickFiles !== null || canTakeImagesWeb();
}

/**
 * Opens the platform chooser; an empty list when cancelled, null where there is none. The host's
 * chooser is the only one on iOS and Android; older hosts fall back to the browser's.
 */
export async function pickFiles(): Promise<PickedFile[] | null> {
  if (!hostPickFiles) return pickFilesWeb();
  const picked = await hostPickFiles({ multiple: true });
  return picked.map((file) => ({
    name: file.fileName || "file",
    mimeType: file.mimeType,
    size: file.byteLength,
    read: (offset, length) => file.readBase64(offset, length).catch(() => null),
  }));
}

export function refToDraftFile(ref: TodoFileRef): DraftFile {
  return { ...ref, uploaded: ref.byteLength, ready: true };
}

export function draftToFileRef(file: DraftFile): WorkItemFileInput {
  return { id: file.id, name: file.name, mimeType: file.mimeType, byteLength: file.byteLength };
}

export function describeFileError(reason: Extract<FieldError, { field: "files" }>["reason"]): string {
  switch (reason) {
    case "too_many":
      return `Up to ${FILE_MAX_COUNT} files per card.`;
    case "too_large":
      return `Files can be up to ${formatBytes(FILE_MAX_BYTES)}.`;
    default:
      return "That file has a name Todo cannot keep.";
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/** What kind of file it is, in a word: the extension, else the MIME subtype. */
export function fileKind(file: { name: string; mimeType: string }): string {
  const dot = file.name.lastIndexOf(".");
  const extension = dot > 0 ? file.name.slice(dot + 1) : "";
  if (extension && extension.length <= 8) return extension.toUpperCase();
  const subtype = file.mimeType.split("/")[1];
  return subtype && subtype.length <= 12 ? subtype.toUpperCase() : "File";
}

type WriteRpc = (input: z.input<typeof writeFile.input>) => Promise<z.output<typeof writeFile.output>>;

/** Consecutive failed pieces before an upload gives up. */
const ATTEMPTS = 3;

/**
 * Sends `file` to the daemon host under `id`, one piece per call, reporting the bytes stored so
 * far. A piece whose reply was lost is sent again; if it had landed, the server says where the file
 * really ends and the upload carries on from there. Rejects with a message to show, and also once
 * `stopped` says the file is no longer wanted.
 */
export async function uploadFile(
  file: PickedFile,
  id: string,
  write: WriteRpc,
  onProgress: (uploaded: number) => void,
  stopped: () => boolean = () => false,
): Promise<void> {
  let offset = 0;
  let failures = 0;
  for (;;) {
    if (stopped()) throw new Error(`The upload of ${file.name} was stopped.`);
    const length = Math.min(FILE_CHUNK_BYTES, file.size - offset);
    const data = length > 0 ? await file.read(offset, length) : "";
    if (data === null) throw new Error(`Could not read ${file.name}.`);
    let result: Awaited<ReturnType<WriteRpc>> | null = null;
    try {
      result = await write({ id, name: file.name, size: file.size, offset, data });
    } catch {
      // A lost reply: the piece may or may not have landed. Sending it again tells.
    }
    if (result?.status === "ok") {
      failures = 0;
      offset = result.received;
      onProgress(offset);
      if (result.file) return;
      continue;
    }
    const received = result?.status === "conflict" ? result.details?.received : undefined;
    if (typeof received === "number" && received !== offset && received <= file.size) {
      // The server holds a different amount than this side thought: carry on from there.
      offset = received;
      continue;
    }
    failures += 1;
    if (result !== null || failures >= ATTEMPTS) throw new Error(result?.message ?? `Could not upload ${file.name}.`);
  }
}
