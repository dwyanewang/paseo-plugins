import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, Modal } from "@getpaseo/plugin/client/react-native";
import { Pressable, Text, View } from "react-native";
import { WORK_ITEM_STATUS_LABELS } from "../shared/board";
import { WORK_ITEM_STATUSES, type WorkItemStatus } from "../shared/schema";
import { Button } from "./components";
import type { WorkItemView } from "./data";
import type { TodoStyles } from "./styles";
import { STATUS_PRESENTATION } from "./text";

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
