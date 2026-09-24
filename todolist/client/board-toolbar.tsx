import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, TextInput } from "@getpaseo/plugin/client/react-native";
import { useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { BOARD_FILTERS, type BoardFilter } from "../shared/board";
import { Button, IconButton, Segmented } from "./components";
import { AnchoredMenu } from "./floating-menu";
import { measureInWindow, type Rect } from "./overlay";
import type { TodoStyles } from "./styles";

export interface ProjectOption {
  value: string;
  label: string;
  hint?: string;
  available: boolean;
}

/**
 * A chip that shows the current value and opens a menu next to itself; without `onPress` it is a
 * plain label.
 */
function DropdownChip(props: {
  styles: TodoStyles;
  theme: PluginTheme;
  icon?: string;
  label: string;
  highlighted: boolean;
  accessibilityLabel: string;
  onPress: ((anchor: Rect) => void) | null;
}) {
  const { styles, theme } = props;
  const chipRef = useRef<View | null>(null);
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
      ref={chipRef}
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel}
      onPress={() => {
        const onPress = props.onPress;
        if (onPress) void measureInWindow(chipRef.current).then((anchor) => anchor && onPress(anchor));
      }}
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
  /** Label of the current project filter; without `projects` (the workspace panel) it is fixed. */
  projectLabel: string;
  projectFiltered: boolean;
  /** The project filter's choices; the first, value "", stands for every project. */
  projects: { options: readonly ProjectOption[]; value: string; onChange: (projectId: string) => void } | null;
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
  const [menu, setMenu] = useState<{ kind: "filter" | "project"; anchor: Rect } | null>(null);
  const projects = props.projects;
  const project = (
    <DropdownChip
      styles={styles}
      theme={theme}
      icon="Folder"
      label={props.projectLabel}
      highlighted={props.projectFiltered}
      accessibilityLabel={projects ? `Project filter: ${props.projectLabel}. Change` : `Project: ${props.projectLabel}`}
      onPress={projects ? (anchor) => setMenu({ kind: "project", anchor }) : null}
    />
  );
  const menus = (
    <>
      <AnchoredMenu
        theme={theme}
        anchor={menu?.kind === "filter" ? menu.anchor : null}
        onClose={() => setMenu(null)}
        label="Show"
        items={BOARD_FILTERS.map((entry) => ({ key: entry.value, label: entry.label, checked: entry.value === props.filter, section: "Show" }))}
        onSelect={(key) => props.onFilter(key as BoardFilter)}
      />
      <AnchoredMenu
        theme={theme}
        anchor={menu?.kind === "project" ? menu.anchor : null}
        onClose={() => setMenu(null)}
        label="Project filter"
        width={300}
        items={(projects?.options ?? []).map((option) => ({
          key: option.value,
          label: option.label,
          ...(option.hint ? { hint: option.hint } : {}),
          icon: option.value === "" ? "Layers" : option.available ? "Folder" : "FolderX",
          checked: option.value === projects?.value,
        }))}
        filter={{ placeholder: "Filter projects…", noun: "projects" }}
        onSelect={(key) => projects?.onChange(key)}
      />
    </>
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
            onPress={(anchor) => setMenu({ kind: "filter", anchor })}
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
        {menus}
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
      {menus}
    </View>
  );
}
