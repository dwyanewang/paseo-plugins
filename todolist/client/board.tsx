import type { PluginTheme } from "@getpaseo/plugin";
import { FlatList, Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import { useRef, useState, type ReactNode } from "react";
import { Animated, Text, View, type ScrollView as NativeScrollView, type ViewStyle } from "react-native";
import { BOARD_COLUMN_WIDTH, WORK_ITEM_STATUS_LABELS, boardLayout, columnAddAction, type BoardColumn } from "../shared/board";
import type { WorkItemStatus } from "../shared/schema";
import { DragHandle, useBoardDrag, type BoardDrag } from "./board-dnd";
import { Chip, IconButton } from "./components";
import type { WorkItemView } from "./data";
import type { TodoStyles } from "./styles";
import { STATUS_PRESENTATION } from "./text";

/** Room under side-scrolling columns for the horizontal scroll bar. */
const SCROLLBAR_ROOM = 14;

export type RenderCard = (view: WorkItemView, dragHandle?: ReactNode, placeholder?: boolean) => ReactNode;

function CardGap() {
  return <View style={{ height: 8 }} />;
}

function Column(props: {
  styles: TodoStyles;
  theme: PluginTheme;
  column: BoardColumn<WorkItemView>;
  style: ViewStyle;
  renderCard: RenderCard;
  /** The column's "+": create in Backlog and To do, pick existing cards for In progress and Done. */
  onAdd: (status: WorkItemStatus) => void;
  /** Present on wide layouts only. */
  drag: BoardDrag | null;
}) {
  const { styles, theme, column, drag } = props;
  const label = WORK_ITEM_STATUS_LABELS[column.status];
  const presentation = STATUS_PRESENTATION[column.status];
  const add = columnAddAction(column.status);
  const holdsDragged = drag?.draggingId != null && column.views.some((view) => view.item.id === drag.draggingId);
  const dropTarget = drag?.draggingId != null && drag.targetStatus === column.status && !holdsDragged;
  return (
    <View
      ref={drag?.columnRef(column.status)}
      accessibilityLabel={`${label} column, ${column.views.length} ${column.views.length === 1 ? "item" : "items"}`}
      style={[styles.column, props.style, dropTarget ? styles.columnDropTarget : null]}
    >
      {/* Fixed height: columns without a "+" keep their title in line with the rest. */}
      <View style={styles.columnHeader}>
        <Icon name={presentation.icon} size={14} color={theme.colors[presentation.color]} />
        <Text style={[styles.columnTitle, { flexShrink: 1 }]} numberOfLines={1}>
          {label}
        </Text>
        <View style={styles.countPill}>
          <Text style={styles.countText}>{column.views.length}</Text>
        </View>
        <View style={{ flex: 1 }} />
        {add ? (
          <IconButton
            styles={styles}
            theme={theme}
            icon="Plus"
            label={add.kind === "create" ? `New item in ${label}` : `Add existing cards to ${label}`}
            onPress={() => props.onAdd(column.status)}
          />
        ) : null}
      </View>
      {/* Each column scrolls on its own and only mounts the cards near its viewport. */}
      <FlatList
        data={column.views}
        keyExtractor={(view) => view.item.id}
        style={{ flex: 1 }}
        contentContainerStyle={styles.columnBody}
        ItemSeparatorComponent={CardGap}
        initialNumToRender={12}
        windowSize={9}
        extraData={drag?.draggingId}
        renderItem={({ item: view }) => (
          <View ref={drag?.cardRef(view.item.id)}>
            {props.renderCard(
              view,
              drag ? <DragHandle styles={styles} theme={theme} handlers={drag.handle(view)} /> : undefined,
              drag?.draggingId === view.item.id,
            )}
          </View>
        )}
        ListEmptyComponent={<Text style={styles.columnEmpty}>{dropTarget ? "Drop here" : "No items"}</Text>}
      />
    </View>
  );
}

/**
 * The board fills the height it is given and every column scrolls its own cards. The column row
 * scrolls sideways only when the columns do not fit; below two columns' width the board shows one
 * column behind status tabs. Wide layouts add pointer drag; narrow ones rely on the move menu,
 * since a grip that claims the touch would fight vertical scrolling on phones.
 */
export function TodoBoard(props: {
  styles: TodoStyles;
  theme: PluginTheme;
  columns: BoardColumn<WorkItemView>[];
  width: number;
  height: number;
  renderCard: RenderCard;
  onAdd: (status: WorkItemStatus) => void;
  onDrop: (view: WorkItemView, status: WorkItemStatus) => void;
}) {
  const { styles, theme, columns } = props;
  const [tab, setTab] = useState<WorkItemStatus | null>(null);
  const layout = boardLayout(props.width, columns.length, styles.gap);
  const scrollRef = useRef<NativeScrollView | null>(null);
  const drag = useBoardDrag({ columns, scrollRef: layout === "scroll" ? scrollRef : null, onDrop: props.onDrop });
  const column = (entry: BoardColumn<WorkItemView>, style: ViewStyle) => (
    <Column
      key={entry.status}
      styles={styles}
      theme={theme}
      column={entry}
      style={style}
      renderCard={props.renderCard}
      onAdd={props.onAdd}
      drag={layout === "tabs" ? null : drag}
    />
  );
  if (layout === "tabs") {
    const active = columns.find((entry) => entry.status === tab) ?? columns[0];
    return (
      <View style={[styles.board, { gap: 8 }]}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ gap: 6 }}>
          <View accessibilityRole="tablist" style={[styles.row, { gap: 6 }]}>
            {columns.map((entry) => (
              <Chip
                key={entry.status}
                styles={styles}
                theme={theme}
                label={WORK_ITEM_STATUS_LABELS[entry.status]}
                trailing={String(entry.views.length)}
                accessibilityLabel={`${WORK_ITEM_STATUS_LABELS[entry.status]}, ${entry.views.length}`}
                icon={STATUS_PRESENTATION[entry.status].icon}
                iconColor={theme.colors[STATUS_PRESENTATION[entry.status].color]}
                selected={entry.status === active?.status}
                onPress={() => setTab(entry.status)}
              />
            ))}
          </View>
        </ScrollView>
        {active ? column(active, { flex: 1 }) : null}
      </View>
    );
  }
  const ghost = drag.ghost ? (
    <Animated.View
      style={[
        styles.ghost,
        { left: 0, top: 0, width: drag.ghost.width, pointerEvents: "none" },
        { transform: [...drag.ghostPosition.getTranslateTransform(), { rotate: "1.5deg" }] },
      ]}
    >
      {props.renderCard(
        drag.ghost.view,
        <View style={styles.dragHandle}>
          <Icon name="GripVertical" size={14} color={theme.colors.foregroundMuted} />
        </View>,
      )}
    </Animated.View>
  ) : null;
  // No text selection while a card is dragged with a mouse.
  const boardStyle = [styles.board, drag.draggingId ? ({ userSelect: "none", cursor: "grabbing" } as object) : null];
  if (layout === "scroll") {
    const height = props.height > 0 ? { height: Math.max(160, props.height - SCROLLBAR_ROOM) } : { minHeight: 240 };
    return (
      <View ref={drag.boardRef} style={boardStyle}>
        <ScrollView
          ref={scrollRef}
          horizontal
          showsHorizontalScrollIndicator
          style={{ flex: 1 }}
          contentContainerStyle={{ gap: styles.gap, alignItems: "flex-start" }}
          scrollEventThrottle={16}
          onScroll={(event) => drag.onScroll(event.nativeEvent.contentOffset.x)}
          scrollEnabled={drag.draggingId === null}
        >
          {columns.map((entry) => column(entry, { width: BOARD_COLUMN_WIDTH, ...height }))}
        </ScrollView>
        {ghost}
      </View>
    );
  }
  return (
    <View ref={drag.boardRef} style={boardStyle}>
      <View style={styles.boardRow}>{columns.map((entry) => column(entry, { flex: 1, minWidth: 0 }))}</View>
      {ghost}
    </View>
  );
}
