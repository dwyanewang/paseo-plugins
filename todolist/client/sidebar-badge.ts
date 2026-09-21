import { useEffect } from "react";

type BadgeSetter = (count: number | null) => void;

let setter: BadgeSetter | null = null;
let published: number | null = null;

/**
 * Wires the contribution's badge setter, which lives outside React, to the components that know
 * the count. Called once from `contribute`, and cleared when the plugin unloads.
 */
export function registerSidebarBadgeSetter(next: BadgeSetter | null): void {
  setter = next;
  published = null;
}

/**
 * Publishes the host-wide count from whichever Todo component is mounted.
 *
 * The plugin SDK has no way to read the settings document outside React, so the count comes from
 * the components that already read it — the header glyph, the surface, the workspace panel. They
 * all compute the same number, and only a change is sent on, so several mounted at once cost one
 * host call between them.
 */
export function useSidebarBadge(count: number): void {
  useEffect(() => {
    if (!setter || published === count) return;
    published = count;
    setter(count > 0 ? count : null);
  }, [count]);
}
