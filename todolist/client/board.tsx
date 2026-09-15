import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import { Fragment, useRef, useState, type ReactNode } from "react";
import { Animated, Pressable, Text, View, type ScrollView as NativeScrollView } from "react-native";
import { BOARD_COLUMN_WIDTH, WORK_ITEM_STATUS_LABELS, boardLayout, type BoardColumn, type DropTarget } from "../shared/board";
import type { WorkItemStatus } from "../shared/schema";
import { DragHandle, useBoardDrag, type BoardDrag } from "./board-dnd";
import { Button, Chip } from "./components";
import type { WorkItemView } from "./data";
import type { TodoStyles } from "./styles";
import { STATUS_PRESENTATION } from "./text";

/** Cards render a page at a time so a long Done column stays cheap. */
const PAGE_SIZE = 30;

function Column(props: {
  styles: TodoStyles;
  theme: PluginTheme;
  column: BoardColumn<WorkItemView>;
  width?: number;
  renderCard: (view: WorkItemView, dragHandle?: ReactNode) => ReactNode;
  onCreate: (status: WorkItemStatus) => void;
  /** Present on wide layouts only. */
  drag: BoardDrag | null;
}) {
  const { styles, theme, column, drag } = props;
  const [limit, setLimit] = useState(PAGE_SIZE);
  const label = WORK_ITEM_STATUS_LABELS[column.status];
  const presentation = STATUS_PRESENTATION[column.status];
  const hidden = column.views.length - limit;
  const dropIndex = drag?.target?.status === column.status ? drag.target.index : null;
  const holdsDragged = drag?.draggingId !== null && column.views.some((view) => view.item.id === drag?.draggingId);
  const indicator = <View style={styles.dropIndicator} />;
  // The drop slot counts cards with the dragged one left out, so walk the column the same way.
  let slot = 0;
  return (
    <View
      ref={drag?.columnRef(column.status)}
      accessibilityLabel={`${label} column, ${column.views.length} ${column.views.length === 1 ? "item" : "items"}`}
      style={[
        styles.column,
        props.width ? { width: props.width } : { flex: 1, minWidth: 0 },
        dropIndex !== null ? styles.columnDropTarget : null,
        holdsDragged ? { zIndex: 1 } : null,
      ]}
    >
      <View style={styles.row}>
        <Icon name={presentation.icon} size={14} color={theme.colors[presentation.color]} />
        <Text style={styles.columnTitle}>{label}</Text>
        <Text style={[styles.mono, { flex: 1 }]}>{column.views.length}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`New item in ${label}`}
          hitSlop={8}
          onPress={() => props.onCreate(column.status)}
          style={styles.iconButton}
        >
          <Icon name="Plus" size={16} color={theme.colors.foregroundMuted} />
        </Pressable>
      </View>
      {column.views.slice(0, limit).map((view) => {
        const dragged = drag?.draggingId === view.item.id;
        const before = !dragged && slot === dropIndex;
        if (!dragged) slot += 1;
        return (
          <Fragment key={view.item.id}>
            {before ? indicator : null}
            <View ref={drag?.cardRef(view.item.id)}>
              <Animated.View style={dragged && drag ? { transform: drag.translate.getTranslateTransform(), opacity: 0.95, zIndex: 1 } : null}>
                {props.renderCard(view, drag ? <DragHandle styles={styles} theme={theme} handlers={drag.handle(view)} /> : undefined)}
              </Animated.View>
            </View>
          </Fragment>
        );
      })}
      {dropIndex !== null && dropIndex >= slot ? indicator : null}
      {column.views.length === 0 && dropIndex === null ? <Text style={styles.muted}>No items</Text> : null}
      {hidden > 0 ? (
        <Button
          styles={styles}
          theme={theme}
          label={`Show ${Math.min(PAGE_SIZE, hidden)} more`}
          onPress={() => setLimit((current) => current + PAGE_SIZE)}
        />
      ) : null}
    </View>
  );
}

/**
 * The page itself scrolls vertically; only the column row scrolls sideways, and only when the
 * columns do not fit. Below two columns' width the board shows one column behind status tabs.
 * Wide layouts add pointer drag; narrow ones rely on the move menu, since a grip that claims the
 * touch would fight vertical scrolling on phones.
 */
export function TodoBoard(props: {
  styles: TodoStyles;
  theme: PluginTheme;
  columns: BoardColumn<WorkItemView>[];
  width: number;
  renderCard: (view: WorkItemView, dragHandle?: ReactNode) => ReactNode;
  onCreate: (status: WorkItemStatus) => void;
  onDrop: (view: WorkItemView, target: DropTarget) => void;
}) {
  const { styles, theme, columns } = props;
  const [tab, setTab] = useState<WorkItemStatus | null>(null);
  const layout = boardLayout(props.width, columns.length, styles.gap);
  const scrollRef = useRef<NativeScrollView | null>(null);
  const drag = useBoardDrag({ columns, scrollRef: layout === "scroll" ? scrollRef : null, onDrop: props.onDrop });
  const column = (entry: BoardColumn<WorkItemView>, width?: number) => (
    <Column
      key={entry.status}
      styles={styles}
      theme={theme}
      column={entry}
      {...(width ? { width } : {})}
      renderCard={props.renderCard}
      onCreate={props.onCreate}
      drag={layout === "tabs" ? null : drag}
    />
  );
  if (layout === "tabs") {
    const active = columns.find((entry) => entry.status === tab) ?? columns[0];
    return (
      <View style={{ gap: styles.gap }}>
        <View accessibilityRole="tablist" style={styles.rowWrap}>
          {columns.map((entry) => (
            <Chip
              key={entry.status}
              styles={styles}
              theme={theme}
              label={`${WORK_ITEM_STATUS_LABELS[entry.status]} ${entry.views.length}`}
              icon={STATUS_PRESENTATION[entry.status].icon}
              iconColor={theme.colors[STATUS_PRESENTATION[entry.status].color]}
              selected={entry.status === active?.status}
              onPress={() => setTab(entry.status)}
            />
          ))}
        </View>
        {active ? column(active) : null}
      </View>
    );
  }
  // No text selection while a card is dragged with a mouse.
  const rowStyle = [styles.boardRow, drag.draggingId ? ({ userSelect: "none" } as object) : null];
  if (layout === "scroll") {
    return (
      <ScrollView
        ref={scrollRef}
        horizontal
        showsHorizontalScrollIndicator
        scrollEventThrottle={16}
        onScroll={(event) => drag.onScroll(event.nativeEvent.contentOffset.x)}
        scrollEnabled={drag.draggingId === null}
      >
        <View style={rowStyle}>{columns.map((entry) => column(entry, BOARD_COLUMN_WIDTH))}</View>
      </ScrollView>
    );
  }
  return <View style={rowStyle}>{columns.map((entry) => column(entry))}</View>;
}
