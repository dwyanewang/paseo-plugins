import type { PluginClientContext } from "@getpaseo/plugin/client";
import { clientProviders } from "./client/providers";
import { ForgeSettingsScreen } from "./client/settings-screen";

export default function contribute(client: PluginClientContext) {
  const remove = [
    client.addSettingsScreen({
      id: "connections",
      title: "Forge 连接",
      icon: "GitPullRequest",
      Component: ForgeSettingsScreen,
    }),
  ];
  for (const provider of clientProviders)
    remove.push(client.addForgeClientProvider(provider));
  remove.push(
    client.addCommandCenterItem({
      id: "configure",
      title: "配置 Forge 连接",
      icon: "Settings",
      context: "global",
      onSelect: ({ openSettings }) => openSettings("connections"),
    })
  );
  return () => {
    for (const cleanup of remove.reverse()) void cleanup();
  };
}
