import type { PluginServerContext } from "@getpaseo/plugin/server";

type PaseoApi = PluginServerContext["paseo"];
import {
  abandonLaunch,
  acquireLaunch,
  checkLaunch,
  createWorkItem,
  documentStatus,
  ensureDocument,
  forgetAttempt,
  purgeWorkItem,
  rebindWorkItemProject,
  reorderWorkItem,
  reportLaunchProgress,
  setWorkItemArchived,
  setWorkItemStatus,
  updateWorkItem,
  type TodoError,
} from "../shared/contracts";
import type { TodoLogger } from "./log";
import {
  abandonLaunchMutation,
  acquireLaunchMutation,
  createWorkItemMutation,
  forgetAttemptMutation,
  linksForWorkItem,
  purgeWorkItemMutation,
  rebindWorkItemProjectMutation,
  reorderWorkItemMutation,
  reportLaunchProgressMutation,
  setWorkItemArchivedMutation,
  setWorkItemStatusMutation,
  updateWorkItemMutation,
} from "./mutations";
import type { TodoReconciler } from "./reconcile";
import type { MutateResult, MutationOutcome, TodoStore } from "./store";
import type { TodoDocument } from "../shared/schema";

const ACQUIRE_REFRESH_TIMEOUT_MS = 5_000;
/** A manual check is a foreground action: wait for the refresh it triggered before answering. */
const CHECK_REFRESH_TIMEOUT_MS = 8_000;

export interface HandlerDeps {
  server: Pick<PluginServerContext, "handle">;
  paseo: PaseoApi;
  store: TodoStore;
  reconciler: TodoReconciler;
  log: TodoLogger;
}

function toError(result: Exclude<MutateResult<unknown>, { status: "ok" }>): TodoError {
  return {
    status: result.status,
    message: result.message,
    ...(result.details ? { details: result.details } : {}),
  };
}

export function registerTodoHandlers(deps: HandlerDeps): void {
  const { server, store, reconciler, log } = deps;

  async function run<Result>(
    name: string,
    expectedIncarnationId: string,
    kind: "user" | "recovery",
    mutate: (document: TodoDocument, now: string) => MutationOutcome<Result>,
  ): Promise<{ status: "ok"; result: Result; seq: number } | TodoError> {
    const outcome = await store.mutate({ expectedIncarnationId, kind, mutate });
    if (outcome.status !== "ok") {
      log.info("rpc_rejected", { rpc: name, code: outcome.status });
      return toError(outcome);
    }
    if (outcome.changed) reconciler.noteDocument(outcome.document);
    return { status: "ok" as const, result: outcome.result, seq: outcome.seq };
  }

  server.handle(ensureDocument, async () => {
    const ensured = await store.ensureIncarnation();
    if (ensured.status !== "ok") return toError(ensured);
    reconciler.noteDocument(ensured.document);
    return {
      status: "ok" as const,
      incarnationId: ensured.document.incarnationId,
      seq: ensured.document.seq,
    };
  });

  server.handle(documentStatus, async () => ({
    status: "ok" as const,
    incarnationId: reconciler.currentIncarnationId,
    degraded: reconciler.degraded,
    lastReconcileAt: reconciler.lastReconcile,
    pendingRefreshCount: reconciler.pendingRefreshCount,
  }));

  server.handle(createWorkItem, async (input) => {
    const outcome = await run("work-items.create", input.expectedIncarnationId, "user", (document, now) =>
      createWorkItemMutation(document, input, now),
    );
    if (outcome.status !== "ok") return outcome;
    return { status: "ok" as const, ...outcome.result, seq: outcome.seq };
  });

  server.handle(updateWorkItem, async (input) => {
    const outcome = await run("work-items.update", input.expectedIncarnationId, "user", (document, now) =>
      updateWorkItemMutation(document, input, now),
    );
    if (outcome.status !== "ok") return outcome;
    return { status: "ok" as const, ...outcome.result, seq: outcome.seq };
  });

  server.handle(reorderWorkItem, async (input) => {
    const outcome = await run("work-items.reorder", input.expectedIncarnationId, "user", (document, now) =>
      reorderWorkItemMutation(document, input, now),
    );
    if (outcome.status !== "ok") return outcome;
    return { status: "ok" as const, ...outcome.result, seq: outcome.seq };
  });

  server.handle(rebindWorkItemProject, async (input) => {
    const outcome = await run(
      "work-items.rebind-project",
      input.expectedIncarnationId,
      "user",
      (document, now) => rebindWorkItemProjectMutation(document, input, now),
    );
    if (outcome.status !== "ok") return outcome;
    return { status: "ok" as const, ...outcome.result, seq: outcome.seq };
  });

  server.handle(setWorkItemStatus, async (input) => {
    const outcome = await run("work-items.set-status", input.expectedIncarnationId, "user", (document, now) =>
      setWorkItemStatusMutation(document, input, now),
    );
    if (outcome.status !== "ok") return outcome;
    return { status: "ok" as const, ...outcome.result, seq: outcome.seq };
  });

  server.handle(setWorkItemArchived, async (input) => {
    const outcome = await run(
      "work-items.set-archived",
      input.expectedIncarnationId,
      "user",
      (document, now) => setWorkItemArchivedMutation(document, input, now),
    );
    if (outcome.status !== "ok") return outcome;
    return { status: "ok" as const, ...outcome.result, seq: outcome.seq };
  });

  server.handle(purgeWorkItem, async (input) => {
    const outcome = await run("work-items.purge", input.expectedIncarnationId, "recovery", (document, now) =>
      purgeWorkItemMutation(document, input, now),
    );
    if (outcome.status !== "ok") return outcome;
    return { status: "ok" as const, seq: outcome.seq };
  });

  server.handle(acquireLaunch, async (input) => {
    // Fence early so a stale client never triggers refresh work, then re-check inside the update.
    const current = await store.read();
    if (current.status !== "ok") return toError(current);
    if (current.document.incarnationId !== input.expectedIncarnationId) {
      return { status: "stale_document" as const, message: "The Todo document was reset. Reload before continuing." };
    }
    const item = current.document.workItems[input.workItemId];
    if (!item) return { status: "not_found" as const, message: "The work item no longer exists." };
    const knownIds = linksForWorkItem(current.document, item.id).map((link) => link.agentId);
    if (knownIds.length > 0) await reconciler.awaitRefresh(knownIds, ACQUIRE_REFRESH_TIMEOUT_MS);
    const projectAvailable = await isProjectAvailable(deps.paseo, item.projectId);
    const outcome = await run("launch.acquire", input.expectedIncarnationId, "user", (document, now) =>
      acquireLaunchMutation(document, { ...input, projectAvailable }, now),
    );
    if (outcome.status !== "ok") return outcome;
    log.info("claim_acquired", {
      workItemId: item.id,
      attemptId: outcome.result.attempt.id,
      generation: outcome.result.claim.generation,
      created: outcome.result.created,
    });
    return { status: "ok" as const, ...outcome.result, seq: outcome.seq };
  });

  server.handle(reportLaunchProgress, async (input) => {
    const outcome = await run("launch.progress", input.expectedIncarnationId, "recovery", (document, now) =>
      reportLaunchProgressMutation(document, input, now),
    );
    if (outcome.status !== "ok") return outcome;
    if (input.agentId) reconciler.enqueueRefresh(input.agentId, "progress_agent_created");
    log.info("launch_progress", {
      attemptId: input.attemptId,
      facet: input.facet,
      factVersion: input.factVersion,
      changed: outcome.seq,
    });
    return { status: "ok" as const, ...outcome.result, seq: outcome.seq };
  });

  server.handle(abandonLaunch, async (input) => {
    const outcome = await run("launch.abandon", input.expectedIncarnationId, "recovery", (document, now) =>
      abandonLaunchMutation(document, input, now),
    );
    if (outcome.status !== "ok") return outcome;
    log.info("launch_abandoned", {
      workItemId: input.workItemId,
      attemptId: input.attemptId,
      certainty: input.certainty,
    });
    return { status: "ok" as const, ...outcome.result, seq: outcome.seq };
  });

  server.handle(forgetAttempt, async (input) => {
    const outcome = await run("launch.forget", input.expectedIncarnationId, "recovery", (document, now) =>
      forgetAttemptMutation(document, input, now),
    );
    if (outcome.status !== "ok") return outcome;
    log.info("attempt_forgotten", {
      workItemId: input.workItemId,
      attemptId: input.attemptId,
      removedAgentIds: outcome.result.removedAgentIds.length,
    });
    return { status: "ok" as const, ...outcome.result, seq: outcome.seq };
  });

  server.handle(checkLaunch, async (input) => {
    const current = await store.read();
    if (current.status !== "ok") return toError(current);
    if (current.document.incarnationId !== input.expectedIncarnationId) {
      return { status: "stale_document" as const, message: "The Todo document was reset. Reload before continuing." };
    }
    const enqueuedAgentIds = await reconciler.checkWorkItem(input.workItemId);
    if (enqueuedAgentIds.length > 0) {
      await reconciler.awaitRefresh(enqueuedAgentIds, CHECK_REFRESH_TIMEOUT_MS);
    }
    // Re-read: the refresh above commits through the same store, so this is the state the client
    // will see after it reloads.
    const refreshed = await store.read();
    const settled = refreshed.status === "ok" ? refreshed.document : current.document;
    const attempt = input.attemptId ? settled.attempts[input.attemptId] : undefined;
    const claim = settled.claims[input.workItemId];
    return {
      status: "ok" as const,
      ...(attempt ? { attempt } : {}),
      ...(claim ? { claim } : {}),
      links: linksForWorkItem(settled, input.workItemId),
      enqueuedAgentIds,
    };
  });
}

async function isProjectAvailable(paseo: PaseoApi, projectId: string): Promise<boolean> {
  try {
    const result = await paseo.projects.list();
    return result.projects.some((project) => project.projectId === projectId);
  } catch {
    // Transport failure is not a business conflict; do not block on it.
    return true;
  }
}
