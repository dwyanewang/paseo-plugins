import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, Modal, TextInput } from "@getpaseo/plugin/client/react-native";
import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import type { TodoStyles } from "./styles";

export function Button(props: {
  styles: TodoStyles;
  label: string;
  onPress: () => void;
  variant?: "primary" | "secondary" | "danger" | "ghost";
  disabled?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  icon?: string;
  theme: PluginTheme;
}) {
  const { styles, variant = "secondary" } = props;
  const textStyle =
    variant === "primary" ? styles.buttonPrimaryText : variant === "danger" ? styles.buttonDangerText : styles.buttonText;
  const iconColor =
    variant === "primary"
      ? props.theme.colors.accentForeground
      : variant === "danger"
        ? props.theme.colors.statusDanger
        : variant === "ghost"
          ? props.theme.colors.foregroundMuted
          : props.theme.colors.foreground;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      accessibilityHint={props.accessibilityHint}
      accessibilityState={{ disabled: Boolean(props.disabled) }}
      disabled={props.disabled}
      onPress={props.onPress}
      style={({ hovered, pressed }: { hovered?: boolean; pressed: boolean }) => [
        styles.button,
        variant === "primary" ? styles.buttonPrimary : null,
        variant === "danger" ? styles.buttonDanger : null,
        variant === "ghost" ? styles.buttonGhost : null,
        (hovered || pressed) && !props.disabled ? { opacity: variant === "primary" ? 0.88 : 1, borderColor: variant === "secondary" ? props.theme.colors.foregroundMuted : undefined } : null,
        props.disabled ? styles.buttonDisabled : null,
      ]}
    >
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6 }}>
        {props.icon ? <Icon name={props.icon} size={14} color={iconColor} /> : null}
        <Text style={textStyle} numberOfLines={1}>
          {props.label}
        </Text>
      </View>
    </Pressable>
  );
}

/** A square, label-less button. The label still reaches assistive technology. */
export function IconButton(props: {
  styles: TodoStyles;
  theme: PluginTheme;
  icon: string;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  accessibilityHint?: string;
  /** Resting opacity, for controls that only matter on hover or focus. */
  dim?: boolean;
  bordered?: boolean;
  /** Filled with the accent color, for the main action where a labelled button does not fit. */
  primary?: boolean;
  /** Highlighted while the control it toggles is open. */
  active?: boolean;
}) {
  const { styles, theme } = props;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityHint={props.accessibilityHint}
      accessibilityState={{ disabled: Boolean(props.disabled) }}
      disabled={props.disabled}
      hitSlop={6}
      onPress={props.onPress}
      style={({ hovered, pressed }: { hovered?: boolean; pressed: boolean }) => [
        styles.iconButton,
        props.bordered || props.primary ? { width: 32, height: 32, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1, borderRadius: 8 } : null,
        hovered || pressed || props.active ? { backgroundColor: theme.colors.surface2 } : null,
        props.active ? { borderColor: theme.colors.foregroundMuted } : null,
        props.primary ? { backgroundColor: theme.colors.accent, borderColor: theme.colors.accent, opacity: hovered || pressed ? 0.88 : 1 } : null,
        props.dim && !hovered && !pressed ? { opacity: 0.55 } : null,
        props.disabled ? styles.buttonDisabled : null,
      ]}
    >
      <Icon name={props.icon} size={props.primary ? 16 : 15} color={props.primary ? theme.colors.accentForeground : props.active ? theme.colors.foreground : theme.colors.foregroundMuted} />
    </Pressable>
  );
}

export function toneColor(theme: PluginTheme, tone: "default" | "warning" | "danger" | "success" | undefined): string {
  return tone === "warning"
    ? theme.colors.statusWarning
    : tone === "danger"
      ? theme.colors.statusDanger
      : tone === "success"
        ? theme.colors.statusSuccess
        : theme.colors.foregroundMuted;
}

export function Badge(props: {
  styles: TodoStyles;
  theme: PluginTheme;
  label: string;
  icon: string;
  tone?: "default" | "warning" | "danger" | "success";
}) {
  const color = toneColor(props.theme, props.tone);
  return (
    <View style={props.styles.badge} accessibilityRole="text" accessibilityLabel={`Status: ${props.label}`}>
      <Icon name={props.icon} size={11} color={color} />
      <Text style={[props.styles.badgeText, props.tone && props.tone !== "default" ? { color } : null]} numberOfLines={1}>
        {props.label}
      </Text>
    </View>
  );
}

export function Chip(props: {
  styles: TodoStyles;
  theme: PluginTheme;
  label: string;
  selected: boolean;
  onPress: () => void;
  icon?: string;
  iconColor?: string;
  role?: "tab" | "radio" | "button";
  accessibilityLabel?: string;
  /** Trailing text in a quieter color, such as a count. */
  trailing?: string;
}) {
  const { styles, selected, theme } = props;
  const role = props.role ?? "tab";
  return (
    <Pressable
      accessibilityRole={role}
      accessibilityState={{ selected, checked: selected }}
      // React Native Web only forwards selection to the accessibility tree through ARIA props.
      {...(role === "tab" ? { "aria-selected": selected } : role === "radio" ? { "aria-checked": selected } : {})}
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      onPress={props.onPress}
      style={({ hovered }: { hovered?: boolean; pressed: boolean }) => [
        styles.chip,
        hovered && !selected ? { borderColor: theme.colors.foregroundMuted } : null,
        selected ? styles.chipSelected : null,
      ]}
    >
      {props.icon ? <Icon name={props.icon} size={13} color={props.iconColor ?? theme.colors.foregroundMuted} /> : null}
      <Text style={selected ? styles.chipSelectedText : styles.chipText} numberOfLines={1}>
        {props.label}
      </Text>
      {props.trailing ? <Text style={styles.metaText}>{props.trailing}</Text> : null}
    </Pressable>
  );
}

/** A compact tab strip: one selected value out of a handful. */
export function Segmented<Value extends string>(props: {
  styles: TodoStyles;
  label: string;
  value: Value;
  options: readonly { value: Value; label: string }[];
  onChange: (value: Value) => void;
}) {
  const { styles } = props;
  return (
    <View accessibilityRole="tablist" accessibilityLabel={props.label} style={styles.segmented}>
      {props.options.map((option) => {
        const selected = option.value === props.value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            aria-selected={selected}
            accessibilityLabel={option.label}
            onPress={() => props.onChange(option.value)}
            style={[styles.segment, selected ? styles.segmentSelected : null]}
          >
            <Text style={selected ? styles.segmentSelectedText : styles.segmentText} numberOfLines={1}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Notice(props: { styles: TodoStyles; theme: PluginTheme; kind?: "info" | "warning" | "danger"; children: ReactNode; title?: string }) {
  const { styles, theme } = props;
  const icon = props.kind === "danger" ? "CircleAlert" : props.kind === "warning" ? "TriangleAlert" : "Info";
  const color = toneColor(theme, props.kind === "info" || !props.kind ? "default" : props.kind);
  return (
    <View
      accessibilityRole="alert"
      style={[
        styles.notice,
        { flexDirection: "row", alignItems: "flex-start", gap: 10 },
        props.kind === "warning" ? styles.noticeWarning : null,
        props.kind === "danger" ? styles.noticeDanger : null,
      ]}
    >
      <View style={{ paddingTop: 2 }}>
        <Icon name={icon} size={15} color={color} />
      </View>
      <View style={{ flex: 1, gap: 4 }}>
        {props.title ? <Text style={[styles.body, { fontWeight: "600" }]}>{props.title}</Text> : null}
        {typeof props.children === "string" ? <Text style={styles.body}>{props.children}</Text> : props.children}
      </View>
    </View>
  );
}

export function Field(props: {
  styles: TodoStyles;
  theme: PluginTheme;
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  multiline?: boolean;
  placeholder?: string;
  editable?: boolean;
  hint?: string;
  autoFocus?: boolean;
  monospace?: boolean;
}) {
  const { styles } = props;
  return (
    <View style={{ gap: 6 }}>
      <Text style={styles.fieldLabel}>{props.label}</Text>
      <TextInput
        accessibilityLabel={props.label}
        value={props.value}
        onChangeText={props.onChangeText}
        multiline={props.multiline}
        editable={props.editable ?? true}
        autoFocus={props.autoFocus}
        placeholder={props.placeholder}
        placeholderTextColor={props.theme.colors.foregroundMuted}
        style={[styles.input, props.multiline ? styles.inputMultiline : null, props.monospace ? { fontFamily: "monospace", fontSize: 12 } : null]}
      />
      {props.hint ? <Text style={styles.mono}>{props.hint}</Text> : null}
    </View>
  );
}

/** A labelled group inside a dialog. */
export function FormLabel(props: { styles: TodoStyles; label: string; children: ReactNode }) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={props.styles.fieldLabel}>{props.label}</Text>
      {props.children}
    </View>
  );
}

/** Dialog footer: secondary actions first, the primary one last, all aligned to the end. */
export function DialogActions(props: { styles: TodoStyles; children: ReactNode }) {
  return <View style={[props.styles.rowWrap, { justifyContent: "flex-end", paddingTop: 4 }]}>{props.children}</View>;
}

export function ConfirmModal(props: {
  styles: TodoStyles;
  theme: PluginTheme;
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  requireDouble?: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  armed: boolean;
  onArm: () => void;
}) {
  const { styles } = props;
  return (
    <Modal title={props.title} open={props.open} onOpenChange={props.onOpenChange}>
      <Modal.Content>
        <Text style={styles.body}>{props.message}</Text>
        {props.requireDouble && props.armed ? <Text style={styles.warning}>Confirm once more to continue.</Text> : null}
        <DialogActions styles={styles}>
          <Button styles={styles} theme={props.theme} label="Cancel" onPress={() => props.onOpenChange(false)} />
          {props.requireDouble && !props.armed ? (
            <Button styles={styles} theme={props.theme} label="I understand, continue" onPress={props.onArm} variant="danger" />
          ) : (
            <Button
              styles={styles}
              theme={props.theme}
              label={props.confirmLabel}
              onPress={props.onConfirm}
              variant={props.danger ? "danger" : "primary"}
            />
          )}
        </DialogActions>
      </Modal.Content>
    </Modal>
  );
}

/** A radio list: each option on its own row, with an optional second line. */
export function Select<Value extends string>(props: {
  styles: TodoStyles;
  theme: PluginTheme;
  label: string;
  value: Value | null;
  options: readonly { value: Value; label: string; hint?: string; icon?: string }[];
  onChange: (value: Value) => void;
}) {
  const { styles, theme } = props;
  return (
    <View style={{ gap: 6 }} accessibilityRole="radiogroup" accessibilityLabel={props.label}>
      <Text style={styles.fieldLabel}>{props.label}</Text>
      {props.options.map((option) => {
        const selected = option.value === props.value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="radio"
            accessibilityState={{ selected, checked: selected }}
            aria-checked={selected}
            accessibilityLabel={`${option.label}${selected ? ", selected" : ""}`}
            onPress={() => props.onChange(option.value)}
            style={({ hovered }: { hovered?: boolean; pressed: boolean }) => [
              styles.listRow,
              hovered && !selected ? { borderColor: theme.colors.foregroundMuted } : null,
              selected ? styles.listRowSelected : null,
            ]}
          >
            <Icon name={option.icon ?? (selected ? "CircleDot" : "Circle")} size={15} color={selected ? theme.colors.accent : theme.colors.foregroundMuted} />
            <View style={{ flex: 1, gap: 2, minWidth: 0 }}>
              <Text style={[styles.body, { fontWeight: selected ? "600" : "500" }]} numberOfLines={1}>
                {option.label}
              </Text>
              {option.hint ? (
                <Text style={styles.mono} numberOfLines={1}>
                  {option.hint}
                </Text>
              ) : null}
            </View>
            {selected ? <Icon name="Check" size={15} color={theme.colors.accent} /> : null}
          </Pressable>
        );
      })}
      {props.options.length === 0 ? <Text style={styles.muted}>No options available.</Text> : null}
    </View>
  );
}
