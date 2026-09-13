import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useMemo, useRef, useState } from "react";
import { PanResponder, Pressable, Text, View } from "react-native";
import { groupByProject, type ProjectGroup, type WorkItemView } from "./data";
import type { ProjectRecord } from "./projects";
import type { TodoStyles } from "./styles";
import { WorkItemRow, type RowActions } from "./work-item-row";

/**
 * Pointer drag handle. It claims the touch on contact, which on a native ScrollView means the
 * gesture can no longer scroll, so it is only rendered on roomy pointer-first layouts; compact
 * (phone) layouts reorder with the Move up and Move down buttons instead.
 */
function DragHandle(props: {
  styles: TodoStyles;
  theme: PluginTheme;
  index: number;
  count: number;
  rowHeight: number;
  onDrop: (from: number, to: number) => void;
  onDragging: (index: number | null) => void;
  label: string;
}) {
  const { onDrop, onDragging, index, count, rowHeight } = props;
  const state = useRef({ index, count, rowHeight, onDrop, onDragging });
  state.current = { index, count, rowHeight, onDrop, onDragging };
  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: (_event, gesture) => Math.abs(gesture.dy) > 4,
        onPanResponderGrant: () => state.current.onDragging(state.current.index),
        onPanResponderRelease: (_event, gesture) => {
          const { index: from, count: total, rowHeight: height } = state.current;
          const delta = height > 0 ? Math.round(gesture.dy / height) : 0;
          const to = Math.max(0, Math.min(total - 1, from + delta));
          state.current.onDragging(null);
          if (to !== from) state.current.onDrop(from, to);
        },
        onPanResponderTerminate: () => state.current.onDragging(null),
      }),
    [],
  );
  return (
    <View
      {...responder.panHandlers}
      accessibilityRole="button"
      accessibilityLabel={`Drag to reorder ${props.label}. Use Move up and Move down for keyboard reordering.`}
      style={props.styles.dragHandle}
    >
      <Icon name="GripVertical" size={16} color={props.theme.colors.foregroundMuted} />
    </View>
  );
}

function CollapsibleSection(props: { styles: TodoStyles; theme: PluginTheme; title: string; count: number; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  if (props.count === 0) return null;
  return (
    <View style={props.styles.section}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${open ? "Collapse" : "Expand"} ${props.title} (${props.count})`}
        onPress={() => setOpen((value) => !value)}
        style={props.styles.row}
      >
        <Icon name={open ? "ChevronDown" : "ChevronRight"} size={14} color={props.theme.colors.foregroundMuted} />
        <Text style={props.styles.sectionTitle}>
          {props.title} ({props.count})
        </Text>
      </Pressable>
      {open ? props.children : null}
    </View>
  );
}

export function TodoList(props: {
  styles: TodoStyles;
  theme: PluginTheme;
  compact: boolean;
  views: Map<string, WorkItemView>;
  projects: Map<string, ProjectRecord>;
  projectsReady: boolean;
  projectFilter: string | null;
  projectOrderVersions: Record<string, number>;
  actions: RowActions;
  canLaunch: boolean;
  onReorder: (input: { view: WorkItemView; expectedProjectOrderVersion: number; beforeId?: string; afterId?: string }) => void;
}) {
  const { styles, theme } = props;
  const [rowHeight, setRowHeight] = useState(0);
  const [dragging, setDragging] = useState<string | null>(null);
  const groups = useMemo(() => {
    const filtered = [...props.views.values()].filter(
      (view) => props.projectFilter === null || view.item.projectId === props.projectFilter,
    );
    return groupByProject(filtered);
  }, [props.views, props.projectFilter]);
  const ordered = useMemo(() => {
    const available: ProjectGroup[] = [];
    const unavailable: ProjectGroup[] = [];
    for (const group of groups.values()) {
      (props.projects.has(group.projectId) || !props.projectsReady ? available : unavailable).push(group);
    }
    const name = (group: ProjectGroup) => props.projects.get(group.projectId)?.projectDisplayName ?? "";
    available.sort((left, right) => name(left).localeCompare(name(right)));
    return { available, unavailable };
  }, [groups, props.projects, props.projectsReady]);

  function reorderWithin(group: ProjectGroup, from: number, to: number) {
    const view = group.open[from];
    if (!view) return;
    const without = group.open.filter((_, index) => index !== from);
    const before = to > 0 ? without[to - 1] : undefined;
    const after = without[to];
    props.onReorder({
      view,
      expectedProjectOrderVersion: props.projectOrderVersions[group.projectId] ?? 0,
      ...(before ? { beforeId: before.item.id } : {}),
      ...(after ? { afterId: after.item.id } : {}),
    });
  }

  const renderGroup = (group: ProjectGroup, available: boolean) => {
    const project = props.projects.get(group.projectId);
    const sample = group.open[0] ?? group.done[0] ?? group.archived[0];
    const title = project?.projectDisplayName ?? `Unavailable: ${sample?.item.projectNameSnapshot ?? group.projectId}`;
    return (
      <View key={group.projectId} style={styles.section}>
        <View style={styles.rowWrap}>
          <Icon name={available ? "Folder" : "FolderX"} size={16} color={available ? theme.colors.foregroundMuted : theme.colors.statusWarning} />
          <Text style={styles.sectionTitle}>{title}</Text>
          {!available && sample?.item.projectRootSnapshot ? <Text style={styles.mono}>{sample.item.projectRootSnapshot}</Text> : null}
        </View>
        {group.open.map((view, index) => (
          <View
            key={view.item.id}
            onLayout={index === 0 ? (event) => setRowHeight(event.nativeEvent.layout.height) : undefined}
            style={dragging === view.item.id ? styles.dragging : null}
          >
            <WorkItemRow
              styles={styles}
              theme={theme}
              view={view}
              actions={{
                ...props.actions,
                moveUp: () => reorderWithin(group, index, index - 1),
                moveDown: () => reorderWithin(group, index, index + 1),
              }}
              canLaunch={props.canLaunch}
              canMoveUp={index > 0}
              canMoveDown={index < group.open.length - 1}
              compact={props.compact}
              projectAvailable={available}
              dragHandle={
                group.open.length > 1 && !props.compact ? (
                  <DragHandle
                    styles={styles}
                    theme={theme}
                    index={index}
                    count={group.open.length}
                    rowHeight={rowHeight}
                    label={view.item.title}
                    onDrop={(from, to) => reorderWithin(group, from, to)}
                    onDragging={(active) => setDragging(active === null ? null : (group.open[active]?.item.id ?? null))}
                  />
                ) : undefined
              }
            />
          </View>
        ))}
        {group.open.length === 0 ? <Text style={styles.muted}>No open items.</Text> : null}
        <CollapsibleSection styles={styles} theme={theme} title="Done" count={group.done.length}>
          {group.done.map((view) => (
            <WorkItemRow key={view.item.id} styles={styles} theme={theme} view={view} actions={props.actions} canLaunch={props.canLaunch} canMoveUp={false} canMoveDown={false} compact={props.compact} projectAvailable={available} />
          ))}
        </CollapsibleSection>
        <CollapsibleSection styles={styles} theme={theme} title="Archived" count={group.archived.length}>
          {group.archived.map((view) => (
            <WorkItemRow key={view.item.id} styles={styles} theme={theme} view={view} actions={props.actions} canLaunch={props.canLaunch} canMoveUp={false} canMoveDown={false} compact={props.compact} projectAvailable={available} />
          ))}
        </CollapsibleSection>
      </View>
    );
  };

  if (groups.size === 0) {
    return <Text style={styles.muted}>No work items yet.</Text>;
  }
  return (
    <View style={{ gap: styles.gap * 2 }}>
      {ordered.available.map((group) => renderGroup(group, true))}
      {ordered.unavailable.map((group) => renderGroup(group, false))}
    </View>
  );
}
