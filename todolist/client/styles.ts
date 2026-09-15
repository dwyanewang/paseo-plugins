import type { PluginTheme } from "@getpaseo/plugin";
import { useMemo } from "react";
import type { TextStyle, ViewStyle } from "react-native";

/** Spacing scale for margins, paddings and gaps. */
const SPACE = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;
const RADIUS = { sm: 6, md: 8, lg: 10 } as const;

export interface TodoStyles {
  gap: number;
  screen: ViewStyle;
  page: ViewStyle;
  header: ViewStyle;
  headerTitle: TextStyle;
  toolbar: ViewStyle;
  toolbarGroup: ViewStyle;
  segmented: ViewStyle;
  segment: ViewStyle;
  segmentSelected: ViewStyle;
  segmentText: TextStyle;
  segmentSelectedText: TextStyle;
  searchBox: ViewStyle;
  searchInput: TextStyle;
  sectionTitle: TextStyle;
  card: ViewStyle;
  row: ViewStyle;
  rowWrap: ViewStyle;
  title: TextStyle;
  body: TextStyle;
  muted: TextStyle;
  mono: TextStyle;
  code: TextStyle;
  warning: TextStyle;
  danger: TextStyle;
  button: ViewStyle;
  buttonPrimary: ViewStyle;
  buttonDanger: ViewStyle;
  buttonGhost: ViewStyle;
  buttonDisabled: ViewStyle;
  buttonText: TextStyle;
  buttonPrimaryText: TextStyle;
  buttonDangerText: TextStyle;
  iconButton: ViewStyle;
  input: TextStyle;
  inputMultiline: TextStyle;
  fieldLabel: TextStyle;
  badge: ViewStyle;
  badgeText: TextStyle;
  divider: ViewStyle;
  notice: ViewStyle;
  noticeWarning: ViewStyle;
  noticeDanger: ViewStyle;
  board: ViewStyle;
  boardRow: ViewStyle;
  column: ViewStyle;
  columnHeader: ViewStyle;
  columnTitle: TextStyle;
  columnBody: ViewStyle;
  countPill: ViewStyle;
  countText: TextStyle;
  columnEmpty: TextStyle;
  columnDropTarget: ViewStyle;
  boardCard: ViewStyle;
  boardCardHovered: ViewStyle;
  cardTitle: TextStyle;
  cardDetails: TextStyle;
  metaRow: ViewStyle;
  metaText: TextStyle;
  dot: ViewStyle;
  dragHandle: ViewStyle;
  ghost: ViewStyle;
  chip: ViewStyle;
  chipSelected: ViewStyle;
  chipText: TextStyle;
  chipSelectedText: TextStyle;
  listRow: ViewStyle;
  listRowSelected: ViewStyle;
  group: ViewStyle;
  selectRow: ViewStyle;
  rowLabel: TextStyle;
  rowValue: TextStyle;
  menu: ViewStyle;
  menuItem: ViewStyle;
  section: ViewStyle;
  sectionHeader: ViewStyle;
  detailTitle: TextStyle;
}

function channels(color: string): [number, number, number] | null {
  const hex = color.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)?.[1];
  if (hex) {
    const full = hex.length === 3 ? [...hex].map((digit) => digit + digit).join("") : hex;
    return [0, 2, 4].map((index) => parseInt(full.slice(index, index + 2), 16)) as [number, number, number];
  }
  const rgb = color.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
  return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : null;
}

function luminance(color: string): number | null {
  const parts = channels(color);
  return parts ? (0.2126 * parts[0] + 0.7152 * parts[1] + 0.0722 * parts[2]) / 255 : null;
}

/** Dark when the text is lighter than the page. Unparseable colors count as light. */
export function isDarkTheme(theme: PluginTheme): boolean {
  const page = luminance(theme.colors.surface0);
  const text = luminance(theme.colors.foreground);
  return page !== null && text !== null && text > page;
}

export function useTodoStyles(theme: PluginTheme, compact: boolean): TodoStyles {
  return useMemo(() => {
    const colors = theme.colors;
    const gap = compact ? SPACE.sm : SPACE.md;
    const pad = compact ? SPACE.md : SPACE.lg;
    const dark = isDarkTheme(theme);
    // Cards sit on a recessed column: white on light gray, or a lighter tone on dark gray.
    const cardColor = dark ? colors.surface2 : colors.surface0;
    const recessed = dark ? colors.surface1 : colors.surface2;
    const control = { minHeight: 32, borderRadius: RADIUS.md, justifyContent: "center" } as const;
    return {
      gap,
      screen: { flex: 1, backgroundColor: colors.surface0, padding: pad, gap },
      page: { flex: 1, backgroundColor: colors.surface0, paddingHorizontal: pad, paddingTop: pad, paddingBottom: compact ? SPACE.sm : pad, gap },
      header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap },
      headerTitle: { color: colors.foreground, fontSize: compact ? 17 : 18, fontWeight: "600" },
      toolbar: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACE.sm },
      toolbarGroup: { flexDirection: "row", alignItems: "center", gap: SPACE.sm },
      segmented: {
        flexDirection: "row",
        alignItems: "center",
        padding: 2,
        gap: 2,
        borderRadius: RADIUS.md,
        backgroundColor: recessed,
        borderWidth: 1,
        borderColor: colors.border,
      },
      segment: { paddingHorizontal: SPACE.sm + 2, paddingVertical: 4, borderRadius: RADIUS.sm },
      segmentSelected: { backgroundColor: cardColor, borderWidth: 1, borderColor: colors.border, paddingHorizontal: SPACE.sm + 1, paddingVertical: 3 },
      segmentText: { color: colors.foregroundMuted, fontSize: 12, fontWeight: "500" },
      segmentSelectedText: { color: colors.foreground, fontSize: 12, fontWeight: "600" },
      searchBox: {
        ...control,
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingHorizontal: SPACE.sm + 2,
        backgroundColor: colors.surface1,
        borderWidth: 1,
        borderColor: colors.border,
        flexGrow: 1,
        flexBasis: 160,
      },
      searchInput: { flex: 1, color: colors.foreground, fontSize: 13, paddingVertical: 6, minWidth: 0 },
      sectionTitle: { color: colors.foregroundMuted, fontSize: 11, fontWeight: "600", letterSpacing: 0.4, textTransform: "uppercase" },
      card: { backgroundColor: colors.surface1, borderColor: colors.border, borderWidth: 1, borderRadius: RADIUS.lg, padding: SPACE.md, gap: SPACE.sm },
      row: { flexDirection: "row", alignItems: "center", gap: SPACE.sm },
      rowWrap: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACE.sm },
      title: { color: colors.foreground, fontSize: 14, fontWeight: "600", flexShrink: 1 },
      body: { color: colors.foreground, fontSize: 13, lineHeight: 19 },
      muted: { color: colors.foregroundMuted, fontSize: 13 },
      mono: { color: colors.foregroundMuted, fontSize: 12 },
      code: {
        color: colors.foreground,
        fontSize: 12,
        lineHeight: 18,
        fontFamily: "monospace",
        backgroundColor: colors.surface1,
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: RADIUS.sm,
        padding: SPACE.sm + 2,
      },
      warning: { color: colors.statusWarning, fontSize: 12 },
      danger: { color: colors.statusDanger, fontSize: 12 },
      button: { ...control, paddingHorizontal: SPACE.md, backgroundColor: colors.surface1, borderColor: colors.border, borderWidth: 1 },
      buttonPrimary: { backgroundColor: colors.accent, borderColor: colors.accent },
      buttonDanger: { backgroundColor: "transparent", borderColor: colors.statusDanger },
      buttonGhost: { backgroundColor: "transparent", borderColor: "transparent" },
      buttonDisabled: { opacity: 0.45 },
      buttonText: { color: colors.foreground, fontSize: 13, fontWeight: "500" },
      buttonPrimaryText: { color: colors.accentForeground, fontSize: 13, fontWeight: "600" },
      buttonDangerText: { color: colors.statusDanger, fontSize: 13, fontWeight: "500" },
      iconButton: { width: 28, height: 28, borderRadius: RADIUS.sm, alignItems: "center", justifyContent: "center" },
      input: {
        color: colors.foreground,
        backgroundColor: colors.surface1,
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: RADIUS.md,
        paddingHorizontal: SPACE.sm + 2,
        paddingVertical: SPACE.sm,
        fontSize: 13,
        minHeight: 36,
      },
      inputMultiline: { minHeight: compact ? 88 : 110, textAlignVertical: "top", lineHeight: 19 },
      fieldLabel: { color: colors.foregroundMuted, fontSize: 12, fontWeight: "500" },
      badge: {
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        paddingHorizontal: 6,
        paddingVertical: 2,
        borderRadius: RADIUS.sm,
        backgroundColor: colors.surface1,
        borderWidth: 1,
        borderColor: colors.border,
      },
      badgeText: { color: colors.foreground, fontSize: 11, fontWeight: "500" },
      divider: { height: 1, backgroundColor: colors.border },
      notice: { backgroundColor: colors.surface1, borderRadius: RADIUS.md, borderWidth: 1, borderColor: colors.border, padding: SPACE.md, gap: 4 },
      noticeWarning: { borderColor: colors.statusWarning },
      noticeDanger: { borderColor: colors.statusDanger },
      board: { flex: 1, minHeight: 0 },
      boardRow: { flex: 1, flexDirection: "row", alignItems: "stretch", gap: SPACE.md },
      column: {
        backgroundColor: recessed,
        borderColor: dark ? colors.border : "transparent",
        borderWidth: 1,
        borderRadius: RADIUS.lg,
        overflow: "hidden",
      },
      columnHeader: { flexDirection: "row", alignItems: "center", gap: SPACE.sm, height: 40, paddingLeft: SPACE.md, paddingRight: 6 },
      columnTitle: { color: colors.foreground, fontSize: 13, fontWeight: "600" },
      columnBody: { paddingHorizontal: SPACE.sm, paddingBottom: SPACE.sm, gap: SPACE.sm },
      countPill: { paddingHorizontal: 6, minWidth: 20, height: 18, borderRadius: 9, alignItems: "center", justifyContent: "center", backgroundColor: dark ? colors.surface2 : colors.border },
      countText: { color: colors.foregroundMuted, fontSize: 11, fontWeight: "600" },
      columnEmpty: { color: colors.foregroundMuted, fontSize: 12, textAlign: "center", paddingVertical: SPACE.xl },
      columnDropTarget: { borderColor: colors.accent },
      boardCard: {
        backgroundColor: cardColor,
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: RADIUS.md,
        paddingVertical: SPACE.sm + 2,
        paddingHorizontal: SPACE.md,
        gap: 6,
        ...(dark ? {} : { boxShadow: "0px 1px 2px rgba(0, 0, 0, 0.05)" }),
      },
      boardCardHovered: { borderColor: colors.foregroundMuted },
      cardTitle: { color: colors.foreground, fontSize: 13, fontWeight: "600", lineHeight: 19 },
      cardDetails: { color: colors.foregroundMuted, fontSize: 12, lineHeight: 17 },
      metaRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", columnGap: SPACE.sm, rowGap: 4 },
      metaText: { color: colors.foregroundMuted, fontSize: 11 },
      dot: { width: 7, height: 7, borderRadius: 4 },
      dragHandle: { width: 16, height: 22, alignItems: "center", justifyContent: "center" },
      ghost: { position: "absolute", zIndex: 10, boxShadow: "0px 8px 24px rgba(0, 0, 0, 0.22)" },
      chip: {
        flexDirection: "row",
        alignItems: "center",
        gap: 5,
        height: 26,
        paddingHorizontal: SPACE.sm + 1,
        borderRadius: RADIUS.sm,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface1,
      },
      chipSelected: { backgroundColor: cardColor, borderColor: colors.foregroundMuted },
      chipText: { color: colors.foregroundMuted, fontSize: 12, fontWeight: "500" },
      chipSelectedText: { color: colors.foreground, fontSize: 12, fontWeight: "600" },
      listRow: {
        flexDirection: "row",
        alignItems: "center",
        gap: SPACE.sm + 2,
        paddingVertical: SPACE.sm,
        paddingHorizontal: SPACE.md,
        borderRadius: RADIUS.md,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface1,
      },
      listRowSelected: { borderColor: colors.accent },
      // Rows of settings in one bordered card, like the host's settings cards.
      group: { backgroundColor: colors.surface1, borderColor: colors.border, borderWidth: 1, borderRadius: RADIUS.lg, overflow: "hidden" },
      selectRow: { flexDirection: "row", alignItems: "center", gap: SPACE.md, minHeight: 48, paddingHorizontal: 14, paddingVertical: SPACE.sm },
      rowLabel: { color: colors.foreground, fontSize: 14 },
      rowValue: { color: colors.foreground, fontSize: 14, textAlign: "right" },
      menu: {
        backgroundColor: dark ? colors.surface1 : colors.surface0,
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: RADIUS.lg,
        padding: 4,
        boxShadow: dark ? "0px 8px 24px rgba(0, 0, 0, 0.5)" : "0px 8px 24px rgba(0, 0, 0, 0.12)",
      },
      menuItem: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 40, paddingHorizontal: 10, paddingVertical: 8, borderRadius: RADIUS.sm },
      section: { gap: SPACE.sm },
      sectionHeader: { flexDirection: "row", alignItems: "center", gap: SPACE.sm, minHeight: 28 },
      detailTitle: { color: colors.foreground, fontSize: 17, fontWeight: "600", lineHeight: 24 },
    };
  }, [theme, compact]);
}
