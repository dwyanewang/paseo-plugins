import type { PluginTheme } from "@getpaseo/plugin";
import { Modal } from "@getpaseo/plugin/client/react-native";
import { Text, View } from "react-native";
import { WORK_ITEM_STATUS_LABELS } from "../shared/board";
import { WORK_ITEM_STATUSES, type WorkItemStatus } from "../shared/schema";
import { Button, Chip } from "./components";
import type { WorkItemView } from "./data";
import type { TodoStyles } from "./styles";
import { STATUS_PRESENTATION } from "./text";

/** Every column as a radio chip: the keyboard and screen-reader way to move a card. */
export function StatusPicker(props: {
  styles: TodoStyles;
  theme: PluginTheme;
  value: WorkItemStatus;
  onChange: (status: WorkItemStatus) => void;
}) {
  const { styles, theme } = props;
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel="Column" style={styles.rowWrap}>
      {WORK_ITEM_STATUSES.map((status) => (
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

export function MoveMenu(props: {
  styles: TodoStyles;
  theme: PluginTheme;
  view: WorkItemView | null;
  onClose: () => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMove: (view: WorkItemView, status: WorkItemStatus) => void;
  onMoveUp: (view: WorkItemView) => void;
  onMoveDown: (view: WorkItemView) => void;
  onOpenDetails: (view: WorkItemView) => void;
}) {
  const { styles, theme, view } = props;
  const item = view?.item;
  return (
    <Modal title={item ? `Move #${item.number}` : "Move"} open={view !== null} onOpenChange={(open) => !open && props.onClose()}>
      <Modal.Content>
        {view && item ? (
          <>
            <Text style={styles.title}>{item.title}</Text>
            <StatusPicker
              styles={styles}
              theme={theme}
              value={item.status}
              onChange={(status) => {
                props.onClose();
                props.onMove(view, status);
              }}
            />
            <View style={styles.rowWrap}>
              <Button styles={styles} theme={theme} label="Move up" icon="ArrowUp" disabled={!props.canMoveUp} onPress={() => props.onMoveUp(view)} accessibilityLabel={`Move #${item.number} up in ${WORK_ITEM_STATUS_LABELS[item.status]}`} />
              <Button styles={styles} theme={theme} label="Move down" icon="ArrowDown" disabled={!props.canMoveDown} onPress={() => props.onMoveDown(view)} accessibilityLabel={`Move #${item.number} down in ${WORK_ITEM_STATUS_LABELS[item.status]}`} />
            </View>
            <Button styles={styles} theme={theme} label="Open details" icon="PanelRight" onPress={() => props.onOpenDetails(view)} />
          </>
        ) : null}
      </Modal.Content>
    </Modal>
  );
}
