/**
 * Deterministic identity fingerprints. These are equality keys, not security digests: the same
 * inputs always produce the same string on every client and on the daemon.
 */

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

/** cyrb53: a small, well-distributed 53-bit string hash. */
function cyrb53(text: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const high = (h2 >>> 0).toString(16).padStart(8, "0");
  const low = (h1 >>> 0).toString(16).padStart(8, "0");
  return `${high}${low}`;
}

export function fingerprintOf(value: unknown): string {
  const text = stableStringify(value);
  return `${cyrb53(text, 1)}${cyrb53(text, 2)}`;
}

export interface RequestFingerprintInput {
  projectId: string;
  workItemId: string;
  attemptId: string;
  clientMessageId: string;
  labels: Readonly<Record<string, string>>;
  seedPrompt: string;
}

/**
 * Immutable launch identity shared by `launch.acquire` and `openAgentLaunch`. It covers the
 * project, the correlation labels, the stable message ID, and the seed prompt snapshot.
 */
export function computeRequestFingerprint(input: RequestFingerprintInput): string {
  return fingerprintOf({
    kind: "todo-launch-v1",
    projectId: input.projectId,
    workItemId: input.workItemId,
    attemptId: input.attemptId,
    clientMessageId: input.clientMessageId,
    labels: input.labels,
    seedPrompt: input.seedPrompt,
  });
}

export interface CreationFingerprintInput {
  id: string;
  projectId: string;
  title: string;
  details: string;
  defaultPrompt: string;
}

/** Immutable creation identity. Server timestamps and later edits never take part. */
export function computeCreationFingerprint(input: CreationFingerprintInput): string {
  return fingerprintOf({ kind: "todo-work-item-v1", ...input });
}
