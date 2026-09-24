import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useState, type ReactNode } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { Overlay, OverlayBox } from "./overlay";
import { usesCommandKeyWeb } from "./web";

const COMMAND_KEY = Platform.OS === "ios" || usesCommandKeyWeb();
/** Shortcut labels for tooltips, in the platform's own spelling. */
export const KEYS = COMMAND_KEY ? { submit: "⌘↵", run: "⌘⇧↵", newItem: "⌘⇧N" } : { submit: "Ctrl+↵", run: "Ctrl+Shift+↵", newItem: "Ctrl+Shift+N" };

/** A small dark label above its control. The wide, clear frame keeps the label on one line. */
export function Tip(props: { theme: PluginTheme; label: string; keys?: string | undefined; note?: string | undefined; align: "start" | "end" }) {
  const { theme } = props;
  return (
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        bottom: "100%",
        marginBottom: 8,
        width: 320,
        zIndex: 5,
        ...(props.align === "end" ? { right: -4, alignItems: "flex-end" } : { left: 0, alignItems: "flex-start" }),
      }}
    >
      <View style={{ gap: 3, backgroundColor: theme.colors.foreground, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4, alignItems: props.align === "end" ? "flex-end" : "flex-start" }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Text style={{ color: theme.colors.surface0, fontSize: 12 }} numberOfLines={1}>
            {props.label}
          </Text>
          {props.keys ? (
            <View style={{ height: 18, justifyContent: "center", paddingHorizontal: 4, borderRadius: 4, borderWidth: 1, borderColor: theme.colors.foregroundMuted }}>
              <Text style={{ color: theme.colors.surface0, fontSize: 10.5, fontWeight: "500", opacity: 0.85 }}>{props.keys}</Text>
            </View>
          ) : null}
        </View>
        {props.note ? (
          <Text style={{ color: theme.colors.surface0, fontSize: 11, opacity: 0.7 }} numberOfLines={1}>
            {props.note}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

/**
 * An icon-only control; hovering names it and its shortcut, since there is no label to read.
 * "round" is the box's one main action: a green circle, like the composer's send button.
 */
export function IconAction(props: {
  theme: PluginTheme;
  icon: string;
  label: string;
  tip?: string;
  keys?: string;
  /** A quieter second line in the tooltip. */
  tipNote?: string;
  kind: "plain" | "outline" | "round";
  align?: "start" | "end";
  disabled?: boolean;
  onPress: () => void;
}) {
  const { theme } = props;
  const [hovered, setHovered] = useState(false);
  const round = props.kind === "round";
  const disabled = Boolean(props.disabled);
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={props.label}
        accessibilityHint={props.keys ? `${props.tip ?? props.label} ${props.keys}` : undefined}
        accessibilityState={{ disabled }}
        disabled={disabled}
        hitSlop={4}
        onPress={props.onPress}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        style={({ pressed }: { pressed: boolean }) => [
          { width: round ? 32 : 30, height: round ? 32 : 30, borderRadius: round ? 16 : 8, alignItems: "center", justifyContent: "center" },
          props.kind === "outline" ? { borderWidth: 1, borderColor: theme.colors.border } : null,
          round ? { backgroundColor: theme.colors.accent } : (hovered || pressed) && !disabled ? { backgroundColor: theme.colors.surface2 } : null,
          round && (hovered || pressed) && !disabled ? { opacity: 0.88 } : null,
          disabled ? { opacity: 0.45 } : null,
        ]}
      >
        <Icon
          name={props.icon}
          size={round ? 16 : props.kind === "outline" ? 14 : 17}
          color={round ? theme.colors.accentForeground : hovered && !disabled ? theme.colors.foreground : theme.colors.foregroundMuted}
        />
      </Pressable>
      {hovered && props.tip ? <Tip theme={theme} label={props.tip} keys={props.keys} note={props.tipNote} align={props.align ?? "end"} /> : null}
    </View>
  );
}

/**
 * A labelled button for boxes: rounded, and small next to text. "accent" is the main action where
 * two run-like actions sit side by side and icons alone would not tell them apart.
 */
export function TextAction(props: {
  theme: PluginTheme;
  label: string;
  icon?: string;
  kind?: "default" | "accent" | "ghost" | "danger" | "dangerSolid";
  small?: boolean;
  disabled?: boolean;
  accessibilityHint?: string;
  onPress: () => void;
}) {
  const { theme } = props;
  const kind = props.kind ?? "default";
  const disabled = Boolean(props.disabled);
  const color =
    kind === "accent" || kind === "dangerSolid"
      ? theme.colors.accentForeground
      : kind === "danger"
        ? theme.colors.statusDanger
        : kind === "ghost"
          ? theme.colors.foregroundMuted
          : theme.colors.foreground;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityHint={props.accessibilityHint}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={props.onPress}
      style={({ hovered, pressed }: { hovered?: boolean; pressed: boolean }) => [
        {
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          height: props.small ? 26 : 30,
          paddingHorizontal: props.small ? 9 : 12,
          borderRadius: props.small ? 13 : 15,
          borderWidth: 1,
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.surface0,
          flexShrink: 0,
        },
        kind === "accent" ? { backgroundColor: theme.colors.accent, borderColor: theme.colors.accent } : null,
        kind === "ghost" ? { backgroundColor: "transparent", borderColor: "transparent" } : null,
        kind === "danger" ? { backgroundColor: "transparent", borderColor: theme.colors.statusDanger } : null,
        kind === "dangerSolid" ? { backgroundColor: theme.colors.statusDanger, borderColor: theme.colors.statusDanger } : null,
        (hovered || pressed) && !disabled
          ? kind === "default"
            ? { borderColor: theme.colors.foregroundMuted }
            : kind === "ghost"
              ? { backgroundColor: theme.colors.surface2 }
              : { opacity: 0.88 }
          : null,
        disabled ? { opacity: 0.45 } : null,
      ]}
    >
      {props.icon ? <Icon name={props.icon} size={props.small ? 12 : 13} color={color} /> : null}
      <Text style={{ color, fontSize: props.small ? 12 : 13, fontWeight: kind === "accent" ? "600" : "500" }} numberOfLines={1}>
        {props.label}
      </Text>
    </Pressable>
  );
}

/** A small tick box with its label, for an option inside a box. */
export function CheckOption(props: { theme: PluginTheme; label: string; value: boolean; onChange: (value: boolean) => void; disabled?: boolean }) {
  const { theme } = props;
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: props.value, disabled: Boolean(props.disabled) }}
      aria-checked={props.value}
      accessibilityLabel={props.label}
      disabled={props.disabled}
      onPress={() => props.onChange(!props.value)}
      style={{ flexDirection: "row", alignItems: "center", gap: 8, alignSelf: "flex-start", marginTop: 8, marginLeft: 2 }}
    >
      <View
        style={{
          width: 16,
          height: 16,
          borderRadius: 4,
          borderWidth: 1.5,
          alignItems: "center",
          justifyContent: "center",
          borderColor: props.value ? theme.colors.accent : theme.colors.foregroundMuted,
          backgroundColor: props.value ? theme.colors.accent : "transparent",
        }}
      >
        {props.value ? <Icon name="Check" size={11} color={theme.colors.accentForeground} /> : null}
      </View>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12.5 }}>{props.label}</Text>
    </Pressable>
  );
}

/** One line of warning or error inside a box, instead of a block of notice. */
export function InlineNote(props: { theme: PluginTheme; kind?: "info" | "warning" | "danger"; children: ReactNode; trailing?: ReactNode }) {
  const { theme } = props;
  const kind = props.kind ?? "warning";
  const color = kind === "danger" ? theme.colors.statusDanger : kind === "warning" ? theme.colors.statusWarning : theme.colors.foregroundMuted;
  return (
    <View accessibilityRole={kind === "info" ? undefined : "alert"} style={{ flexDirection: "row", alignItems: "flex-start", gap: 6, marginTop: 8, marginHorizontal: 2 }}>
      <View style={{ paddingTop: 2 }}>
        <Icon name={kind === "danger" ? "CircleAlert" : kind === "warning" ? "TriangleAlert" : "Info"} size={13} color={color} />
      </View>
      <View style={{ flex: 1, gap: 6 }}>
        {typeof props.children === "string" ? <Text style={{ color, fontSize: 12.5, lineHeight: 18 }}>{props.children}</Text> : props.children}
        {props.trailing}
      </View>
    </View>
  );
}

/** Pieces of a box's top line, with dots between them. */
export function MetaText(props: { theme: PluginTheme; parts: readonly (ReactNode | null | false | undefined)[] }) {
  const parts = props.parts.filter((part) => part !== null && part !== false && part !== undefined);
  return (
    <>
      {parts.map((part, index) => (
        <View key={index} style={{ flexDirection: "row", alignItems: "center", gap: 6, flexShrink: index === parts.length - 1 ? 1 : 0, minWidth: 0 }}>
          {index > 0 ? <Text style={{ color: props.theme.colors.foregroundMuted, fontSize: 12 }}>·</Text> : null}
          {typeof part === "string" ? (
            <Text style={{ color: props.theme.colors.foregroundMuted, fontSize: 12, flexShrink: 1 }} numberOfLines={1}>
              {part}
            </Text>
          ) : (
            part
          )}
        </View>
      ))}
    </>
  );
}

/**
 * A question before something that cannot be undone: one bold sentence, the consequences, and one
 * red button. Closing the box (×, Escape, the scrim) is the way out; there is no Cancel. Actions
 * that need a second look turn the button solid red with "Click again to …" first.
 */
export function ConfirmBox(props: {
  theme: PluginTheme;
  request: { title: string; message: string; label: string; requireDouble: boolean; icon?: string } | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Overlay theme={props.theme} open={props.request !== null} onClose={props.onClose} variant="box">
      {props.request ? <ConfirmBody theme={props.theme} request={props.request} onConfirm={props.onConfirm} /> : null}
    </Overlay>
  );
}

function ConfirmBody(props: { theme: PluginTheme; request: { title: string; message: string; label: string; requireDouble: boolean; icon?: string }; onConfirm: () => void }) {
  const { theme, request } = props;
  const [armed, setArmed] = useState(false);
  const ready = !request.requireDouble || armed;
  return (
    <OverlayBox
      size="narrow"
      accessibilityLabel={request.title}
      footer={
        <View style={{ flexDirection: "row", justifyContent: "flex-end", marginTop: 14 }}>
          <TextAction
            theme={theme}
            label={ready && request.requireDouble ? `Click again to ${request.label.charAt(0).toLowerCase()}${request.label.slice(1)}` : request.label}
            kind={request.requireDouble && armed ? "dangerSolid" : "danger"}
            onPress={() => (ready ? props.onConfirm() : setArmed(true))}
          />
        </View>
      }
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 6, paddingRight: 14 }}>
        <Icon name={request.icon ?? "TriangleAlert"} size={15} color={theme.colors.statusDanger} />
        <Text style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: "600", flexShrink: 1 }}>{request.title}</Text>
      </View>
      <Text style={{ color: theme.colors.foreground, fontSize: 13.5, lineHeight: 20 }} selectable>
        {request.message}
      </Text>
    </OverlayBox>
  );
}
