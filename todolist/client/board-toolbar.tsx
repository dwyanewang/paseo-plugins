import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, Modal, ScrollView, TextInput } from "@getpaseo/plugin/client/react-native";
import { Pressable, Text, View } from "react-native";
import { BOARD_FILTERS, type BoardFilter } from "../shared/board";
import { Button, IconButton, Segmented, Select } from "./components";
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
  compact: boolean;
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
  const title = (
    <Text accessibilityRole="header" style={[styles.headerTitle, { flexShrink: 1 }]} numberOfLines={1}>
      {props.title}
    </Text>
  );
  const project = props.onPickProject ? (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Project filter: ${props.projectLabel}. Change`}
      onPress={props.onPickProject}
      style={({ hovered }: { hovered?: boolean; pressed: boolean }) => [
        styles.chip,
        { height: 30, maxWidth: 240 },
        props.projectFiltered ? styles.chipSelected : null,
        hovered ? { borderColor: theme.colors.foregroundMuted } : null,
      ]}
    >
      <Icon name="Folder" size={13} color={props.projectFiltered ? theme.colors.foreground : theme.colors.foregroundMuted} />
      <Text style={[props.projectFiltered ? styles.chipSelectedText : styles.chipText, { flexShrink: 1 }]} numberOfLines={1}>
        {props.projectLabel}
      </Text>
      <Icon name="ChevronDown" size={13} color={theme.colors.foregroundMuted} />
    </Pressable>
  ) : null;
  const filters = <Segmented styles={styles} label="Board filter" value={props.filter} options={BOARD_FILTERS} onChange={props.onFilter} />;
  const search = (
    <View style={[styles.searchBox, props.compact ? null : { maxWidth: 280 }]}>
      <Icon name="Search" size={14} color={theme.colors.foregroundMuted} />
      <TextInput
        accessibilityLabel="Search work items"
        value={props.query}
        onChangeText={props.onQuery}
        placeholder="Search #, title, details"
        placeholderTextColor={theme.colors.foregroundMuted}
        style={[styles.searchInput, { outlineStyle: "none" } as object]}
      />
      {props.query ? <IconButton styles={styles} theme={theme} icon="X" label="Clear search" onPress={() => props.onQuery("")} /> : null}
    </View>
  );
  const actions = (
    <View style={styles.toolbarGroup}>
      <IconButton styles={styles} theme={theme} icon="RefreshCw" label="Reload" bordered accessibilityHint="Re-reads Todo data from the daemon" onPress={props.onReload} />
      <Button styles={styles} theme={theme} label="New" icon="Plus" variant="primary" disabled={!props.canCreate} onPress={props.onCreate} />
    </View>
  );
  if (props.compact) {
    return (
      <View style={{ gap: 8 }}>
        <View style={styles.header}>
          {title}
          {actions}
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }}>
          <View style={styles.toolbarGroup}>
            {project}
            {filters}
          </View>
        </ScrollView>
        <View style={styles.row}>{search}</View>
      </View>
    );
  }
  return (
    <View style={styles.toolbar}>
      <View style={[styles.toolbarGroup, { gap: 12, flexShrink: 1 }]}>
        {title}
        {project}
      </View>
      {filters}
      <View style={[styles.toolbarGroup, { marginLeft: "auto", flexGrow: 1, justifyContent: "flex-end" }]}>
        {search}
        {actions}
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
