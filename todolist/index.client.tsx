import type { PluginClientContext } from "@getpaseo/plugin/client";
import { TodoPanel } from "./client/panel";
import { TodoSettingsScreen } from "./client/settings-screen";
import { TodoSurface } from "./client/surface";

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
  return () => {};
}
