import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import { Fragment, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { BOARD_COLUMN_WIDTH, WORK_ITEM_STATUS_LABELS, boardLayout, type BoardColumn } from "../shared/board";
import type { WorkItemStatus } from "../shared/schema";
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
  renderCard: (view: WorkItemView) => ReactNode;
  onCreate: (status: WorkItemStatus) => void;
}) {
  const { styles, theme, column } = props;
  const [limit, setLimit] = useState(PAGE_SIZE);
  const label = WORK_ITEM_STATUS_LABELS[column.status];
  const presentation = STATUS_PRESENTATION[column.status];
  const hidden = column.views.length - limit;
  return (
    <View
      accessibilityLabel={`${label} column, ${column.views.length} ${column.views.length === 1 ? "item" : "items"}`}
      style={[styles.column, props.width ? { width: props.width } : { flex: 1, minWidth: 0 }]}
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
      {column.views.slice(0, limit).map((view) => (
        <Fragment key={view.item.id}>{props.renderCard(view)}</Fragment>
      ))}
      {column.views.length === 0 ? <Text style={styles.muted}>No items</Text> : null}
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
 */
export function TodoBoard(props: {
  styles: TodoStyles;
  theme: PluginTheme;
  columns: BoardColumn<WorkItemView>[];
  width: number;
  renderCard: (view: WorkItemView) => ReactNode;
  onCreate: (status: WorkItemStatus) => void;
}) {
  const { styles, theme, columns } = props;
  const [tab, setTab] = useState<WorkItemStatus | null>(null);
  const layout = boardLayout(props.width, columns.length, styles.gap);
  const column = (entry: BoardColumn<WorkItemView>, width?: number) => (
    <Column
      key={entry.status}
      styles={styles}
      theme={theme}
      column={entry}
      {...(width ? { width } : {})}
      renderCard={props.renderCard}
      onCreate={props.onCreate}
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
  if (layout === "scroll") {
    return (
      <ScrollView horizontal showsHorizontalScrollIndicator>
        <View style={styles.boardRow}>{columns.map((entry) => column(entry, BOARD_COLUMN_WIDTH))}</View>
      </ScrollView>
    );
  }
  return <View style={styles.boardRow}>{columns.map((entry) => column(entry))}</View>;
}
