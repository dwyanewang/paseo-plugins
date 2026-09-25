/**
 * Field and document capacity limits.
 *
 * The capacity thresholds were frozen after the Phase E benchmark
 * (`npm run benchmark` → test/benchmark/capacity.ts). The benchmark measures the persisted
 * envelope `JSON.stringify({ version, values })` in UTF-8 bytes, which is the same measurement
 * the server applies before every commit, and estimates write amplification as
 * `business writes × connected clients × document bytes`.
 */
export const TITLE_MAX_CODE_POINTS = 200;
export const DETAILS_MAX_BYTES = 32 * 1024;
export const PROMPT_MAX_BYTES = 64 * 1024;
export const INITIATOR_LABEL_MAX_CODE_POINTS = 80;

/**
 * Image attachment limits. The bytes are stored as base64 inside the document, so they share the
 * capacity budget below; these field limits give an early, friendly error before a write is even
 * attempted, while the document capacity check remains the true ceiling.
 */
export const IMAGE_MAX_COUNT = 4;
/** Decoded bytes per image. Base64 inflates this by roughly a third on the wire and on disk. */
export const IMAGE_MAX_BYTES = 384 * 1024;
export const IMAGE_ALLOWED_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

/**
 * File attachments, such as documents. Their bytes go to the daemon host's disk, never into a
 * document, so only the reference counts against the capacity budget.
 */
export const FILE_MAX_COUNT = 10;
/** The host composer's cap for one uploaded file. */
export const FILE_MAX_BYTES = 50 * 1024 * 1024;
/** Decoded bytes per upload call: small enough for one message over a relayed, encrypted socket. */
export const FILE_CHUNK_BYTES = 256 * 1024;
export const FILE_NAME_MAX_CODE_POINTS = 200;

export const CAPACITY = {
  /** Ordinary create/edit/acquire growth stops here. */
  softLimitBytes: 512 * 1024,
  /** Best-effort budget above the soft limit for AgentLink, abandon, and retired-ID writes. */
  recoveryReserveBytes: 64 * 1024,
  /** Nothing grows past this; only strictly shrinking mutations may run above it. */
  absoluteLimitBytes: 1024 * 1024,
} as const;

/** Retired work-item tombstone ring, frozen with the capacity thresholds. */
export const RETIRED_RING_MAX_ENTRIES = 256;
export const RETIRED_RING_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export type CapacityKind = "user" | "recovery";
export type CapacityTier = "soft" | "reserve" | "absolute";

export interface CapacityDecision {
  allowed: boolean;
  tier?: CapacityTier;
  limitBytes?: number;
  beforeBytes: number;
  afterBytes: number;
}

export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      // Surrogate pair: one 4-byte sequence for both code units.
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

export function codePointLength(text: string): number {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

export function measureDocumentBytes(values: unknown, version: number): number {
  return utf8ByteLength(JSON.stringify({ version, values }));
}

/**
 * Admission control for one serialized commit. A write that does not grow the document is always
 * allowed below the absolute limit; above it, only a strictly shrinking write may proceed so a
 * recovery exit always exists.
 */
export function evaluateCapacity(input: {
  beforeBytes: number;
  afterBytes: number;
  kind: CapacityKind;
  limits?: typeof CAPACITY;
}): CapacityDecision {
  const limits = input.limits ?? CAPACITY;
  const { beforeBytes, afterBytes } = input;
  const grows = afterBytes > beforeBytes;
  if (afterBytes > limits.absoluteLimitBytes) {
    if (afterBytes < beforeBytes) return { allowed: true, beforeBytes, afterBytes };
    return {
      allowed: false,
      tier: "absolute",
      limitBytes: limits.absoluteLimitBytes,
      beforeBytes,
      afterBytes,
    };
  }
  if (!grows) return { allowed: true, beforeBytes, afterBytes };
  if (input.kind === "user" && afterBytes > limits.softLimitBytes) {
    return {
      allowed: false,
      tier: "soft",
      limitBytes: limits.softLimitBytes,
      beforeBytes,
      afterBytes,
    };
  }
  const reserveCeiling = limits.softLimitBytes + limits.recoveryReserveBytes;
  if (input.kind === "recovery" && afterBytes > reserveCeiling) {
    return {
      allowed: false,
      tier: "reserve",
      limitBytes: reserveCeiling,
      beforeBytes,
      afterBytes,
    };
  }
  return { allowed: true, beforeBytes, afterBytes };
}

export type FieldError =
  | { field: "title"; reason: "empty" | "too_long" }
  | { field: "details"; reason: "too_long" }
  | { field: "defaultPrompt"; reason: "too_long" }
  | { field: "seedPrompt"; reason: "empty" | "too_long" }
  | { field: "initiatorLabel"; reason: "too_long" }
  | { field: "images"; reason: "too_many" | "too_large" | "unsupported_type" | "empty_data" }
  | { field: "files"; reason: "too_many" | "too_large" | "invalid_name" };

export function validateWorkItemFields(input: {
  title?: string;
  details?: string;
  defaultPrompt?: string;
}): FieldError | null {
  if (input.title !== undefined) {
    if (input.title.trim().length === 0) return { field: "title", reason: "empty" };
    if (codePointLength(input.title) > TITLE_MAX_CODE_POINTS) {
      return { field: "title", reason: "too_long" };
    }
  }
  if (input.details !== undefined && utf8ByteLength(input.details) > DETAILS_MAX_BYTES) {
    return { field: "details", reason: "too_long" };
  }
  if (input.defaultPrompt !== undefined && utf8ByteLength(input.defaultPrompt) > PROMPT_MAX_BYTES) {
    return { field: "defaultPrompt", reason: "too_long" };
  }
  return null;
}

/** Decoded byte length of a base64 string, without allocating the decoded buffer. */
export function base64ByteLength(base64: string): number {
  const clean = base64.replace(/=+$/, "");
  return Math.floor((clean.length * 3) / 4);
}

export function validateWorkItemImages(
  images: readonly { mimeType: string; byteLength: number }[] | undefined,
): FieldError | null {
  if (!images || images.length === 0) return null;
  if (images.length > IMAGE_MAX_COUNT) return { field: "images", reason: "too_many" };
  for (const image of images) {
    if (image.byteLength <= 0) return { field: "images", reason: "empty_data" };
    if (!(IMAGE_ALLOWED_MIME_TYPES as readonly string[]).includes(image.mimeType)) {
      return { field: "images", reason: "unsupported_type" };
    }
    if (image.byteLength > IMAGE_MAX_BYTES) {
      return { field: "images", reason: "too_large" };
    }
  }
  return null;
}

export function validateWorkItemFiles(
  files: readonly { name: string; byteLength: number }[] | undefined,
): FieldError | null {
  if (!files || files.length === 0) return null;
  if (files.length > FILE_MAX_COUNT) return { field: "files", reason: "too_many" };
  for (const file of files) {
    if (file.name.trim().length === 0 || codePointLength(file.name) > FILE_NAME_MAX_CODE_POINTS) {
      return { field: "files", reason: "invalid_name" };
    }
    if (file.byteLength > FILE_MAX_BYTES) return { field: "files", reason: "too_large" };
  }
  return null;
}

export function validateSeedPrompt(seedPrompt: string): FieldError | null {
  if (seedPrompt.trim().length === 0) return { field: "seedPrompt", reason: "empty" };
  return utf8ByteLength(seedPrompt) > PROMPT_MAX_BYTES
    ? { field: "seedPrompt", reason: "too_long" }
    : null;
}

export function validateInitiatorLabel(label: string): FieldError | null {
  return codePointLength(label) > INITIATOR_LABEL_MAX_CODE_POINTS
    ? { field: "initiatorLabel", reason: "too_long" }
    : null;
}
