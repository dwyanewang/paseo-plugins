export const PERMISSION_DELAY_MS = 20_000;
export const MERGE_WINDOW_MS = 5_000;
/** Background-work recheck when live agent/workspace updates are unavailable. */
export const BACKGROUND_RECHECK_MS = 60_000;
/** Safety-net recheck while live updates drive the wait; covers events lost across a reconnect. */
export const LIVE_RECHECK_MS = 300_000;
/** Coalesces a burst of live updates into one recheck. */
export const NUDGE_DEBOUNCE_MS = 1_000;
export const WAKE_GRACE_MS = 30_000;
/** Same window as Paseo's own push: activity within it on a visible app counts as present. */
export const PRESENCE_WINDOW_MS = 180_000;
