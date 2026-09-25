import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useRef, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { WORK_ITEM_PRIORITY_LABELS, WORK_ITEM_STATUS_LABELS, formatRelativeTime, latestLink } from "../shared/board";
import { Badge, IconButton } from "./components";
import type { WorkItemView } from "./data";
import { measureInWindow, type Rect } from "./overlay";
import type { TodoStyles } from "./styles";
import {
  AGGREGATE_PRESENTATION,
  CARD_BADGE_STATES,
  DISPLAY_STATE_COLOR,
  DISPLAY_STATE_PRESENTATION,
  PRIORITY_PRESENTATION,
  STATUS_PRESENTATION,
} from "./text";

export function BoardCard(props: {
  styles: TodoStyles;
  theme: PluginTheme;
  view: WorkItemView;
  now: number;
  onOpen: (view: WorkItemView) => void;
  /** The card menu opens next to `anchor`: the "⋯", or the whole card after a long press. */
  onMenu: (view: WorkItemView, anchor: Rect) => void;
  onOpenAgent: ((agentId: string) => void) | null;
  /** Outside the columns (the Archived list) the card names its column itself. */
  showStatus?: boolean;
  /** When the board shows every project, each card names its own. */
  showProject?: boolean;
  /** Grip for pointer drag on wide boards. */
  dragHandle?: ReactNode;
  /** The card is being dragged: a ghost follows the pointer and this copy stays behind, faded. */
  placeholder?: boolean;
}) {
  const { styles, theme, view, now } = props;
  const { item, aggregate, links } = view;
  const [hovered, setHovered] = useState(false);
  const cardRef = useRef<View | null>(null);
  const menuRef = useRef<View | null>(null);
  const openMenu = (target: View | null) => void measureInWindow(target).then((anchor) => anchor && props.onMenu(view, anchor));
  const hover = { onHoverIn: () => setHovered(true), onHoverOut: () => setHovered(false) };
  const presentation = AGGREGATE_PRESENTATION[aggregate.state];
  const latest = latestLink(links);
  const agent = latest ? DISPLAY_STATE_PRESENTATION[latest.displayState] : null;
  const priority = PRIORITY_PRESENTATION[item.priority];
  const status = STATUS_PRESENTATION[item.status];
  const badge = CARD_BADGE_STATES.has(aggregate.state);
  // Open, move, drag and agent targets are siblings: a pressable nested in a pressable renders as
  // a button inside a button on the web, which is invalid and misroutes clicks.
  return (
    <View ref={cardRef} style={[styles.boardCard, hovered ? styles.boardCardHovered : null, props.placeholder ? { opacity: 0.35 } : null]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`#${item.number} ${item.title}, ${WORK_ITEM_STATUS_LABELS[item.status]}, ${WORK_ITEM_PRIORITY_LABELS[item.priority]}, ${presentation.label}`}
        accessibilityHint="Opens the card. Long press to edit or move it."
        onPress={() => props.onOpen(view)}
        onLongPress={() => openMenu(cardRef.current)}
        {...hover}
        style={{ gap: 5 }}
      >
        {/* Room on either side of the meta line for the grip and the menu, which float over it. */}
        <View style={[styles.row, { gap: 6, minHeight: 22, paddingLeft: props.dragHandle ? 14 : 0, paddingRight: 24 }]}>
          {props.showStatus ? <Icon name={status.icon} size={12} color={theme.colors[status.color]} /> : null}
          <Text style={[styles.metaText, { fontVariant: ["tabular-nums"] }]}>#{item.number}</Text>
          {props.showProject ? (
            <View style={[styles.row, { gap: 4, flexShrink: 1, minWidth: 0 }]}>
              <Icon name="Folder" size={11} color={theme.colors.foregroundMuted} />
              <Text style={[styles.metaText, { flexShrink: 1 }]} numberOfLines={1}>
                {item.projectNameSnapshot}
              </Text>
            </View>
          ) : null}
          {item.images.length > 0 ? (
            <View style={[styles.row, { gap: 3, flexShrink: 0 }]} accessibilityLabel={`${item.images.length} image${item.images.length > 1 ? "s" : ""}`}>
              <Icon name="Image" size={11} color={theme.colors.foregroundMuted} />
              <Text style={styles.metaText}>{item.images.length}</Text>
            </View>
          ) : null}
          {item.files.length > 0 ? (
            <View style={[styles.row, { gap: 3, flexShrink: 0 }]} accessibilityLabel={`${item.files.length} file${item.files.length > 1 ? "s" : ""}`}>
              <Icon name="Paperclip" size={11} color={theme.colors.foregroundMuted} />
              <Text style={styles.metaText}>{item.files.length}</Text>
            </View>
          ) : null}
          {/* Priority shares the meta line rather than taking a row of its own. */}
          {item.priority !== "none" ? (
            <View style={[styles.row, { gap: 3, marginLeft: "auto", flexShrink: 0 }]}>
              <Icon name={priority.icon} size={12} color={theme.colors[priority.color]} />
              <Text style={[styles.metaText, { color: theme.colors.foreground }]}>{WORK_ITEM_PRIORITY_LABELS[item.priority]}</Text>
            </View>
          ) : null}
        </View>
        <Text style={styles.cardTitle} numberOfLines={3}>
          {item.title}
        </Text>
        {item.details ? (
          <Text style={styles.cardDetails} numberOfLines={2}>
            {item.details}
          </Text>
        ) : null}
        {badge ? (
          <View style={[styles.metaRow, { paddingTop: 2 }]}>
            <Badge styles={styles} theme={theme} label={presentation.label} icon={presentation.icon} tone={presentation.tone} />
          </View>
        ) : null}
      </Pressable>
      {props.dragHandle ? <View style={{ position: "absolute", left: 5, top: 10, opacity: hovered ? 1 : 0.4 }}>{props.dragHandle}</View> : null}
      <View ref={menuRef} collapsable={false} style={{ position: "absolute", right: 6, top: 7 }}>
        <IconButton styles={styles} theme={theme} icon="Ellipsis" label={`Actions for #${item.number} ${item.title}`} dim={!hovered} onPress={() => openMenu(menuRef.current)} />
      </View>
      {latest && agent ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open agent, ${agent.label}`}
          disabled={!props.onOpenAgent}
          onPress={() => props.onOpenAgent?.(latest.agentId)}
          {...hover}
          style={({ hovered: over }: { hovered?: boolean; pressed: boolean }) => [
            styles.row,
            { gap: 6, marginTop: 2, paddingTop: 7, borderTopWidth: 1, borderTopColor: theme.colors.border },
            over && props.onOpenAgent ? { opacity: 0.8 } : null,
          ]}
        >
          <View style={[styles.dot, { backgroundColor: theme.colors[DISPLAY_STATE_COLOR[latest.displayState]] }]} />
          <Text style={[styles.metaText, { flex: 1, color: theme.colors.foreground }]} numberOfLines={1}>
            {agent.label}
            {links.length > 1 ? <Text style={styles.metaText}>{` · +${links.length - 1}`}</Text> : null}
          </Text>
          <Text style={[styles.metaText, { flexShrink: 0 }]} numberOfLines={1}>
            {formatRelativeTime(latest.stateChangedAt, now)}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
