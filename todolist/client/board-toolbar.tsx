import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, Modal, TextInput } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
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

/** A chip that shows the current value and opens a picker; without `onPress` it is a plain label. */
function DropdownChip(props: {
  styles: TodoStyles;
  theme: PluginTheme;
  icon?: string;
  label: string;
  highlighted: boolean;
  accessibilityLabel: string;
  onPress: (() => void) | null;
}) {
  const { styles, theme } = props;
  const content = (
    <>
      {props.icon ? <Icon name={props.icon} size={13} color={props.highlighted ? theme.colors.foreground : theme.colors.foregroundMuted} /> : null}
      <Text style={[props.highlighted ? styles.chipSelectedText : styles.chipText, { flexShrink: 1 }]} numberOfLines={1}>
        {props.label}
      </Text>
      {props.onPress ? <Icon name="ChevronDown" size={13} color={theme.colors.foregroundMuted} /> : null}
    </>
  );
  const chip = [styles.chip, { height: 32, maxWidth: 240, flexShrink: 1 }, props.highlighted ? styles.chipSelected : null];
  if (!props.onPress) {
    return (
      <View accessibilityLabel={props.accessibilityLabel} style={chip}>
        {content}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel}
      onPress={props.onPress}
      style={({ hovered }: { hovered?: boolean; pressed: boolean }) => [chip, hovered ? { borderColor: theme.colors.foregroundMuted } : null]}
    >
      {content}
    </Pressable>
  );
}

/**
 * The board's controls. The host header already names the surface, so the toolbar starts with the
 * project. Wide layouts keep everything in one row; phones keep one row too, with the status filter
 * behind a picker and search behind a toggle.
 */
export function BoardToolbar(props: {
  styles: TodoStyles;
  theme: PluginTheme;
  compact: boolean;
  /** Label of the current project filter; with `onPickProject` null (the workspace panel) it is fixed. */
  projectLabel: string;
  projectFiltered: boolean;
  onPickProject: (() => void) | null;
  filter: BoardFilter;
  onFilter: (filter: BoardFilter) => void;
  query: string;
  onQuery: (query: string) => void;
  /** Null where the list pulls to refresh instead. */
  onReload: (() => void) | null;
  onCreate: () => void;
  canCreate: boolean;
}) {
  const { styles, theme } = props;
  const [searchOpen, setSearchOpen] = useState(false);
  const [pickingFilter, setPickingFilter] = useState(false);
  const project = (
    <DropdownChip
      styles={styles}
      theme={theme}
      icon="Folder"
      label={props.projectLabel}
      highlighted={props.projectFiltered}
      accessibilityLabel={props.onPickProject ? `Project filter: ${props.projectLabel}. Change` : `Project: ${props.projectLabel}`}
      onPress={props.onPickProject}
    />
  );
  const search = (autoFocus: boolean) => (
    <View style={[styles.searchBox, props.compact ? null : { maxWidth: 280 }]}>
      <Icon name="Search" size={14} color={theme.colors.foregroundMuted} />
      <TextInput
        accessibilityLabel="Search work items"
        value={props.query}
        onChangeText={props.onQuery}
        autoFocus={autoFocus}
        placeholder="Search #, title, details"
        placeholderTextColor={theme.colors.foregroundMuted}
        style={[styles.searchInput, { outlineStyle: "none" } as object]}
      />
      {props.query ? <IconButton styles={styles} theme={theme} icon="X" label="Clear search" onPress={() => props.onQuery("")} /> : null}
    </View>
  );
  const onReload = props.onReload;
  const reload = onReload ? (
    <IconButton styles={styles} theme={theme} icon="RefreshCw" label="Reload" bordered accessibilityHint="Re-reads Todo data from the daemon" onPress={onReload} />
  ) : null;

  if (props.compact) {
    const filterLabel = BOARD_FILTERS.find((entry) => entry.value === props.filter)?.label ?? "Active";
    // A query keeps the search row open, so a filtered board never hides why it is filtered.
    const showSearch = searchOpen || props.query !== "";
    return (
      <View style={{ gap: 8 }}>
        <View style={[styles.row, { gap: 6 }]}>
          {project}
          <DropdownChip
            styles={styles}
            theme={theme}
            label={filterLabel}
            highlighted={props.filter !== "active"}
            accessibilityLabel={`Board filter: ${filterLabel}. Change`}
            onPress={() => setPickingFilter(true)}
          />
          <View style={{ flex: 1 }} />
          <IconButton
            styles={styles}
            theme={theme}
            icon="Search"
            label={showSearch ? "Hide search" : "Search"}
            bordered
            active={showSearch}
            onPress={() => {
              if (showSearch) props.onQuery("");
              setSearchOpen(!showSearch);
            }}
          />
          {reload}
          <IconButton styles={styles} theme={theme} icon="Plus" label="New" primary disabled={!props.canCreate} onPress={props.onCreate} />
        </View>
        {showSearch ? <View style={styles.row}>{search(searchOpen && props.query === "")}</View> : null}
        <Modal title="Show" open={pickingFilter} onOpenChange={setPickingFilter}>
          <Modal.Content>
            <Select
              styles={styles}
              theme={theme}
              label="Board filter"
              value={props.filter}
              options={BOARD_FILTERS}
              onChange={(next) => {
                props.onFilter(next);
                setPickingFilter(false);
              }}
            />
          </Modal.Content>
        </Modal>
      </View>
    );
  }
  return (
    <View style={styles.toolbar}>
      {project}
      <Segmented styles={styles} label="Board filter" value={props.filter} options={BOARD_FILTERS} onChange={props.onFilter} />
      <View style={[styles.toolbarGroup, { marginLeft: "auto", flexGrow: 1, justifyContent: "flex-end" }]}>
        {search(false)}
        {reload}
        <Button styles={styles} theme={theme} label="New" icon="Plus" variant="primary" disabled={!props.canCreate} onPress={props.onCreate} />
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
