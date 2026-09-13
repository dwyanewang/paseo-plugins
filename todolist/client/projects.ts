import type { usePaseo } from "@getpaseo/plugin/client";
import { useEffect, useState } from "react";

type PaseoApi = ReturnType<typeof usePaseo>;

type ProjectUpdate = Parameters<Parameters<PaseoApi["projects"]["subscribe"]>[0]>[0];
type ProjectList = Awaited<ReturnType<PaseoApi["projects"]["list"]>>;
export type ProjectRecord = ProjectList["projects"][number];

export interface ProjectCache {
  status: "loading" | "ready" | "error";
  projects: Map<string, ProjectRecord>;
  error?: string;
}

function applyUpdate(projects: Map<string, ProjectRecord>, update: ProjectUpdate): Map<string, ProjectRecord> {
  const next = new Map(projects);
  if (update.kind === "upsert") next.set(update.project.projectId, update.project);
  else next.delete(update.projectId);
  return next;
}

/**
 * Subscribe first and buffer, list the complete snapshot, then replay the buffer in order. The
 * effect re-runs whenever the host API instance changes (host switch, reconnect) and cleans up on
 * unmount, so no event is lost and no event from another host is applied.
 */
export function useProjectCache(paseo: PaseoApi): ProjectCache {
  const [cache, setCache] = useState<ProjectCache>({ status: "loading", projects: new Map() });
  useEffect(() => {
    let cancelled = false;
    let listed = false;
    const buffer: ProjectUpdate[] = [];
    setCache({ status: "loading", projects: new Map() });
    const unsubscribe = paseo.projects.subscribe((update) => {
      if (cancelled) return;
      if (!listed) {
        buffer.push(update);
        return;
      }
      setCache((current) => ({ ...current, projects: applyUpdate(current.projects, update) }));
    });
    void paseo.projects
      .list()
      .then((result) => {
        if (cancelled) return;
        let projects = new Map(result.projects.map((project) => [project.projectId, project]));
        for (const update of buffer.splice(0)) projects = applyUpdate(projects, update);
        listed = true;
        setCache({ status: "ready", projects });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setCache({
          status: "error",
          projects: new Map(),
          error: error instanceof Error ? error.message : "Could not list projects.",
        });
      });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [paseo]);
  return cache;
}
