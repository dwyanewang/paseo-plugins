import { PAGE_SIZE } from "./common";

export interface DiscoveryCursor {
  nextPage: number | null;
  firstPage?: string;
  lastPage?: string;
  restartAfterScan?: boolean;
}

export function discoveryCursor(): DiscoveryCursor {
  return { nextPage: 2 };
}

// Always refresh the newest page, then continue older pages over subsequent
// polls. A large repository is incomplete discovery, not a pagination error.
// Keep only cursors/fingerprints here; returned MR details are never cached.
export async function discover<T, R>(
  cursor: DiscoveryCursor,
  load: (page: number) => Promise<T[]>,
  key: (item: T) => string,
  match: (item: T) => Promise<R | null>,
): Promise<R | null> {
  const first = await load(1);
  const fingerprint = JSON.stringify(first.map(key));
  if (cursor.firstPage !== undefined && cursor.firstPage !== fingerprint) {
    if (cursor.nextPage === null) cursor.nextPage = 2;
    else cursor.restartAfterScan = true;
    // Inserts/updates shift page-number offsets. A page seen in the previous
    // poll can legitimately reappear; only compare pages from the new ordering.
    cursor.lastPage = undefined;
  }
  cursor.firstPage = fingerprint;
  if (first.length < PAGE_SIZE) {
    cursor.nextPage = null;
    cursor.lastPage = undefined;
    cursor.restartAfterScan = false;
  }
  for (const item of first) {
    const result = await match(item);
    if (result !== null) return result;
  }
  // Three list requests per state per poll, including the newest page.
  for (let reads = 1; reads < 3 && cursor.nextPage !== null; reads++) {
    const page = cursor.nextPage;
    const items = await load(page);
    const current = JSON.stringify(items.map(key));
    if (
      items.length >= PAGE_SIZE &&
      (current === fingerprint || current === cursor.lastPage)
    ) {
      throw new Error(
        "Codeup pagination repeated a full page without making progress",
      );
    }
    for (const item of items) {
      const result = await match(item);
      // Keep this page when a match is found. If that MR disappears later,
      // another matching request on the same page must remain discoverable.
      if (result !== null) return result;
    }
    if (items.length < PAGE_SIZE && cursor.restartAfterScan) {
      // Finish the current pass before restarting, so continuous updates don't
      // starve old MRs. The next pass also visits records moved behind page 1.
      cursor.nextPage = 2;
      cursor.lastPage = undefined;
      cursor.restartAfterScan = false;
    } else {
      cursor.nextPage = items.length < PAGE_SIZE ? null : page + 1;
      cursor.lastPage = current;
    }
  }
  return null;
}
