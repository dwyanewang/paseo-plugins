import type { PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { addTodoCommands } from "./client/commands";
import { TodoHeaderIcon, TodoHeaderPanel } from "./client/header-button";
import { TodoPanel } from "./client/panel";
import { registerSidebarBadgeSetter } from "./client/sidebar-badge";
import { TodoSettingsScreen } from "./client/settings-screen";
import { TodoSurface } from "./client/surface";

/**
 * The header panel: no title row over it on phones, since the box on top already says what it is,
 * and room on wide screens for the new-item box's tool row on one line. Hosts that predate these
 * options ignore them.
 */
const PANEL = { kind: "popover" as const, Content: TodoHeaderPanel, sheetTitle: false as const, width: 560 };

/**
 * A header button belongs to one workspace, so the set has to follow the workspaces the host
 * knows: list once, then keep up with the subscription. Registrations are kept stable — the count
 * and the dot are drawn by the icon component, which re-renders on its own, because re-registering
 * a button closes the panel a user may have open.
 */
function trackWorkspaceButtons(client: PluginClientContext): () => void {
  const buttons = new Map<string, PluginButtonRegistration>();
  const add = (workspaceId: string) => {
    if (buttons.has(workspaceId)) return;
    buttons.set(
      workspaceId,
      client.addHeaderButton({
        id: "todo",
        workspaceId,
        button: {
          title: "Todo",
          icon: TodoHeaderIcon,
          behavior: PANEL,
        },
      }),
    );
  };
  const remove = (workspaceId: string) => {
    buttons.get(workspaceId)?.remove();
    buttons.delete(workspaceId);
  };
  let disposed = false;
  // Subscribe before listing, so a workspace created during the list is not missed.
  const unsubscribe = client.paseo.workspaces.subscribe((update) => {
    if (disposed) return;
    if (update.kind === "upsert" && !update.workspace.archivingAt) add(update.workspace.id);
    else if (update.kind === "upsert") remove(update.workspace.id);
    else remove(update.id);
  });
  void client.paseo.workspaces
    .list({ page: { limit: 200 } })
    .then((result) => {
      if (disposed) return;
      for (const workspace of result.entries) if (!workspace.archivingAt) add(workspace.id);
    })
    .catch(() => {
      // Without the list the buttons only appear for workspaces the subscription reports later.
    });
  return () => {
    disposed = true;
    unsubscribe();
    for (const registration of buttons.values()) registration.remove();
    buttons.clear();
  };
}

export default function contribute(client: PluginClientContext) {
  client.addSurface("todo", TodoSurface);
  client.addSidebarItem({ id: "todo", title: "Todo", icon: "ListChecks", surface: "todo" });
  client.addWorkspacePanel({
    id: "todo",
    title: "Todo",
    icon: "ListChecks",
    context: "workspace",
    locations: ["workspace", "explorer"],
    Component: TodoPanel,
  });
  client.addSettingsScreen({
    id: "data",
    title: "Data and trust",
    icon: "ShieldCheck",
    Component: TodoSettingsScreen,
  });
  client.addCommandCenterItem({
    id: "open-todo",
    title: "Open Todo",
    icon: "ListChecks",
    context: "global",
    keywords: ["todo", "work items", "tasks"],
    onSelect({ openSurface }) {
      openSurface("todo");
    },
  });
  client.addCommandCenterItem({
    id: "open-todo-panel",
    title: "Open Todo panel",
    icon: "ListChecks",
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("todo");
    },
  });
  const stopCommands = addTodoCommands(client);
  const stopWorkspaceButtons = trackWorkspaceButtons(client);
  registerSidebarBadgeSetter((count) => client.setSidebarBadge?.("todo", count));
  return () => {
    stopCommands();
    stopWorkspaceButtons();
    registerSidebarBadgeSetter(null);
  };
}
