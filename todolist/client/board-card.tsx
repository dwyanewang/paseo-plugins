import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { WORK_ITEM_STATUS_LABELS, formatRelativeTime, latestLink } from "../shared/board";
import { Badge } from "./components";
import type { WorkItemView } from "./data";
import type { TodoStyles } from "./styles";
import { AGGREGATE_PRESENTATION, CARD_BADGE_STATES, DISPLAY_STATE_COLOR, DISPLAY_STATE_PRESENTATION } from "./text";

export function BoardCard(props: {
  styles: TodoStyles;
  theme: PluginTheme;
  view: WorkItemView;
  now: number;
  onOpen: (view: WorkItemView) => void;
  onMenu: (view: WorkItemView) => void;
  onOpenAgent: ((agentId: string) => void) | null;
  /** Outside the columns (the Archived list) the card names its column itself. */
  showStatus?: boolean;
  /** Grip for pointer drag on wide boards. */
  dragHandle?: ReactNode;
}) {
  const { styles, theme, view, now } = props;
  const { item, aggregate, links } = view;
  const presentation = AGGREGATE_PRESENTATION[aggregate.state];
  const latest = latestLink(links);
  const agent = latest ? DISPLAY_STATE_PRESENTATION[latest.displayState] : null;
  // Open, move and agent targets are siblings: a pressable nested in a pressable renders as a
  // button inside a button on the web, which is invalid and misroutes clicks.
  return (
    <View style={styles.boardCard}>
      <View style={[styles.row, { alignItems: "flex-start", gap: 4 }]}>
        {props.dragHandle}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`#${item.number} ${item.title}, ${WORK_ITEM_STATUS_LABELS[item.status]}, ${presentation.label}`}
          accessibilityHint="Opens details. Long press for move actions."
          onPress={() => props.onOpen(view)}
          onLongPress={() => props.onMenu(view)}
          style={{ flex: 1, gap: 6 }}
        >
          <View style={styles.row}>
            <Text style={[styles.mono, { flex: 1 }]}>
              #{item.number}
              {props.showStatus ? ` · ${WORK_ITEM_STATUS_LABELS[item.status]}` : ""}
            </Text>
            {CARD_BADGE_STATES.has(aggregate.state) ? (
              <Badge styles={styles} theme={theme} label={presentation.label} icon={presentation.icon} tone={presentation.tone} />
            ) : null}
          </View>
          <Text style={styles.title} numberOfLines={2}>
            {item.title}
          </Text>
          {item.details ? (
            <Text style={styles.muted} numberOfLines={2}>
              {item.details}
            </Text>
          ) : null}
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Move #${item.number} ${item.title}`}
          hitSlop={8}
          onPress={() => props.onMenu(view)}
          style={[styles.iconButton, { alignSelf: "flex-start" }]}
        >
          <Icon name="Ellipsis" size={16} color={theme.colors.foregroundMuted} />
        </Pressable>
      </View>
      {latest && agent ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open agent, ${agent.label}`}
          disabled={!props.onOpenAgent}
          onPress={() => props.onOpenAgent?.(latest.agentId)}
          style={styles.agentLine}
        >
          <View style={[styles.row, { gap: 6 }]}>
            <View style={[styles.dot, { backgroundColor: theme.colors[DISPLAY_STATE_COLOR[latest.displayState]] }]} />
            <Text style={[styles.mono, { flex: 1 }]} numberOfLines={1}>
              {agent.label}
            </Text>
            <Text style={[styles.mono, { flexShrink: 0 }]} numberOfLines={1}>
              {formatRelativeTime(latest.stateChangedAt, now)}
            </Text>
          </View>
          <Text style={styles.mono} numberOfLines={1}>
            {latest.provider}
            {latest.model ? ` · ${latest.model}` : ""}
            {links.length > 1 ? ` · +${links.length - 1} more` : ""}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
