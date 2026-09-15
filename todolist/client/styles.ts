import type { PluginTheme } from "@getpaseo/plugin";
import { useMemo } from "react";
import type { TextStyle, ViewStyle } from "react-native";

export interface TodoStyles {
  screen: ViewStyle;
  scrollContent: ViewStyle;
  header: ViewStyle;
  headerTitle: TextStyle;
  section: ViewStyle;
  sectionTitle: TextStyle;
  card: ViewStyle;
  row: ViewStyle;
  rowWrap: ViewStyle;
  title: TextStyle;
  body: TextStyle;
  muted: TextStyle;
  mono: TextStyle;
  warning: TextStyle;
  danger: TextStyle;
  success: TextStyle;
  button: ViewStyle;
  buttonPrimary: ViewStyle;
  buttonDanger: ViewStyle;
  buttonDisabled: ViewStyle;
  buttonText: TextStyle;
  buttonPrimaryText: TextStyle;
  buttonDangerText: TextStyle;
  input: TextStyle;
  inputMultiline: TextStyle;
  badge: ViewStyle;
  badgeText: TextStyle;
  divider: ViewStyle;
  notice: ViewStyle;
  noticeWarning: ViewStyle;
  noticeDanger: ViewStyle;
  dragHandle: ViewStyle;
  dragging: ViewStyle;
  detail: ViewStyle;
  gap: number;
}

export function useTodoStyles(theme: PluginTheme, compact: boolean): TodoStyles {
  return useMemo(() => {
    const gap = compact ? 8 : 12;
    const colors = theme.colors;
    return {
      gap,
      screen: { flex: 1, backgroundColor: colors.surface0, padding: compact ? 12 : 20, gap },
      // A ScrollView content container must never carry `flex: 1`: it pins the content to the
      // viewport height, so nothing ever overflows and the view stops scrolling on Android.
      scrollContent: { flexGrow: 1, padding: compact ? 12 : 20, gap, paddingBottom: (compact ? 12 : 20) * 3 },
      header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap },
      headerTitle: { color: colors.foreground, fontSize: compact ? 20 : 24, fontWeight: "600" },
      section: { gap },
      sectionTitle: { color: colors.foregroundMuted, fontSize: 13, fontWeight: "600", textTransform: "uppercase" },
      card: {
        backgroundColor: colors.surface1,
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: 10,
        padding: compact ? 10 : 14,
        gap,
      },
      row: { flexDirection: "row", alignItems: "center", gap },
      rowWrap: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap },
      title: { color: colors.foreground, fontSize: compact ? 15 : 16, fontWeight: "600", flexShrink: 1 },
      body: { color: colors.foreground, fontSize: 14 },
      muted: { color: colors.foregroundMuted, fontSize: 13 },
      mono: { color: colors.foregroundMuted, fontSize: 12 },
      warning: { color: colors.statusWarning, fontSize: 13 },
      danger: { color: colors.statusDanger, fontSize: 13 },
      success: { color: colors.statusSuccess, fontSize: 13 },
      button: {
        paddingVertical: compact ? 8 : 8,
        paddingHorizontal: compact ? 10 : 12,
        borderRadius: 8,
        backgroundColor: colors.surface2,
        borderColor: colors.border,
        borderWidth: 1,
        minHeight: 36,
        justifyContent: "center",
      },
      buttonPrimary: { backgroundColor: colors.accent, borderColor: colors.accent },
      buttonDanger: { backgroundColor: colors.surface2, borderColor: colors.statusDanger },
      buttonDisabled: { opacity: 0.5 },
      buttonText: { color: colors.foreground, fontSize: 14, fontWeight: "500" },
      buttonPrimaryText: { color: colors.accentForeground, fontSize: 14, fontWeight: "600" },
      buttonDangerText: { color: colors.statusDanger, fontSize: 14, fontWeight: "500" },
      input: {
        color: colors.foreground,
        backgroundColor: colors.surface0,
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 8,
        fontSize: 14,
        minHeight: 40,
      },
      inputMultiline: { minHeight: compact ? 88 : 120, textAlignVertical: "top" },
      badge: {
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: 999,
        backgroundColor: colors.surface2,
      },
      badgeText: { color: colors.foreground, fontSize: 12, fontWeight: "500" },
      divider: { height: 1, backgroundColor: colors.border },
      notice: { backgroundColor: colors.surface2, borderRadius: 8, padding: 10, gap: 4 },
      noticeWarning: { borderColor: colors.statusWarning, borderWidth: 1 },
      noticeDanger: { borderColor: colors.statusDanger, borderWidth: 1 },
      dragHandle: { padding: 6, borderRadius: 6 },
      dragging: { opacity: 0.6, backgroundColor: colors.surface2 },
      detail: { gap: 6, paddingTop: 6 },
    };
  }, [theme, compact]);
}
