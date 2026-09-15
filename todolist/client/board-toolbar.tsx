import type { PluginTheme } from "@getpaseo/plugin";
import { Modal, TextInput } from "@getpaseo/plugin/client/react-native";
import { Text, View } from "react-native";
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
  /** Label of the current project filter; with `onPickProject` null (the workspace panel) it is fixed. */
  projectLabel: string;
  projectFiltered: boolean;
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
        <Text accessibilityRole="header" style={[styles.headerTitle, { flexShrink: 1 }]} numberOfLines={1}>
          {props.title}
        </Text>
        <View style={styles.rowWrap}>
          <Button styles={styles} theme={theme} label="Reload" icon="RefreshCw" onPress={props.onReload} accessibilityHint="Re-reads Todo data from the daemon" />
          <Button styles={styles} theme={theme} label="New" icon="Plus" variant="primary" disabled={!props.canCreate} onPress={props.onCreate} />
        </View>
      </View>
      <View style={styles.rowWrap}>
        {props.onPickProject ? (
          <Chip
            styles={styles}
            theme={theme}
            role="button"
            label={`Project: ${props.projectLabel}`}
            icon="Folder"
            selected={props.projectFiltered}
            accessibilityLabel={`Project filter: ${props.projectLabel}. Change`}
            onPress={props.onPickProject}
          />
        ) : null}
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
  /** The first option, value "", stands for every project. */
  options: readonly ProjectOption[];
  value: string;
  onChange: (projectId: string) => void;
}) {
  return (
    <Modal title="Project filter" open={props.open} onOpenChange={props.onOpenChange}>
      <Modal.Content>
        <Select
          styles={props.styles}
          theme={props.theme}
          label="Show cards from"
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
