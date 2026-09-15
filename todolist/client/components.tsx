import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, Modal, TextInput } from "@getpaseo/plugin/client/react-native";
import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import type { TodoStyles } from "./styles";

export function Button(props: {
  styles: TodoStyles;
  label: string;
  onPress: () => void;
  variant?: "primary" | "secondary" | "danger";
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
        : props.theme.colors.foreground;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      accessibilityHint={props.accessibilityHint}
      accessibilityState={{ disabled: Boolean(props.disabled) }}
      disabled={props.disabled}
      onPress={props.onPress}
      style={[
        styles.button,
        variant === "primary" ? styles.buttonPrimary : null,
        variant === "danger" ? styles.buttonDanger : null,
        props.disabled ? styles.buttonDisabled : null,
      ]}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        {props.icon ? <Icon name={props.icon} size={14} color={iconColor} /> : null}
        <Text style={textStyle}>{props.label}</Text>
      </View>
    </Pressable>
  );
}

export function Badge(props: {
  styles: TodoStyles;
  theme: PluginTheme;
  label: string;
  icon: string;
  tone?: "default" | "warning" | "danger" | "success";
}) {
  const color =
    props.tone === "warning"
      ? props.theme.colors.statusWarning
      : props.tone === "danger"
        ? props.theme.colors.statusDanger
        : props.tone === "success"
          ? props.theme.colors.statusSuccess
          : props.theme.colors.foregroundMuted;
  return (
    <View style={props.styles.badge} accessibilityRole="text" accessibilityLabel={`Status: ${props.label}`}>
      <Icon name={props.icon} size={12} color={color} />
      <Text style={[props.styles.badgeText, { color }]}>{props.label}</Text>
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
  role?: "tab" | "radio";
  accessibilityLabel?: string;
}) {
  const { styles, selected } = props;
  const role = props.role ?? "tab";
  return (
    <Pressable
      accessibilityRole={role}
      accessibilityState={{ selected, checked: selected }}
      // React Native Web only forwards selection to the accessibility tree through ARIA props.
      {...(role === "tab" ? { "aria-selected": selected } : { "aria-checked": selected })}
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      onPress={props.onPress}
      style={[styles.chip, selected ? styles.chipSelected : null]}
    >
      {props.icon ? (
        <Icon
          name={props.icon}
          size={13}
          color={selected ? props.theme.colors.accentForeground : (props.iconColor ?? props.theme.colors.foregroundMuted)}
        />
      ) : null}
      <Text style={selected ? styles.chipSelectedText : styles.chipText}>{props.label}</Text>
    </Pressable>
  );
}

export function Notice(props: { styles: TodoStyles; kind?: "info" | "warning" | "danger"; children: ReactNode; title?: string }) {
  const { styles } = props;
  return (
    <View
      accessibilityRole="alert"
      style={[
        styles.notice,
        props.kind === "warning" ? styles.noticeWarning : null,
        props.kind === "danger" ? styles.noticeDanger : null,
      ]}
    >
      {props.title ? <Text style={styles.title}>{props.title}</Text> : null}
      {typeof props.children === "string" ? <Text style={styles.body}>{props.children}</Text> : props.children}
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
}) {
  const { styles } = props;
  return (
    <View style={{ gap: 4 }}>
      <Text style={styles.muted}>{props.label}</Text>
      <TextInput
        accessibilityLabel={props.label}
        value={props.value}
        onChangeText={props.onChangeText}
        multiline={props.multiline}
        editable={props.editable ?? true}
        placeholder={props.placeholder}
        placeholderTextColor={props.theme.colors.foregroundMuted}
        style={[styles.input, props.multiline ? styles.inputMultiline : null]}
      />
      {props.hint ? <Text style={styles.mono}>{props.hint}</Text> : null}
    </View>
  );
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
        <Button styles={styles} theme={props.theme} label="Cancel" onPress={() => props.onOpenChange(false)} />
      </Modal.Content>
    </Modal>
  );
}

export function Select<Value extends string>(props: {
  styles: TodoStyles;
  theme: PluginTheme;
  label: string;
  value: Value | null;
  options: readonly { value: Value; label: string; hint?: string }[];
  onChange: (value: Value) => void;
}) {
  const { styles } = props;
  return (
    <View style={{ gap: 4 }} accessibilityRole="radiogroup" accessibilityLabel={props.label}>
      <Text style={styles.muted}>{props.label}</Text>
      {props.options.map((option) => {
        const selected = option.value === props.value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="radio"
            accessibilityState={{ selected, checked: selected }}
            accessibilityLabel={`${option.label}${selected ? ", selected" : ""}`}
            onPress={() => props.onChange(option.value)}
            style={[styles.button, selected ? styles.buttonPrimary : null]}
          >
            <Text style={selected ? styles.buttonPrimaryText : styles.buttonText}>{option.label}</Text>
            {option.hint ? (
              <Text style={[styles.mono, selected ? { color: props.theme.colors.accentForeground } : null]}>{option.hint}</Text>
            ) : null}
          </Pressable>
        );
      })}
      {props.options.length === 0 ? <Text style={styles.muted}>No options available.</Text> : null}
    </View>
  );
}
