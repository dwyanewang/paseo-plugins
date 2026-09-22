import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createId } from "./shared/ids";
import { todoImages } from "./shared/images";
import { todoPrefs } from "./shared/prefs";
import { todoData } from "./shared/schema";
import { registerTodoHandlers } from "./server/handlers";
import { createTodoLogger } from "./server/log";
import { TodoReconciler } from "./server/reconcile";
import { TodoStore } from "./server/store";

/**
 * Daemon capability guard. The manifest admits compatible 0.8.x hosts, while this refuses to run
 * on a build that has not integrated the Todo host extensions into its branch.
 */
export function assertHostCapabilities(server: Partial<PluginServerContext>): void {
  if (!server.paseo || typeof server.registerSettings !== "function") {
    throw new Error("Todo requires a Paseo daemon build with server.paseo and settings document handles.");
  }
}

export default function contribute(server: PluginServerContext) {
  assertHostCapabilities(server);
  const document = server.registerSettings(todoData);
  if (!document || typeof document.read !== "function" || typeof document.update !== "function") {
    throw new Error("Todo requires registerSettings to return a settings handle with update().");
  }
  // Launch preferences and image bytes are client-owned; registering them only publishes the
  // read/write RPCs so any connected client can persist them directly.
  server.registerSettings(todoPrefs);
  server.registerSettings(todoImages);
  const log = createTodoLogger();
  const store = new TodoStore(document, {
    generateIncarnationId: () => createId("inc"),
    onCapacityRejected: ({ tier, afterBytes, limitBytes }) =>
      log.once(`capacity:${tier}`, "warn", "capacity_rejected", { tier, afterBytes, limitBytes }),
  });
  const reconciler = new TodoReconciler({
    paseo: server.paseo,
    store,
    on: server.on,
    log,
  });
  registerTodoHandlers({ server, paseo: server.paseo, store, reconciler, log });
  // Synchronous registration above; bootstrap runs asynchronously inside start().
  const stop = reconciler.start();
  return async () => {
    await stop();
  };
}
