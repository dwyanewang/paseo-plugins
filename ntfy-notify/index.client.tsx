import type { PluginClientContext } from "@getpaseo/plugin/client";
import { NtfySettings } from "./client/ntfy-settings";

export default function contribute(client: PluginClientContext) {
  client.addSettingsScreen({
    id: "ntfy",
    title: "ntfy 通知",
    icon: "BellRing",
    Component: NtfySettings,
  });
  client.addCommandCenterItem({
    id: "open-ntfy-settings",
    title: "配置 ntfy 通知",
    icon: "BellRing",
    context: "global",
    onSelect({ openSettings }) {
      openSettings("ntfy");
    },
  });
  return () => {};
}
