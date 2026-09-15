import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { Children, Fragment, isValidElement, useRef, useState, type ReactNode } from "react";
import {
  Dimensions,
  Modal as NativeModal,
  Platform,
  Pressable,
  ScrollView as NativeScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from "react-native";
import type { TodoStyles } from "./styles";

export interface SelectOption<Value extends string> {
  value: Value;
  label: string;
  /** Second line in the menu, such as a project path. */
  hint?: string;
  icon?: string;
  iconColor?: string;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * On the web the host traps focus in its top dialog and handles Escape before anything else, and a
 * React Native Web modal sits outside that dialog. The choices open inline under the row there, so
 * focus and Escape stay with the dialog; native apps float them like the host's own dropdowns.
 */
const INLINE_MENU = Platform.OS === "web";

/** Room kept between the menu and the screen edges, and between the menu and its row. */
const EDGE = 8;
const GAP = 4;

/** Settings rows in one bordered card, with a divider between rows. `null` children are skipped. */
export function RowGroup(props: { styles: TodoStyles; children: ReactNode }) {
  const rows = Children.toArray(props.children).filter(isValidElement);
  return (
    <View style={props.styles.group}>
      {rows.map((row, index) => (
        <Fragment key={row.key ?? index}>
          {index > 0 ? <View style={props.styles.divider} /> : null}
          {row}
        </Fragment>
      ))}
    </View>
  );
}

/** A label on the left and a read-only value on the right. */
export function InfoRow(props: { styles: TodoStyles; label: string; children: ReactNode }) {
  const { styles } = props;
  return (
    <View style={styles.selectRow}>
      <Text style={[styles.rowLabel, { flexShrink: 0, maxWidth: "45%" }]} numberOfLines={1}>
        {props.label}
      </Text>
      <View style={{ flex: 1, minWidth: 0, alignItems: "flex-end" }}>{props.children}</View>
    </View>
  );
}

/**
 * A settings row that opens a menu of choices under itself. The value stays on the row's line and
 * truncates instead of wrapping below the label. In native apps the menu floats in a transparent
 * modal, like the host's dropdowns, so it never stacks another sheet on the dialog it sits in.
 */
export function SelectRow<Value extends string>(props: {
  styles: TodoStyles;
  theme: PluginTheme;
  label: string;
  value: Value | null;
  options: readonly SelectOption<Value>[];
  onChange: (value: Value) => void;
  /** Shown when nothing is selected yet. */
  placeholder?: string;
  /** A quieter line under the value. */
  hint?: string;
  disabled?: boolean;
}) {
  const { styles, theme } = props;
  const anchor = useRef<View | null>(null);
  const [menuAt, setMenuAt] = useState<Rect | null>(null);
  const [inlineOpen, setInlineOpen] = useState(false);
  const expanded = INLINE_MENU ? inlineOpen : menuAt !== null;
  const selected = props.options.find((option) => option.value === props.value);
  const disabled = props.disabled || props.options.length === 0;

  function open() {
    if (INLINE_MENU) {
      setInlineOpen((current) => !current);
      return;
    }
    // Measured before the modal opens: on Android the modal draws under the status bar, while
    // window measurements start below it.
    const statusBar = Platform.OS === "android" ? (StatusBar.currentHeight ?? 0) : 0;
    anchor.current?.measureInWindow((x, y, width, height) => setMenuAt({ x, y: y + statusBar, width, height }));
  }

  return (
    <>
      <Pressable
        ref={anchor}
        accessibilityRole="button"
        accessibilityLabel={`${props.label}: ${selected?.label ?? props.placeholder ?? "not set"}. Change`}
        accessibilityState={{ disabled, expanded }}
        disabled={disabled}
        onPress={open}
        style={({ hovered, pressed }: { hovered?: boolean; pressed: boolean }) => [
          styles.selectRow,
          (hovered || pressed) && !disabled ? { backgroundColor: theme.colors.surface2 } : null,
          disabled ? { opacity: 0.55 } : null,
        ]}
      >
        <Text style={[styles.rowLabel, { flexShrink: 0, maxWidth: "45%" }]} numberOfLines={1}>
          {props.label}
        </Text>
        <View style={{ flex: 1, minWidth: 0, alignItems: "flex-end", gap: 2 }}>
          <View style={[styles.row, { gap: 6, maxWidth: "100%" }]}>
            {selected?.icon ? (
              <View style={{ flexShrink: 0 }}>
                <Icon name={selected.icon} size={14} color={selected.iconColor ?? theme.colors.foregroundMuted} />
              </View>
            ) : null}
            <Text style={[styles.rowValue, { flexShrink: 1 }, selected ? null : { color: theme.colors.foregroundMuted }]} numberOfLines={1}>
              {selected?.label ?? props.placeholder ?? "Choose"}
            </Text>
          </View>
          {props.hint ? (
            <Text style={[styles.mono, { textAlign: "right" }]} numberOfLines={1}>
              {props.hint}
            </Text>
          ) : null}
        </View>
        <View style={{ flexShrink: 0 }}>
          <Icon name={INLINE_MENU && expanded ? "ChevronUp" : "ChevronDown"} size={15} color={theme.colors.foregroundMuted} />
        </View>
      </Pressable>
      {INLINE_MENU && inlineOpen ? (
        <View accessibilityRole="menu" accessibilityLabel={props.label} style={{ paddingHorizontal: 8, paddingBottom: 8, gap: 2 }}>
          <OptionItems
            styles={styles}
            theme={theme}
            value={props.value}
            options={props.options}
            onSelect={(value) => {
              setInlineOpen(false);
              if (value !== props.value) props.onChange(value);
            }}
          />
        </View>
      ) : null}
      {!INLINE_MENU && menuAt ? (
        <SelectMenu
          styles={styles}
          theme={theme}
          label={props.label}
          anchor={menuAt}
          value={props.value}
          options={props.options}
          onClose={() => setMenuAt(null)}
          onSelect={(value) => {
            setMenuAt(null);
            if (value !== props.value) props.onChange(value);
          }}
        />
      ) : null}
    </>
  );
}

function SelectMenu<Value extends string>(props: {
  styles: TodoStyles;
  theme: PluginTheme;
  label: string;
  anchor: Rect;
  value: Value | null;
  options: readonly SelectOption<Value>[];
  onClose: () => void;
  onSelect: (value: Value) => void;
}) {
  const { styles, theme, anchor } = props;
  const [height, setHeight] = useState<number | null>(null);
  const screen = Dimensions.get("window");
  const width = Math.min(Math.max(220, Math.min(300, anchor.width * 0.7)), screen.width - EDGE * 2);
  const maxHeight = Math.min(360, screen.height * 0.6);
  // Right-aligned with its row, below it when it fits and above it otherwise.
  const left = Math.min(Math.max(EDGE, anchor.x + anchor.width - width - EDGE), screen.width - width - EDGE);
  const below = anchor.y + anchor.height + GAP;
  const top =
    height === null || below + height <= screen.height - EDGE
      ? below
      : Math.max(EDGE, Math.min(anchor.y - height - GAP, screen.height - height - EDGE));
  return (
    <NativeModal visible transparent animationType="none" statusBarTranslucent={Platform.OS === "android"} onRequestClose={props.onClose}>
      <Pressable accessibilityLabel="Close menu" style={StyleSheet.absoluteFill} onPress={props.onClose} />
      <View
        accessibilityRole="menu"
        accessibilityLabel={props.label}
        onLayout={(event) => setHeight(event.nativeEvent.layout.height)}
        // Invisible for the first layout pass, until its height decides between below and above.
        style={[styles.menu, { position: "absolute", left, top, width, maxHeight, opacity: height === null ? 0 : 1 }]}
      >
        <NativeScrollView style={{ flexGrow: 0 }} bounces={false}>
          <OptionItems styles={styles} theme={theme} value={props.value} options={props.options} onSelect={props.onSelect} />
        </NativeScrollView>
      </View>
    </NativeModal>
  );
}

function OptionItems<Value extends string>(props: {
  styles: TodoStyles;
  theme: PluginTheme;
  value: Value | null;
  options: readonly SelectOption<Value>[];
  onSelect: (value: Value) => void;
}) {
  const { styles, theme } = props;
  return (
    <>
      {props.options.map((option) => {
        const checked = option.value === props.value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="menuitem"
            accessibilityState={{ checked, selected: checked }}
            accessibilityLabel={option.label}
            onPress={() => props.onSelect(option.value)}
            style={({ hovered, pressed }: { hovered?: boolean; pressed: boolean }) => [
              styles.menuItem,
              hovered || pressed || checked ? { backgroundColor: theme.colors.surface2 } : null,
            ]}
          >
            {option.icon ? (
              <View style={{ flexShrink: 0 }}>
                <Icon name={option.icon} size={15} color={option.iconColor ?? theme.colors.foregroundMuted} />
              </View>
            ) : null}
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={[styles.body, { fontSize: 14, fontWeight: checked ? "600" : "400" }]} numberOfLines={1}>
                {option.label}
              </Text>
              {option.hint ? (
                <Text style={styles.mono} numberOfLines={1}>
                  {option.hint}
                </Text>
              ) : null}
            </View>
            {checked ? <Icon name="Check" size={15} color={theme.colors.foreground} /> : null}
          </Pressable>
        );
      })}
    </>
  );
}
