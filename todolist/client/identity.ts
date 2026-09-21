import { computeCreationFingerprint } from "../shared/fingerprint";
import { createId } from "../shared/ids";

export interface WorkItemIdentity {
  id: string;
  creationFingerprint: string;
}

/** The fields a creation fingerprint is computed from. */
export interface WorkItemDraft {
  projectId: string;
  title: string;
  details: string;
  defaultPrompt: string;
}

/** A resolved identity, kept by the editor so a retry of the same draft reuses it. */
export interface DraftIdentity {
  key: string;
  identity: WorkItemIdentity;
}

function draftKey(draft: WorkItemDraft): string {
  return JSON.stringify([draft.projectId, draft.title, draft.details, draft.defaultPrompt]);
}

/**
 * Identity for a create request, stable while the draft is.
 *
 * Create is idempotent on `id` plus `creationFingerprint`, so a retry after a lost reply must send
 * the identity the first request used — a fresh ID would make a second card out of one submission.
 * Editing the draft and submitting again is a different card, and a new ID: the same ID with
 * different content is what the daemon rejects as an ID conflict.
 */
export function resolveDraftIdentity(previous: DraftIdentity | null, draft: WorkItemDraft): DraftIdentity {
  const key = draftKey(draft);
  if (previous && previous.key === key) return previous;
  const id = createId("wi");
  return {
    key,
    identity: {
      id,
      creationFingerprint: computeCreationFingerprint({
        id,
        projectId: draft.projectId,
        title: draft.title,
        details: draft.details,
        defaultPrompt: draft.defaultPrompt,
      }),
    },
  };
}
