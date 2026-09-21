import { useEffect } from "react";

/**
 * A command can open a surface, but it cannot open a dialog inside one. This hands the request
 * across: the command records what it wants, the surface picks it up on its next render.
 *
 * The request is consumed once, so reopening the board later does not reopen the editor.
 */
let pending: { projectId: string | null } | null = null;
const listeners = new Set<() => void>();

export function requestNewItem(projectId: string | null): void {
  pending = { projectId };
  for (const listener of listeners) listener();
}

export function usePendingNewItem(open: (projectId: string | null) => void): void {
  useEffect(() => {
    const take = () => {
      if (!pending) return;
      const request = pending;
      pending = null;
      open(request.projectId);
    };
    take();
    listeners.add(take);
    return () => {
      listeners.delete(take);
    };
  }, [open]);
}
