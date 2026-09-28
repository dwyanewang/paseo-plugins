import { PRESENCE_WINDOW_MS } from "./constants";

export interface ClientPresenceLike {
  readonly deviceType: "web" | "mobile";
  readonly appVisible: boolean;
  readonly lastActivityAt: string | null;
}

export interface PresenceLike {
  readonly userPresent: boolean;
  readonly clients?: readonly ClientPresenceLike[];
}

function activityAgeMs(client: ClientPresenceLike, nowMs: number): number | null {
  if (!client.lastActivityAt) return null;
  const activityMs = Date.parse(client.lastActivityAt);
  return Number.isFinite(activityMs) ? nowMs - Math.min(activityMs, nowMs) : null;
}

/**
 * Paseo's `userPresent` counts any client used within the last three minutes. For the phone app
 * that includes one sent to the background or locked moments ago, which is exactly when a task
 * launched from the phone finishes, so a phone only counts while the app is in the foreground.
 * The desktop app reports keyboard and mouse input anywhere on the computer, and Windows reports
 * its window hidden whenever other windows cover it, so web and desktop clients count on recent
 * activity alone, as they do for Paseo's own push.
 */
export function isWatching(presence: PresenceLike, nowMs: number): boolean {
  if (!presence.clients) return presence.userPresent;
  return presence.clients.some((client) => {
    if (client.deviceType === "mobile" && !client.appVisible) return false;
    const ageMs = activityAgeMs(client, nowMs);
    return ageMs !== null && ageMs <= PRESENCE_WINDOW_MS;
  });
}

/** One line per connected app, for tracing why a notification was sent. */
export function describeClients(presence: PresenceLike, nowMs: number): string[] {
  return (presence.clients ?? []).map((client) => {
    const ageMs = activityAgeMs(client, nowMs);
    const activity = ageMs === null ? "无操作记录" : `${Math.round(ageMs / 1000)} 秒前有操作`;
    return `${client.deviceType === "mobile" ? "手机" : "桌面/网页"}·${client.appVisible ? "可见" : "隐藏"}·${activity}`;
  });
}
