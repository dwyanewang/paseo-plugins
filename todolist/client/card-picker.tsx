import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, Modal } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { WORK_ITEM_PRIORITY_LABELS, WORK_ITEM_STATUS_LABELS, type BoardColumn } from "../shared/board";
import type { WorkItemStatus } from "../shared/schema";
import { Button } from "./components";
import type { WorkItemView } from "./data";
import type { TodoStyles } from "./styles";
import { PRIORITY_PRESENTATION } from "./text";

export interface PickRequest {
  target: WorkItemStatus;
  /** Candidate cards grouped by the column they come from, in board order. */
  groups: BoardColumn<WorkItemView>[];
  multiple: boolean;
}

/**
 * Pulls existing cards into a column: one card to start in In progress, several reviewed cards to
 * mark Done. Candidates follow the board's current project filter and search.
 */
export function CardPicker(props: {
  styles: TodoStyles;
  theme: PluginTheme;
  request: PickRequest | null;
  showProject: boolean;
  onClose: () => void;
  onConfirm: (target: WorkItemStatus, views: WorkItemView[]) => void;
}) {
  const { request } = props;
  const label = request ? WORK_ITEM_STATUS_LABELS[request.target] : "";
  return (
    <Modal
      title={request?.multiple ? `Add cards to ${label}` : `Add a card to ${label}`}
      open={request !== null}
      onOpenChange={(open) => !open && props.onClose()}
    >
      {/* The body mounts per opening, so the selection starts empty every time. */}
      <Modal.Content>{request ? <PickerBody {...props} request={request} /> : null}</Modal.Content>
    </Modal>
  );
}

function PickerBody(props: {
  styles: TodoStyles;
  theme: PluginTheme;
  request: PickRequest;
  showProject: boolean;
  onClose: () => void;
  onConfirm: (target: WorkItemStatus, views: WorkItemView[]) => void;
}) {
  const { styles, theme, request } = props;
  const [selected, setSelected] = useState<string[]>([]);
  const candidates = request.groups.flatMap((group) => group.views);
  const chosen = candidates.filter((view) => selected.includes(view.item.id));
  const toggle = (id: string) =>
    setSelected((current) => (request.multiple ? (current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]) : [id]));
  const confirmLabel = request.target !== "done" ? "Move to In progress" : chosen.length > 1 ? `Mark ${chosen.length} done` : "Mark done";
  return (
    <>
      {candidates.length === 0 ? (
        <Text style={styles.muted}>
          {`No cards in ${request.groups.map((group) => WORK_ITEM_STATUS_LABELS[group.status]).join(" or ")} match the current filter.`}
        </Text>
      ) : null}
      {request.groups
        .filter((group) => group.views.length > 0)
        .map((group) => (
          <View key={group.status} style={{ gap: 6 }}>
            <Text style={styles.sectionTitle}>
              {WORK_ITEM_STATUS_LABELS[group.status]} ({group.views.length})
            </Text>
            {group.views.map((view) => {
              const checked = selected.includes(view.item.id);
              const priority = PRIORITY_PRESENTATION[view.item.priority];
              return (
                <Pressable
                  key={view.item.id}
                  accessibilityRole={request.multiple ? "checkbox" : "radio"}
                  accessibilityState={{ checked }}
                  aria-checked={checked}
                  accessibilityLabel={`#${view.item.number} ${view.item.title}, ${WORK_ITEM_PRIORITY_LABELS[view.item.priority]}`}
                  onPress={() => toggle(view.item.id)}
                  style={[styles.boardCard, { flexDirection: "row", alignItems: "center", gap: 10 }, checked ? styles.columnDropTarget : null]}
                >
                  <Icon
                    name={request.multiple ? (checked ? "SquareCheck" : "Square") : checked ? "CircleDot" : "Circle"}
                    size={18}
                    color={checked ? theme.colors.accent : theme.colors.foregroundMuted}
                  />
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={styles.title} numberOfLines={1}>
                      {view.item.title}
                    </Text>
                    <Text style={styles.mono} numberOfLines={1}>
                      #{view.item.number}
                      {props.showProject ? ` · ${view.item.projectNameSnapshot}` : ""}
                    </Text>
                  </View>
                  {view.item.priority !== "none" ? <Icon name={priority.icon} size={14} color={theme.colors[priority.color]} /> : null}
                </Pressable>
              );
            })}
          </View>
        ))}
      <View style={styles.rowWrap}>
        <Button
          styles={styles}
          theme={theme}
          label={confirmLabel}
          icon={request.target === "done" ? "CircleCheck" : "Play"}
          variant="primary"
          disabled={chosen.length === 0}
          onPress={() => props.onConfirm(request.target, chosen)}
        />
        <Button styles={styles} theme={theme} label="Cancel" onPress={props.onClose} />
      </View>
    </>
  );
}
