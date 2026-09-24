import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { TodoScreen } from "./todo-screen";

export function TodoSurface({ theme, host, layout, navigation }: PluginSurfaceProps) {
  return (
    <TodoScreen
      theme={theme}
      compact={layout.compact}
      platform={layout.platform}
      insets={layout.insets}
      host={host}
      navigation={navigation}
      projectFilter={null}
      projectFilterName={null}
      defaultWorkspaceId={null}
    />
  );
}
