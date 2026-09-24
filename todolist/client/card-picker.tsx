import type { PluginTheme } from "@getpaseo/plugin";
import { useEffect, useState } from "react";
import { Text } from "react-native";
import { WORK_ITEM_STATUS_LABELS, type BoardColumn } from "../shared/board";
import type { WorkItemStatus } from "../shared/schema";
import type { WorkItemView } from "./data";
import { AnchoredMenu } from "./floating-menu";
import type { Rect } from "./overlay";
import { TextAction } from "./overlay-parts";
import { PRIORITY_PRESENTATION } from "./text";

export interface PickRequest {
  target: WorkItemStatus;
  /** Candidate cards grouped by the column they come from, in board order. */
  groups: BoardColumn<WorkItemView>[];
  multiple: boolean;
  /** The column's "+", in window coordinates. */
  anchor: Rect;
}

/**
 * Pulls existing cards into a column from a menu on its "+": one card to start in In progress,
 * several reviewed cards to mark Done. Candidates follow the board's current project filter and
 * search.
 */
export function CardPicker(props: {
  theme: PluginTheme;
  request: PickRequest | null;
  showProject: boolean;
  onClose: () => void;
  onConfirm: (target: WorkItemStatus, views: WorkItemView[]) => void;
}) {
  const { theme } = props;
  const request = props.request ?? { target: "done" as const, groups: [], multiple: false, anchor: { x: 0, y: 0, width: 0, height: 0 } };
  const [selected, setSelected] = useState<string[]>([]);
  // Each opening starts with nothing selected.
  useEffect(() => setSelected([]), [props.request]);
  const candidates = request.groups.flatMap((group) => group.views);
  const chosen = candidates.filter((view) => selected.includes(view.item.id));
  const sectioned = request.groups.filter((group) => group.views.length > 0).length > 1;
  const items = request.groups.flatMap((group) =>
    group.views.map((view) => ({
      key: view.item.id,
      label: `#${view.item.number} ${view.item.title}`,
      ...(props.showProject ? { hint: view.item.projectNameSnapshot } : {}),
      icon: PRIORITY_PRESENTATION[view.item.priority].icon,
      iconColor: theme.colors[PRIORITY_PRESENTATION[view.item.priority].color],
      checked: selected.includes(view.item.id),
      ...(sectioned ? { section: WORK_ITEM_STATUS_LABELS[group.status] } : {}),
    })),
  );
  const sources = request.groups.map((group) => WORK_ITEM_STATUS_LABELS[group.status]).join(" or ");
  return (
    <AnchoredMenu
      theme={theme}
      anchor={props.request ? request.anchor : null}
      onClose={props.onClose}
      label={request.multiple ? `Add cards to ${WORK_ITEM_STATUS_LABELS[request.target]}` : `Add a card to ${WORK_ITEM_STATUS_LABELS[request.target]}`}
      items={items}
      multiple={request.multiple}
      width={320}
      align="end"
      note={
        request.multiple
          ? { icon: "CircleCheck", text: "Mark reviewed cards as Done" }
          : { icon: "Play", text: "Choose the card to start. Moving it opens the run box." }
      }
      filter={{ placeholder: "Filter cards…", noun: "cards" }}
      empty={candidates.length === 0 ? `No cards in ${sources} match the current filter.` : "No matching cards"}
      {...(request.multiple
        ? {
            footer: (
              <>
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{`${chosen.length} selected`}</Text>
                <TextAction
                  theme={theme}
                  small
                  kind="accent"
                  icon="Check"
                  label={chosen.length > 0 ? `Move ${chosen.length} to ${WORK_ITEM_STATUS_LABELS[request.target]}` : `Move to ${WORK_ITEM_STATUS_LABELS[request.target]}`}
                  disabled={chosen.length === 0}
                  onPress={() => props.onConfirm(request.target, chosen)}
                />
              </>
            ),
          }
        : {})}
      onSelect={(id) => {
        if (!request.multiple) {
          const view = candidates.find((candidate) => candidate.item.id === id);
          if (view) props.onConfirm(request.target, [view]);
          return;
        }
        setSelected((current) => (current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]));
      }}
    />
  );
}
