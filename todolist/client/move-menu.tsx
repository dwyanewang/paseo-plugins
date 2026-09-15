import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, Modal } from "@getpaseo/plugin/client/react-native";
import { Pressable, Text, View } from "react-native";
import { WORK_ITEM_PRIORITY_LABELS, WORK_ITEM_STATUS_LABELS } from "../shared/board";
import { WORK_ITEM_PRIORITIES, WORK_ITEM_STATUSES, type WorkItemPriority, type WorkItemStatus } from "../shared/schema";
import { Button, Chip } from "./components";
import type { WorkItemView } from "./data";
import type { TodoStyles } from "./styles";
import { PRIORITY_PRESENTATION, STATUS_PRESENTATION } from "./text";

/** Columns as radio chips: the keyboard and screen-reader way to move a card. */
export function StatusPicker(props: {
  styles: TodoStyles;
  theme: PluginTheme;
  value: WorkItemStatus;
  onChange: (status: WorkItemStatus) => void;
  statuses?: readonly WorkItemStatus[];
}) {
  const { styles, theme } = props;
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel="Column" style={[styles.rowWrap, { gap: 6 }]}>
      {(props.statuses ?? WORK_ITEM_STATUSES).map((status) => (
        <Chip
          key={status}
          styles={styles}
          theme={theme}
          role="radio"
          label={WORK_ITEM_STATUS_LABELS[status]}
          icon={STATUS_PRESENTATION[status].icon}
          iconColor={theme.colors[STATUS_PRESENTATION[status].color]}
          selected={status === props.value}
          onPress={() => props.onChange(status)}
        />
      ))}
    </View>
  );
}

export function PriorityPicker(props: {
  styles: TodoStyles;
  theme: PluginTheme;
  value: WorkItemPriority;
  onChange: (priority: WorkItemPriority) => void;
}) {
  const { styles, theme } = props;
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel="Priority" style={[styles.rowWrap, { gap: 6 }]}>
      {WORK_ITEM_PRIORITIES.map((priority) => (
        <Chip
          key={priority}
          styles={styles}
          theme={theme}
          role="radio"
          label={WORK_ITEM_PRIORITY_LABELS[priority]}
          icon={PRIORITY_PRESENTATION[priority].icon}
          iconColor={theme.colors[PRIORITY_PRESENTATION[priority].color]}
          selected={priority === props.value}
          onPress={() => props.onChange(priority)}
        />
      ))}
    </View>
  );
}

/** A card's quick menu: one row per column, the current one checked. */
export function MoveMenu(props: {
  styles: TodoStyles;
  theme: PluginTheme;
  view: WorkItemView | null;
  onClose: () => void;
  onMove: (view: WorkItemView, status: WorkItemStatus) => void;
  onOpenDetails: (view: WorkItemView) => void;
}) {
  const { styles, theme, view } = props;
  const item = view?.item;
  return (
    <Modal title={item ? `Move #${item.number}` : "Move"} open={view !== null} onOpenChange={(open) => !open && props.onClose()}>
      <Modal.Content>
        {view && item ? (
          <>
            <Text style={styles.detailTitle} numberOfLines={2}>
              {item.title}
            </Text>
            <View accessibilityRole="radiogroup" accessibilityLabel="Column" style={{ gap: 4 }}>
              {WORK_ITEM_STATUSES.map((status) => {
                const current = status === item.status;
                const presentation = STATUS_PRESENTATION[status];
                return (
                  <Pressable
                    key={status}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: current, selected: current }}
                    aria-checked={current}
                    accessibilityLabel={WORK_ITEM_STATUS_LABELS[status]}
                    onPress={() => {
                      props.onClose();
                      props.onMove(view, status);
                    }}
                    style={({ hovered }: { hovered?: boolean; pressed: boolean }) => [
                      styles.listRow,
                      { borderColor: "transparent", backgroundColor: "transparent" },
                      hovered || current ? { backgroundColor: theme.colors.surface1, borderColor: theme.colors.border } : null,
                    ]}
                  >
                    <Icon name={presentation.icon} size={15} color={theme.colors[presentation.color]} />
                    <Text style={[styles.body, { flex: 1, fontWeight: current ? "600" : "400" }]}>{WORK_ITEM_STATUS_LABELS[status]}</Text>
                    {current ? <Icon name="Check" size={15} color={theme.colors.foregroundMuted} /> : null}
                  </Pressable>
                );
              })}
            </View>
            <View style={styles.divider} />
            <Button styles={styles} theme={theme} label="Open details" icon="PanelRight" variant="ghost" onPress={() => props.onOpenDetails(view)} />
          </>
        ) : null}
      </Modal.Content>
    </Modal>
  );
}
