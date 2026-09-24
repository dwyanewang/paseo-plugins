import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, ScrollView as HostScrollView } from "@getpaseo/plugin/client/react-native";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Keyboard, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type TextStyle, type ViewStyle } from "react-native";
import { AnchoredOverlay, EDGE, GAP, HOST_OVERLAY, OverlayLayer, measureInWindow, placeNear, useDismiss, useEmbed, useOptionalOverlay, useOverlay, type Placement, type Rect } from "./overlay";
import { IconAction, Tip } from "./overlay-parts";
import { isDarkTheme } from "./styles";
import { attachMouseScrollWeb, subscribeMenuKeysWeb, type MenuKeyWeb } from "./web";

export interface MenuItem {
  key: string;
  label: string;
  /** Second line, such as a project path. */
  hint?: string;
  /** The hint is a path or an identifier, set in monospace. */
  mono?: boolean;
  icon?: string;
  iconColor?: string;
  /** Shown at the row's end, such as the `!2` that also sets this priority. */
  shortcut?: string;
  /** The current value: a check at the row's end, or a ticked box in a multiple choice. */
  checked?: boolean;
  /** Rows sharing a section sit under its small heading, in the order given. */
  section?: string;
}

/** The field draws focus itself, so the browser's ring around it would draw a second one. */
export const WEB_TEXT_INPUT = (Platform.OS === "web" ? { outlineStyle: "none", outlineWidth: 0 } : {}) as TextStyle;

/** Rough heights, so a menu can pick above or below before it has laid out. */
export function estimateMenuHeight(input: { rows: number; twoLine?: boolean; filter?: boolean; note?: boolean; footer?: boolean; sections?: number }): number {
  return (
    12 +
    input.rows * (input.twoLine ? 48 : 36) +
    (input.filter ? 44 : 0) +
    (input.note ? 48 : 0) +
    (input.footer ? 44 : 0) +
    (input.sections ?? 0) * 26
  );
}

/** Items whose label, hint or section contains the query, case-insensitively. */
export function filterItems<Item extends MenuItem>(items: readonly Item[], query: string): Item[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...items];
  return items.filter((item) => [item.label, item.hint ?? "", item.section ?? ""].some((text) => text.toLowerCase().includes(needle)));
}

/** Menus open newest last; the keys go to the newest. */
const keyedMenus: symbol[] = [];

/** Arrow keys and Enter for an open menu on the web; native menus are touched, not typed at. */
export function useMenuKeys(active: boolean, onKey: (key: MenuKeyWeb) => boolean): void {
  const latest = useRef(onKey);
  latest.current = onKey;
  useEffect(() => {
    if (!active) return undefined;
    const token = Symbol("menu");
    keyedMenus.push(token);
    const unsubscribe = subscribeMenuKeysWeb((key) => keyedMenus[keyedMenus.length - 1] === token && latest.current(key));
    return () => {
      unsubscribe?.();
      const index = keyedMenus.indexOf(token);
      if (index !== -1) keyedMenus.splice(index, 1);
    };
  }, [active]);
}

/** Moves a highlight through `count` rows with the arrows; Enter chooses the highlighted one. */
export function useHighlight(active: boolean, count: number, initial: number, choose: (index: number) => void) {
  const [highlight, setHighlight] = useState(initial);
  useMenuKeys(active, (key) => {
    if (key === "choose") {
      if (highlight < 0 || highlight >= count) return false;
      choose(highlight);
      return true;
    }
    if (count > 0) setHighlight((current) => (Math.max(current, 0) + (key === "down" ? 1 : -1) + count) % count);
    return true;
  });
  return [highlight, setHighlight] as const;
}

/**
 * Evenly spaced strips from the background color to transparent: a gradient without a gradient
 * primitive, for "there is more this way" edges on scrolling areas.
 */
export function EdgeFade(props: { side: "left" | "right" | "top" | "bottom"; color: string; size?: number }) {
  const size = props.size ?? 26;
  const steps = 6;
  const horizontal = props.side === "left" || props.side === "right";
  const reversed = props.side === "right" || props.side === "bottom";
  const edge: ViewStyle = horizontal
    ? { top: 0, bottom: 0, width: size, flexDirection: reversed ? "row-reverse" : "row", ...(reversed ? { right: 0 } : { left: 0 }) }
    : { left: 0, right: 0, height: size, flexDirection: reversed ? "column-reverse" : "column", ...(reversed ? { bottom: 0 } : { top: 0 }) };
  return (
    <View pointerEvents="none" style={[{ position: "absolute", zIndex: 1 }, edge]}>
      {Array.from({ length: steps }, (_, index) => (
        <View key={index} style={{ flex: 1, backgroundColor: props.color, opacity: 0.95 * (1 - index / steps) }} />
      ))}
    </View>
  );
}

/**
 * A menu floating above everything, sized by `placement`. It never grows the box it came from.
 * The owner keeps the highlight, so keys typed anywhere move the same row.
 */
export function FloatingMenu(props: {
  theme: PluginTheme;
  label: string;
  /** Where it floats, or "inline" to sit in the flow of an embedding box. */
  placement: Placement | "inline";
  items: readonly MenuItem[];
  highlight: number;
  onHighlight: (index: number) => void;
  onSelect: (key: string) => void;
  /** Rows are ticked on and off rather than chosen once. */
  multiple?: boolean;
  /** A line on top saying what choosing does. */
  note?: { icon: string; text: string };
  filter?: { query: string; onQuery: (query: string) => void; placeholder: string; autoFocus: boolean; onSubmit: () => void };
  empty?: string;
  footer?: ReactNode;
}) {
  const { theme, placement } = props;
  const scroll = useRef<ScrollView | null>(null);
  const rows = useRef(new Map<number, { y: number; height: number }>());
  const view = useRef({ offset: 0, height: 0 });
  const dark = isDarkTheme(theme);

  // Keep the highlighted row in view as the arrows move it.
  useEffect(() => {
    const row = rows.current.get(props.highlight);
    if (!row || !scroll.current) return;
    const { offset, height } = view.current;
    if (row.y < offset) scroll.current.scrollTo({ y: row.y, animated: false });
    else if (row.y + row.height > offset + height) scroll.current.scrollTo({ y: row.y + row.height - height, animated: false });
  }, [props.highlight]);

  const muted = theme.colors.foregroundMuted;
  let section: string | undefined;
  // Inline, the menu scrolls inside the host surface it sits in, so the host's scroll view keeps
  // it from fighting a host sheet. Floating, it sits in an overlay, which is no sheet even when a
  // sheet opened it; the host's scroll view cannot tell, so the plain one scrolls there.
  const MenuScroll = placement === "inline" ? HostScrollView : ScrollView;
  return (
    <View
      accessibilityRole="menu"
      accessibilityLabel={props.label}
      style={[
        {
          position: "absolute",
          zIndex: 30,
          backgroundColor: theme.colors.surface0,
          borderColor: theme.colors.border,
          borderWidth: 1,
          borderRadius: 12,
          padding: 5,
          boxShadow: dark ? "0px 12px 36px rgba(0, 0, 0, 0.55), 0px 1px 3px rgba(0, 0, 0, 0.4)" : "0px 12px 36px rgba(24, 24, 27, 0.16), 0px 1px 3px rgba(24, 24, 27, 0.08)",
        },
        placement === "inline" ? { position: "relative", marginTop: 8, maxHeight: 260, boxShadow: "none" } : placement,
      ]}
    >
      {props.note ? (
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 6, paddingHorizontal: 9, paddingTop: 6, paddingBottom: 8, marginBottom: 4, borderBottomWidth: 1, borderBottomColor: theme.colors.border }}>
          <View style={{ paddingTop: 1 }}>
            <Icon name={props.note.icon} size={12} color={muted} />
          </View>
          <Text style={{ flex: 1, color: muted, fontSize: 11.5, lineHeight: 16 }}>{props.note.text}</Text>
        </View>
      ) : null}
      {props.filter ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, height: 36, paddingHorizontal: 9, marginBottom: 4, borderBottomWidth: 1, borderBottomColor: theme.colors.border }}>
          <Icon name="Search" size={14} color={muted} />
          <TextInput
            value={props.filter.query}
            onChangeText={props.filter.onQuery}
            autoFocus={props.filter.autoFocus}
            placeholder={props.filter.placeholder}
            placeholderTextColor={muted}
            accessibilityLabel={props.filter.placeholder}
            autoCorrect={false}
            autoCapitalize="none"
            blurOnSubmit={false}
            // The web reads Enter through the menu keys; native keyboards submit instead.
            onSubmitEditing={() => Platform.OS !== "web" && props.filter?.onSubmit()}
            style={[{ flex: 1, minWidth: 0, color: theme.colors.foreground, fontSize: 13, paddingVertical: 6 }, WEB_TEXT_INPUT]}
          />
        </View>
      ) : null}
      <MenuScroll
        ref={scroll}
        style={{ flexGrow: 0, flexShrink: 1 }}
        keyboardShouldPersistTaps="handled"
        bounces={false}
        scrollEventThrottle={16}
        onLayout={(event) => {
          view.current.height = event.nativeEvent.layout.height;
        }}
        onScroll={(event) => {
          view.current.offset = event.nativeEvent.contentOffset.y;
        }}
      >
        {props.items.map((item, index) => {
          const heading = item.section && item.section !== section ? item.section : null;
          section = item.section;
          return (
            <View key={item.key}>
              {heading ? (
                <Text style={{ color: muted, fontSize: 11, fontWeight: "600", letterSpacing: 0.4, textTransform: "uppercase", paddingHorizontal: 9, paddingTop: 6, paddingBottom: 3 }}>
                  {heading}
                </Text>
              ) : null}
              <Pressable
                accessibilityRole={props.multiple ? "checkbox" : "menuitem"}
                accessibilityState={{ checked: Boolean(item.checked), selected: index === props.highlight }}
                accessibilityLabel={item.hint ? `${item.label}, ${item.hint}` : item.label}
                // Focus stays in the text field, where the keys are read.
                focusable={false}
                onLayout={(event) => rows.current.set(index, { y: event.nativeEvent.layout.y, height: event.nativeEvent.layout.height })}
                onHoverIn={() => props.onHighlight(index)}
                onPress={() => props.onSelect(item.key)}
                style={({ pressed }: { pressed: boolean }) => [
                  { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 9, paddingVertical: 7, borderRadius: 7 },
                  index === props.highlight || pressed ? { backgroundColor: theme.colors.surface2 } : null,
                ]}
              >
                {props.multiple ? (
                  <View
                    style={{
                      width: 16,
                      height: 16,
                      borderRadius: 4,
                      borderWidth: 1.5,
                      alignItems: "center",
                      justifyContent: "center",
                      borderColor: item.checked ? theme.colors.accent : muted,
                      backgroundColor: item.checked ? theme.colors.accent : "transparent",
                    }}
                  >
                    {item.checked ? <Icon name="Check" size={11} color={theme.colors.accentForeground} /> : null}
                  </View>
                ) : null}
                {item.icon ? <Icon name={item.icon} size={14} color={item.iconColor ?? muted} /> : null}
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={{ color: theme.colors.foreground, fontSize: 13, lineHeight: 18 }} numberOfLines={1}>
                    {item.label}
                  </Text>
                  {item.hint ? (
                    <Text style={{ color: muted, fontSize: 11.5, ...(item.mono ? { fontFamily: "monospace" } : {}) }} numberOfLines={1}>
                      {item.hint}
                    </Text>
                  ) : null}
                </View>
                {item.shortcut ? <Text style={{ color: muted, fontSize: 11 }}>{item.shortcut}</Text> : null}
                {!props.multiple && item.checked ? <Icon name="Check" size={14} color={theme.colors.foreground} /> : null}
              </Pressable>
            </View>
          );
        })}
        {props.items.length === 0 ? (
          <Text style={{ color: muted, fontSize: 12, paddingHorizontal: 9, paddingVertical: 10 }}>{props.empty ?? "Nothing to choose from."}</Text>
        ) : null}
      </MenuScroll>
      {props.footer ? (
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8, paddingLeft: 9, paddingRight: 4, paddingTop: 7, paddingBottom: 2, marginTop: 4, borderTopWidth: 1, borderTopColor: theme.colors.border }}>
          {props.footer}
        </View>
      ) : null}
    </View>
  );
}

/** Small print under a filtered menu: how many match, and the keys on a keyboard. */
export function MenuSummary(props: { theme: PluginTheme; text: string; keys: boolean }) {
  const muted = props.theme.colors.foregroundMuted;
  return (
    <>
      <Text style={{ color: muted, fontSize: 11.5 }} numberOfLines={1}>
        {props.text}
      </Text>
      {props.keys ? (
        <Text style={{ color: muted, fontSize: 11.5 }} numberOfLines={1}>
          ↑↓ select · ↵ choose · Esc close
        </Text>
      ) : null}
    </>
  );
}

/** A toolbar choice with its current value, like the composer's model pill. */
export function Pill(props: {
  theme: PluginTheme;
  pillRef?: RefObject<View | null>;
  icon: string;
  iconColor?: string;
  label: string;
  /** Quieter text after the label, such as the `!2` in the text that set this value. */
  token?: string | null;
  muted?: boolean;
  open?: boolean;
  accessibilityLabel: string;
  onPress?: () => void;
  /** Read-only here; hovering says where to change it. */
  locked?: string;
  disabled?: boolean;
}) {
  const { theme } = props;
  const [hovered, setHovered] = useState(false);
  const color = props.locked || props.muted ? theme.colors.foregroundMuted : theme.colors.foreground;
  return (
    <View>
      <Pressable
        ref={props.pillRef}
        accessibilityRole="button"
        accessibilityLabel={props.locked ? `${props.accessibilityLabel}. ${props.locked}` : `${props.accessibilityLabel}. Change`}
        accessibilityState={{ disabled: Boolean(props.locked || props.disabled), expanded: Boolean(props.open) }}
        disabled={props.disabled}
        onPress={props.locked ? undefined : props.onPress}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        style={[
          styles.pill,
          { borderColor: theme.colors.border, backgroundColor: theme.colors.surface1 },
          props.locked ? { backgroundColor: "transparent" } : null,
          hovered && !props.locked && !props.disabled ? { backgroundColor: theme.colors.surface2 } : null,
          props.open ? { borderColor: theme.colors.foregroundMuted, backgroundColor: theme.colors.surface2 } : null,
          props.disabled ? { opacity: 0.5 } : null,
        ]}
      >
        <Icon name={props.icon} size={13} color={props.iconColor ?? theme.colors.foregroundMuted} />
        <Text style={{ color, fontSize: 12.5, fontWeight: "500", flexShrink: 1 }} numberOfLines={1}>
          {props.label}
          {props.token ? <Text style={{ color: theme.colors.foregroundMuted, fontWeight: "400" }}>{` ${props.token}`}</Text> : null}
        </Text>
        {props.disabled && !props.locked ? null : (
          <Icon name={props.locked ? "Lock" : props.open ? "ChevronUp" : "ChevronDown"} size={12} color={theme.colors.foregroundMuted} />
        )}
      </Pressable>
      {hovered && props.locked ? <Tip theme={theme} label={props.locked} align="start" /> : null}
    </View>
  );
}

let nextStripId = 0;

/** Room around pills for the focus ring the web draws outside a focused control. */
const FOCUS_ROOM = 4;

/**
 * A row of pills that stays one line and scrolls sideways when it does not fit, with faded edges
 * where more is hidden. The scroll view is the host's, which inside a host sheet claims the
 * sideways drag before the sheet can take it; on the web a mouse can drag it or turn the wheel
 * over it (`attachMouseScrollWeb`).
 */
export function PillStrip(props: { theme: PluginTheme; children: ReactNode }) {
  const [strip, setStrip] = useState({ width: 0, content: 0, x: 0 });
  const [scrollId] = useState(() => `todo-pill-strip-${++nextStripId}`);
  useEffect(() => attachMouseScrollWeb(scrollId) ?? undefined, [scrollId]);
  const color = props.theme.colors.surface0;
  return (
    <View style={{ flex: 1, minWidth: 0 }}>
      <HostScrollView
        nativeID={scrollId}
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        scrollEventThrottle={16}
        onLayout={(event) => {
          const next = event.nativeEvent.layout.width;
          setStrip((current) => ({ ...current, width: next }));
        }}
        onContentSizeChange={(next) => setStrip((current) => ({ ...current, content: next }))}
        onScroll={(event) => {
          const next = event.nativeEvent.contentOffset.x;
          setStrip((current) => ({ ...current, x: next }));
        }}
        // A scroll view clips what overflows it, and on the web that includes a focused pill's
        // outline. Room inside for the ring, taken back outside, keeps the row the same height.
        style={{ marginVertical: -FOCUS_ROOM }}
        contentContainerStyle={{ flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: FOCUS_ROOM, paddingHorizontal: 3 }}
      >
        {props.children}
      </HostScrollView>
      {strip.x > 1 ? <EdgeFade side="left" color={color} /> : null}
      {strip.content - strip.width - strip.x > 1 ? <EdgeFade side="right" color={color} /> : null}
    </View>
  );
}

/**
 * A menu that belongs to a control inside a box and floats above the box. On desktops it hangs
 * from the control; with `underBox` on phones it drops under the whole box at its width, after
 * putting the keyboard away. A box embedded in a host surface floats its menus in an overlay of
 * their own, or, on hosts without overlays, opens them in a slot under its content.
 */
export function useBoxMenu(options: {
  theme: PluginTheme;
  label: string;
  items: readonly MenuItem[];
  onSelect: (key: string) => void;
  filter?: { placeholder: string; noun: string };
  note?: { icon: string; text: string };
  width?: number;
  underBox?: boolean;
  /** Called after the menu closes, to put focus back where typing continues. */
  onClosed?: () => void;
}) {
  const overlay = useOptionalOverlay();
  const embed = useEmbed();
  const phone = overlay?.phone ?? embed?.phone ?? false;
  const [owner] = useState(() => Symbol("menu"));
  const [anchor, setAnchor] = useState<Rect | null>(null);
  const [query, setQuery] = useState("");
  const open = anchor !== null;
  const shown = options.filter ? filterItems(options.items, query) : options.items;
  const close = () => {
    setAnchor(null);
    options.onClosed?.();
  };
  const choose = (key: string) => {
    close();
    options.onSelect(key);
  };
  const [highlight, setHighlight] = useHighlight(open, shown.length, 0, (index) => {
    const item = shown[index];
    if (item) choose(item.key);
  });
  useDismiss(open, close);

  async function toggle(view: View | null) {
    if (open) {
      close();
      return;
    }
    if (phone) Keyboard.dismiss();
    const rect = overlay ? await overlay.measure(view) : await measureInWindow(view);
    if (!rect) return;
    setQuery("");
    setHighlight(Math.max(0, options.items.findIndex((item) => item.checked)));
    setAnchor(rect);
  }

  const wanted = estimateMenuHeight({
    rows: Math.max(1, Math.min(8, options.items.length)),
    twoLine: options.items.some((item) => item.hint),
    filter: Boolean(options.filter),
    note: Boolean(options.note),
    footer: Boolean(options.filter),
    sections: new Set(options.items.map((item) => item.section).filter(Boolean)).size,
  });
  const width = options.width ?? (options.filter ? 340 : 220);
  const menu = (placement: Placement | "inline") => (
    <FloatingMenu
      theme={options.theme}
      label={options.label}
      placement={placement}
      items={shown}
      highlight={highlight}
      onHighlight={setHighlight}
      onSelect={choose}
      {...(options.note ? { note: options.note } : {})}
      {...(options.filter
        ? {
            filter: {
              query,
              onQuery: (next: string) => {
                setQuery(next);
                setHighlight(0);
              },
              placeholder: options.filter.placeholder,
              // Phones keep the keyboard down until the filter is tapped.
              autoFocus: !phone,
              onSubmit: () => {
                const item = shown[highlight];
                if (item) choose(item.key);
              },
            },
            empty: `No matching ${options.filter.noun}`,
            footer: (
              <MenuSummary
                theme={options.theme}
                text={query.trim() ? `${shown.length} of ${options.items.length} ${options.filter.noun}` : `${options.items.length} ${options.filter.noun}`}
                keys={!phone && Platform.OS === "web"}
              />
            ),
          }
        : {})}
    />
  );

  // Hosts without overlays: the embedding box shows the open menu under its content.
  const inline = !overlay && !HOST_OVERLAY && embed !== null;
  const inlineNode = inline && open ? menu("inline") : null;
  useLayoutEffect(() => {
    if (inline) embed?.setInlineMenu(owner, inlineNode);
  });
  useLayoutEffect(() => () => embed?.setInlineMenu(owner, null), [embed, owner]);

  let node: ReactNode = null;
  if (overlay) {
    let placement: Placement | null = null;
    const box = overlay.box;
    if (anchor && options.underBox && overlay.phone && box) {
      // Under the box at its width; over its lower part when the box leaves no room below.
      const limit = overlay.bottom - EDGE;
      const under = box.y + box.height + GAP;
      const top = limit - under >= 180 ? under : Math.max(box.y + 40, limit - 180);
      placement = { left: box.x, width: box.width, top, maxHeight: Math.min(wanted, limit - top) };
    } else if (anchor) {
      placement = placeNear({ anchor, root: overlay.root, bottom: overlay.bottom, width, wanted });
    }
    node = placement ? (
      <OverlayLayer>
        {/* A press anywhere else closes the menu and nothing more. */}
        <Pressable accessibilityLabel="Close menu" focusable={false} onPress={close} style={StyleSheet.absoluteFill} />
        {menu(placement)}
      </OverlayLayer>
    ) : null;
  } else if (!inline) {
    // Embedded in a host surface: the host's overlay layer floats the menu above it.
    node = (
      <AnchoredOverlay theme={options.theme} open={open} onClose={close} anchor={anchor} width={width} wanted={wanted}>
        {(placement) => menu(placement)}
      </AnchoredOverlay>
    );
  }
  return { open, toggle, node };
}

/** A pill that opens its menu above the box it sits in; see `useBoxMenu`. */
export function PillSelect(props: {
  theme: PluginTheme;
  /** What the choice is, for assistive technology and the menu. */
  label: string;
  icon: string;
  iconColor?: string;
  text: string;
  token?: string | null;
  muted?: boolean;
  locked?: string;
  disabled?: boolean;
  items: readonly MenuItem[];
  onSelect: (key: string) => void;
  filter?: { placeholder: string; noun: string };
  note?: { icon: string; text: string };
  width?: number;
  onClosed?: () => void;
}) {
  const pill = useRef<View | null>(null);
  const menu = useBoxMenu({
    theme: props.theme,
    label: props.label,
    items: props.items,
    onSelect: props.onSelect,
    underBox: true,
    ...(props.filter ? { filter: props.filter } : {}),
    ...(props.note ? { note: props.note } : {}),
    ...(props.width ? { width: props.width } : {}),
    ...(props.onClosed ? { onClosed: props.onClosed } : {}),
  });
  return (
    <>
      <Pill
        theme={props.theme}
        pillRef={pill}
        icon={props.icon}
        {...(props.iconColor ? { iconColor: props.iconColor } : {})}
        label={props.text}
        token={props.token ?? null}
        muted={Boolean(props.muted)}
        open={menu.open}
        accessibilityLabel={`${props.label}: ${props.text}`}
        onPress={() => void menu.toggle(pill.current)}
        {...(props.locked ? { locked: props.locked } : {})}
        disabled={Boolean(props.disabled)}
      />
      {menu.node}
    </>
  );
}

/** An icon button inside a box that opens a menu of actions, such as a card's "⋯". */
export function MenuButton(props: { theme: PluginTheme; icon: string; label: string; items: readonly MenuItem[]; onSelect: (key: string) => void }) {
  const button = useRef<View | null>(null);
  const menu = useBoxMenu({ theme: props.theme, label: props.label, items: props.items, onSelect: props.onSelect });
  return (
    <>
      <View ref={button} collapsable={false}>
        <IconAction theme={props.theme} icon={props.icon} label={props.label} kind="outline" onPress={() => void menu.toggle(button.current)} />
      </View>
      {menu.node}
    </>
  );
}

/**
 * A menu next to a button outside any box: a card's "⋯", a column's "+", the board's filters.
 * Closed by a press elsewhere or Escape; a multiple choice stays open until its footer acts.
 */
export function AnchoredMenu(props: {
  theme: PluginTheme;
  anchor: Rect | null;
  onClose: () => void;
  label: string;
  items: readonly MenuItem[];
  onSelect: (key: string) => void;
  multiple?: boolean;
  filter?: { placeholder: string; noun: string };
  note?: { icon: string; text: string };
  /** Given how many rows the filter leaves. */
  footer?: ReactNode;
  empty?: string;
  width?: number;
  align?: "start" | "end";
}) {
  const wanted = estimateMenuHeight({
    rows: Math.max(1, Math.min(8, props.items.length)),
    twoLine: props.items.some((item) => item.hint),
    filter: Boolean(props.filter),
    note: Boolean(props.note),
    footer: Boolean(props.footer),
    sections: new Set(props.items.map((item) => item.section).filter(Boolean)).size,
  });
  return (
    <AnchoredOverlay
      theme={props.theme}
      open={props.anchor !== null}
      onClose={props.onClose}
      anchor={props.anchor}
      width={props.width ?? (props.filter ? 320 : 220)}
      wanted={wanted}
      {...(props.align ? { align: props.align } : {})}
    >
      {(placement) => <AnchoredMenuBody {...props} placement={placement} />}
    </AnchoredOverlay>
  );
}

function AnchoredMenuBody(props: Parameters<typeof AnchoredMenu>[0] & { placement: Placement }) {
  const overlay = useOverlay();
  const [query, setQuery] = useState("");
  const shown = props.filter ? filterItems(props.items, query) : props.items;
  const choose = (key: string) => {
    if (!props.multiple) props.onClose();
    props.onSelect(key);
  };
  const [highlight, setHighlight] = useHighlight(true, shown.length, Math.max(0, props.items.findIndex((item) => item.checked && !props.multiple)), (index) => {
    const item = shown[index];
    if (item) choose(item.key);
  });
  return (
    <FloatingMenu
      theme={props.theme}
      label={props.label}
      placement={props.placement}
      items={shown}
      highlight={highlight}
      onHighlight={setHighlight}
      onSelect={choose}
      multiple={Boolean(props.multiple)}
      {...(props.note ? { note: props.note } : {})}
      {...(props.filter
        ? {
            filter: {
              query,
              onQuery: (next: string) => {
                setQuery(next);
                setHighlight(0);
              },
              placeholder: props.filter.placeholder,
              autoFocus: !overlay.phone,
              onSubmit: () => {
                const item = shown[highlight];
                if (item) choose(item.key);
              },
            },
          }
        : {})}
      {...(props.empty ? { empty: props.empty } : props.filter ? { empty: `No matching ${props.filter.noun}` } : {})}
      {...(props.footer ? { footer: props.footer } : {})}
    />
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    height: 28,
    maxWidth: 200,
    paddingHorizontal: 9,
    borderRadius: 14,
    borderWidth: 1,
  },
});
