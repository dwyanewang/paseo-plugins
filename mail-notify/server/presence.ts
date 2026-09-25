import { PRESENCE_WINDOW_MS } from "./constants";

export interface ClientPresenceLike {
  readonly appVisible: boolean;
  readonly lastActivityAt: string | null;
}

export interface PresenceLike {
  readonly userPresent: boolean;
  readonly clients?: readonly ClientPresenceLike[];
}

/**
 * Paseo's `userPresent` also counts an app sent to the background within the last three minutes,
 * which is exactly when a task launched from a phone that was then locked finishes. Mail is only
 * skipped while some app is in the foreground and was used within that window.
 */
export function isWatching(presence: PresenceLike, nowMs: number): boolean {
  if (!presence.clients) return presence.userPresent;
  return presence.clients.some((client) => {
    if (!client.appVisible || !client.lastActivityAt) return false;
    const activityMs = Date.parse(client.lastActivityAt);
    return Number.isFinite(activityMs) && nowMs - Math.min(activityMs, nowMs) <= PRESENCE_WINDOW_MS;
  });
}
