import { useWorkspace, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { Text, View } from "react-native";
import { useTodoStyles } from "./styles";
import { TodoScreen } from "./todo-screen";

/** Workspace panel: the project comes from the host workspace selector, never from props. */
export function TodoPanel({ theme, host, layout, navigation, workspaceId }: PluginWorkspacePanelProps) {
  const workspace = useWorkspace(workspaceId, (snapshot) => ({
    projectId: snapshot.projectId,
    projectDisplayName: snapshot.projectDisplayName,
  }));
  const styles = useTodoStyles(theme, layout.compact);
  if (!workspace) {
    return (
      <View style={styles.screen}>
        <Text style={styles.muted}>Workspace unavailable.</Text>
      </View>
    );
  }
  return (
    <TodoScreen
      theme={theme}
      compact={layout.compact}
      platform={layout.platform}
      host={host}
      navigation={navigation}
      projectFilter={workspace.projectId}
      defaultWorkspaceId={workspaceId}
      title={`Todo · ${workspace.projectDisplayName}`}
      quickAdd
    />
  );
}
