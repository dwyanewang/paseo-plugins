import type { PluginTheme } from "@getpaseo/plugin";
import { WORK_ITEM_STATUSES, type WorkItemStatus } from "../shared/schema";
import type { WorkItemView } from "./data";
import { AnchoredMenu } from "./floating-menu";
import type { Rect } from "./overlay";
import { statusItems } from "./work-item-editor";

/**
 * A card's quick menu, next to its "⋯" (or the card itself after a long press): edit it, or move it
 * to another column, the current one checked. Opening the card is a press on the card.
 */
export function MoveMenu(props: {
  theme: PluginTheme;
  target: { view: WorkItemView; anchor: Rect } | null;
  onClose: () => void;
  onEdit: (view: WorkItemView) => void;
  onMove: (view: WorkItemView, status: WorkItemStatus) => void;
}) {
  const { theme, target } = props;
  const items = target
    ? [
        { key: "edit", label: "Edit", icon: "Pencil" },
        ...statusItems(theme, WORK_ITEM_STATUSES, target.view.item.status).map((item) => ({ ...item, section: "Move to" })),
      ]
    : [];
  return (
    <AnchoredMenu
      theme={theme}
      anchor={target?.anchor ?? null}
      onClose={props.onClose}
      label={target ? `#${target.view.item.number}` : "Card"}
      items={items}
      align="end"
      onSelect={(key) => {
        if (!target) return;
        if (key === "edit") props.onEdit(target.view);
        else if (key !== target.view.item.status) props.onMove(target.view, key as WorkItemStatus);
      }}
    />
  );
}
