import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, Modal, TextInput } from "@getpaseo/plugin/client/react-native";
import { Pressable, Text, View } from "react-native";
import { BOARD_FILTERS, type BoardFilter } from "../shared/board";
import { Button, Chip, Select } from "./components";
import type { TodoStyles } from "./styles";

export interface ProjectOption {
  value: string;
  label: string;
  hint?: string;
  available: boolean;
}

export function BoardToolbar(props: {
  styles: TodoStyles;
  theme: PluginTheme;
  title: string;
  /** Null in the workspace panel, whose project is fixed. */
  onPickProject: (() => void) | null;
  filter: BoardFilter;
  onFilter: (filter: BoardFilter) => void;
  query: string;
  onQuery: (query: string) => void;
  onReload: () => void;
  onCreate: () => void;
  canCreate: boolean;
}) {
  const { styles, theme } = props;
  return (
    <View style={{ gap: styles.gap }}>
      <View style={[styles.header, { flexWrap: "wrap" }]}>
        <Pressable
          accessibilityRole={props.onPickProject ? "button" : "header"}
          accessibilityLabel={props.onPickProject ? `${props.title}. Switch project` : props.title}
          disabled={!props.onPickProject}
          onPress={() => props.onPickProject?.()}
          style={[styles.row, { flexShrink: 1 }]}
        >
          <Text style={[styles.headerTitle, { flexShrink: 1 }]} numberOfLines={1}>
            {props.title}
          </Text>
          {props.onPickProject ? <Icon name="ChevronDown" size={18} color={theme.colors.foregroundMuted} /> : null}
        </Pressable>
        <View style={styles.rowWrap}>
          <Button styles={styles} theme={theme} label="Reload" icon="RefreshCw" onPress={props.onReload} accessibilityHint="Re-reads Todo data from the daemon" />
          <Button styles={styles} theme={theme} label="New" icon="Plus" variant="primary" disabled={!props.canCreate} onPress={props.onCreate} />
        </View>
      </View>
      <View style={styles.rowWrap}>
        <View accessibilityRole="tablist" style={styles.rowWrap}>
          {BOARD_FILTERS.map((entry) => (
            <Chip
              key={entry.value}
              styles={styles}
              theme={theme}
              label={entry.label}
              selected={entry.value === props.filter}
              onPress={() => props.onFilter(entry.value)}
            />
          ))}
        </View>
        <TextInput
          accessibilityLabel="Search work items"
          value={props.query}
          onChangeText={props.onQuery}
          placeholder="Search #, title, details"
          placeholderTextColor={theme.colors.foregroundMuted}
          style={[styles.input, styles.search]}
        />
      </View>
    </View>
  );
}

export function ProjectPicker(props: {
  styles: TodoStyles;
  theme: PluginTheme;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  options: readonly ProjectOption[];
  value: string | null;
  onChange: (projectId: string) => void;
}) {
  return (
    <Modal title="Project" open={props.open} onOpenChange={props.onOpenChange}>
      <Modal.Content>
        <Select
          styles={props.styles}
          theme={props.theme}
          label="Show the board of"
          value={props.value}
          options={props.options}
          onChange={(projectId) => {
            props.onChange(projectId);
            props.onOpenChange(false);
          }}
        />
      </Modal.Content>
    </Modal>
  );
}
