/**
 * Ranks are zero-padded decimal strings compared lexicographically within one project. Gaps of
 * RANK_STEP leave room for insertion; when two neighbours have no gap, the caller rebalances the
 * whole project inside the same document update.
 */
export const RANK_WIDTH = 12;
export const RANK_STEP = 1_000_000;

export function rankFromInteger(value: number): string {
  return String(Math.max(0, Math.floor(value))).padStart(RANK_WIDTH, "0");
}

export function rankToInteger(rank: string): number {
  const parsed = Number.parseInt(rank, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function compareRanks(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Returns a rank strictly between the neighbours, or null when the gap is exhausted. */
export function rankBetween(before: string | undefined, after: string | undefined): string | null {
  if (before === undefined && after === undefined) return rankFromInteger(RANK_STEP);
  if (before === undefined) {
    const upper = rankToInteger(after!);
    if (upper <= 1) return null;
    return rankFromInteger(Math.floor(upper / 2));
  }
  if (after === undefined) {
    const lower = rankToInteger(before);
    return rankFromInteger(lower + RANK_STEP);
  }
  const lower = rankToInteger(before);
  const upper = rankToInteger(after);
  if (upper - lower < 2) return null;
  return rankFromInteger(lower + Math.floor((upper - lower) / 2));
}

/** Evenly spaced ranks for an ordered list of IDs. */
export function rebalancedRanks(orderedIds: readonly string[]): Map<string, string> {
  const ranks = new Map<string, string>();
  orderedIds.forEach((id, index) => ranks.set(id, rankFromInteger((index + 1) * RANK_STEP)));
  return ranks;
}
