import { useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useCallback, useMemo } from "react";
import type { z } from "zod";
import {
  abandonLaunch,
  acquireLaunch,
  checkLaunch,
  createWorkItem,
  ensureDocument,
  forgetAttempt,
  moveWorkItem,
  purgeWorkItem,
  rebindWorkItemProject,
  reportLaunchProgress,
  setWorkItemArchived,
  updateWorkItem,
  type TodoError,
} from "../shared/contracts";
import type { WorkItem, WorkItemPriority, WorkItemStatus } from "../shared/schema";
import { describeTodoError, useTodoInvalidate } from "./data";
import type { WorkItemIdentity } from "./identity";
import type { LaunchRpcs } from "./launch";

type Output<Contract extends { output: z.ZodType }> = z.output<Contract["output"]>;

export interface TodoActions {
  incarnationId: string;
  reload: () => Promise<void>;
  launchRpcs: LaunchRpcs;
  ensure: () => Promise<Output<typeof ensureDocument>>;
  /** `identity` comes from the caller so a retry of the same draft reuses it; see `identity.ts`. */
  create: (
    input: { projectId: string; projectNameSnapshot: string; projectRootSnapshot?: string; title: string; details: string; defaultPrompt: string; status?: "backlog" | "todo"; priority?: WorkItemPriority },
    identity: WorkItemIdentity,
  ) => Promise<WorkItem | null>;
  update: (item: WorkItem, patch: { title?: string; details?: string; defaultPrompt?: string; priority?: WorkItemPriority }) => Promise<boolean>;
  /** Null when the write failed (already reported). `previousStatus` is where the card really was. */
  move: (item: WorkItem, status: WorkItemStatus) => Promise<{ previousStatus: WorkItemStatus } | null>;
  setArchived: (item: WorkItem, archived: boolean) => Promise<boolean>;
  purge: (item: WorkItem, force: boolean) => Promise<boolean>;
  rebind: (item: WorkItem, project: { projectId: string; projectNameSnapshot: string; projectRootSnapshot?: string }) => Promise<boolean>;
  abandon: (input: { workItemId: string; attemptId: string; generation: number; certainty: "not_submitted" | "outcome_unknown_confirmed" }) => Promise<boolean>;
  forget: (input: { workItemId: string; attemptId: string }) => Promise<boolean>;
  check: (workItemId: string, attemptId?: string) => Promise<CheckSummary | null>;
}

/** What a manual check actually found, so the surface can say so instead of staying silent. */
export interface CheckSummary {
  checkedAgentCount: number;
  linkedAgentCount: number;
}

/** Every write goes through a typed RPC with the current incarnation, then invalidates the replica. */
export function useTodoActions(input: { incarnationId: string; reload: () => Promise<void> }): TodoActions {
  const toast = useToast();
  const invalidate = useTodoInvalidate();
  const rpcEnsure = useRpc(ensureDocument);
  const rpcCreate = useRpc(createWorkItem);
  const rpcUpdate = useRpc(updateWorkItem);
  const rpcRebind = useRpc(rebindWorkItemProject);
  const rpcMove = useRpc(moveWorkItem);
  const rpcArchived = useRpc(setWorkItemArchived);
  const rpcPurge = useRpc(purgeWorkItem);
  const rpcAcquire = useRpc(acquireLaunch);
  const rpcProgress = useRpc(reportLaunchProgress);
  const rpcAbandon = useRpc(abandonLaunch);
  const rpcCheck = useRpc(checkLaunch);
  const rpcForget = useRpc(forgetAttempt);
  const { incarnationId, reload } = input;

  const finish = useCallback(
    async <Result extends { status: string }>(promise: Promise<Result>): Promise<Result | null> => {
      try {
        const result = await promise;
        await invalidate();
        if (result.status !== "ok") {
          toast.error(describeTodoError(result as unknown as TodoError));
          if (result.status === "stale_document") await reload();
          return null;
        }
        return result;
      } catch (error) {
        // Transport failure: the request may or may not have applied. Reload rather than guess.
        toast.error(error instanceof Error ? error.message : "Request failed. Reload to see the current state.");
        await reload();
        return null;
      }
    },
    [invalidate, reload, toast],
  );

  return useMemo<TodoActions>(
    () => ({
      incarnationId,
      reload,
      launchRpcs: {
        acquire: (request) => rpcAcquire(request),
        progress: (request) => rpcProgress(request),
        abandon: (request) => rpcAbandon(request),
      },
      ensure: () => rpcEnsure({}),
      async create(request, identity) {
        const result = await finish(
          rpcCreate({ expectedIncarnationId: incarnationId, id: identity.id, creationFingerprint: identity.creationFingerprint, ...request }),
        );
        return result && result.status === "ok" ? result.workItem : null;
      },
      async update(item, patch) {
        const result = await finish(rpcUpdate({ expectedIncarnationId: incarnationId, id: item.id, expectedVersion: item.version, patch }));
        return result?.status === "ok";
      },
      async move(item, status) {
        const result = await finish(rpcMove({ expectedIncarnationId: incarnationId, id: item.id, status }));
        return result && result.status === "ok" ? { previousStatus: result.previousStatus } : null;
      },
      async setArchived(item, archived) {
        const result = await finish(rpcArchived({ expectedIncarnationId: incarnationId, id: item.id, expectedVersion: item.version, archived }));
        return result?.status === "ok";
      },
      async purge(item, force) {
        const result = await finish(rpcPurge({ expectedIncarnationId: incarnationId, id: item.id, expectedVersion: item.version, confirm: true, force }));
        return result?.status === "ok";
      },
      async rebind(item, project) {
        const result = await finish(rpcRebind({ expectedIncarnationId: incarnationId, id: item.id, expectedVersion: item.version, ...project }));
        return result?.status === "ok";
      },
      async abandon(request) {
        const result = await finish(rpcAbandon({ expectedIncarnationId: incarnationId, ...request }));
        return result?.status === "ok";
      },
      async forget(request) {
        const result = await finish(rpcForget({ expectedIncarnationId: incarnationId, ...request }));
        return result?.status === "ok";
      },
      async check(workItemId, attemptId) {
        // Manual check: a bounded daemon-side reconcile, then an explicit reload so the surface
        // shows what the reconcile just committed.
        const result = await finish(rpcCheck({ expectedIncarnationId: incarnationId, workItemId, ...(attemptId ? { attemptId } : {}) }));
        await reload();
        if (result?.status !== "ok") return null;
        return { checkedAgentCount: result.enqueuedAgentIds.length, linkedAgentCount: result.links.length };
      },
    }),
    [finish, incarnationId, reload, rpcAbandon, rpcAcquire, rpcArchived, rpcCheck, rpcCreate, rpcEnsure, rpcForget, rpcMove, rpcProgress, rpcPurge, rpcRebind, rpcUpdate],
  );
}
