import type { PluginClientContext } from "@getpaseo/plugin/client";
import { SmtpSettings } from "./client/smtp-settings";

export default function contribute(client: PluginClientContext) {
  client.addSettingsScreen({
    id: "smtp",
    title: "邮件通知",
    icon: "Mail",
    Component: SmtpSettings,
  });
  client.addCommandCenterItem({
    id: "open-smtp-settings",
    title: "配置邮件通知",
    icon: "Mail",
    context: "global",
    onSelect({ openSettings }) {
      openSettings("smtp");
    },
  });
  return () => {};
}
