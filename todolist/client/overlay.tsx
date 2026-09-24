import type { PluginTheme } from "@getpaseo/plugin";
import { Overlay as HostOverlay, Icon, ScrollView as HostScrollView } from "@getpaseo/plugin/client/react-native";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from "react";
import {
  Keyboard,
  Modal as NativeModal,
  Platform,
  Pressable,
  StatusBar,
  StyleSheet,
  View,
  useWindowDimensions,
  type LayoutChangeEvent,
  type ViewStyle,
} from "react-native";
import { isDarkTheme } from "./styles";
import { guardModalWeb } from "./web";

/**
 * Every Todo pop-up draws itself: a dimmed window with a bare box, or a menu next to the button
 * that opened it. The host's dialogs would add a title bar, cap the width, and turn into bottom
 * sheets on phones. The host's `Overlay` layer carries them, owning focus, Escape, Android Back and
 * stacking. Hosts that predate it get one React Native modal per overlay instead, with
 * `guardModalWeb` keeping its focus trap from fighting the host's dialogs.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Windows narrower than this get the phone layout: boxes pinned to the top, edge to edge. */
export const PHONE_WIDTH = 600;
export const BOX_WIDTH = { wide: 680, narrow: 440 } as const;
export const PHONE_MARGIN = 12;
/** Room kept between floating things and the window edges, and between a menu and its button. */
export const EDGE = 8;
export const GAP = 6;
/**
 * The status bar's height where the host reports no safe-area insets: a translucent Android modal
 * draws under it, and iOS is assumed to have a notch.
 */
const FALLBACK_TOP_INSET = Platform.OS === "android" ? (StatusBar.currentHeight ?? 24) : Platform.OS === "ios" ? 44 : 0;

/** Undefined when the host is too old to have an overlay layer of its own. */
const hostOverlay = typeof HostOverlay === "function" ? HostOverlay : null;

/** The window's safe-area insets, as the host reports them in `layout.insets`. */
export interface SafeAreaInsets {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

const InsetsContext = createContext<SafeAreaInsets | undefined>(undefined);

/** Hands the host's `layout.insets` to every overlay below, so phone boxes start under the status bar. */
export function OverlayInsets(props: { insets: SafeAreaInsets | undefined; children: ReactNode }) {
  return <InsetsContext.Provider value={props.insets}>{props.children}</InsetsContext.Provider>;
}

/** Open overlays, newest last: Escape and the back button belong to the newest one only. */
const openOverlays: string[] = [];
let nextOverlayId = 0;

/** Measures a view in window coordinates, the ones an overlay's root uses. */
export function measureInWindow(view: View | null): Promise<Rect | null> {
  return new Promise((resolve) => {
    if (!view) resolve(null);
    // Android draws the translucent modal under the status bar; window measurements start below it.
    else view.measureInWindow((x, y, width, height) => resolve({ x, y: y + (Platform.OS === "android" ? (StatusBar.currentHeight ?? 0) : 0), width, height }));
  });
}

interface OverlayContextValue {
  theme: PluginTheme;
  phone: boolean;
  root: { width: number; height: number };
  /** The lowest point anything may reach: the window's bottom, or the keyboard's top. */
  bottom: number;
  keyboardOpen: boolean;
  /** The open box, for menus that drop under it on phones. */
  box: Rect | null;
  setBox: (box: Rect | null) => void;
  /** Escape, the back button and the scrim close the newest menu first; returns its remover. */
  pushDismiss: (dismiss: () => void) => () => void;
  close: () => void;
  setLayer: (id: string, node: ReactNode | null) => void;
  measure: (view: View | null) => Promise<Rect | null>;
}

const OverlayContext = createContext<OverlayContextValue | null>(null);

export function useOverlay(): OverlayContextValue {
  const value = useContext(OverlayContext);
  if (!value) throw new Error("useOverlay outside an overlay");
  return value;
}

/** The overlay around this component, or null for content embedded in a host surface. */
export function useOptionalOverlay(): OverlayContextValue | null {
  return useContext(OverlayContext);
}

/** Whether menus can float above a host surface in an overlay of their own. */
export const HOST_OVERLAY = hostOverlay !== null;

interface OverlayProps {
  theme: PluginTheme;
  open: boolean;
  onClose: () => void;
  variant: "box" | "menu";
  accessibilityLabel?: string;
  children: ReactNode;
}

/**
 * The layer behind every Todo pop-up. Its content mounts on each opening, so forms start fresh.
 * `variant` "box" dims the window; "menu" leaves it as is and closes on any press outside. Keep it
 * mounted and toggle `open`.
 */
export const Overlay = hostOverlay ? HostLayerOverlay : ModalOverlay;

/** On the host's own layer: Escape, Android Back and the backdrop reach a menu inside first. */
function HostLayerOverlay(props: OverlayProps) {
  const Layer = hostOverlay!;
  const onClose = useRef(props.onClose);
  onClose.current = props.onClose;
  const dismiss = useRef<() => void>(() => onClose.current());
  return (
    <Layer open={props.open} onClose={() => dismiss.current()} backdrop={props.variant === "box" ? "dim" : "clear"} {...(props.accessibilityLabel ? { accessibilityLabel: props.accessibilityLabel } : {})}>
      {props.open ? (
        <OverlayRoot theme={props.theme} scrim={null} dismissRef={dismiss} onClose={() => onClose.current()}>
          {props.children}
        </OverlayRoot>
      ) : null}
    </Layer>
  );
}

/**
 * Hosts without an overlay layer: a React Native modal. Its focus guard has to be listening before
 * the modal's own focus trap starts, which only holds when it registered on an earlier render.
 */
function ModalOverlay(props: OverlayProps) {
  const [modalId] = useState(() => `todo-overlay-${++nextOverlayId}`);
  const onClose = useRef(props.onClose);
  onClose.current = props.onClose;
  const dismiss = useRef<() => void>(() => onClose.current());
  const open = useRef(props.open);
  open.current = props.open;
  // Registered once, ahead of the modal's focus trap, and kept through the modal's fade out.
  useEffect(
    () =>
      guardModalWeb(modalId, () => {
        if (!open.current || openOverlays[openOverlays.length - 1] !== modalId) return false;
        dismiss.current();
        return true;
      }) ?? undefined,
    [modalId],
  );
  useEffect(() => {
    if (!props.open) return undefined;
    openOverlays.push(modalId);
    return () => {
      const index = openOverlays.lastIndexOf(modalId);
      if (index !== -1) openOverlays.splice(index, 1);
    };
  }, [props.open, modalId]);
  return (
    <NativeModal
      {...({ nativeID: modalId } as object)}
      visible={props.open}
      transparent
      animationType={props.variant === "box" ? "fade" : "none"}
      statusBarTranslucent={Platform.OS === "android"}
      // The web's Escape is taken on key down by `guardModalWeb`; this one fires on key up.
      onRequestClose={() => Platform.OS !== "web" && dismiss.current()}
    >
      {props.open ? (
        <OverlayRoot theme={props.theme} scrim={props.variant} dismissRef={dismiss} onClose={() => onClose.current()}>
          {props.children}
        </OverlayRoot>
      ) : null}
    </NativeModal>
  );
}

function OverlayRoot(props: {
  theme: PluginTheme;
  /** The press-to-close layer to draw; null where the host draws its own backdrop. */
  scrim: "box" | "menu" | null;
  dismissRef: MutableRefObject<() => void>;
  onClose: () => void;
  children: ReactNode;
}) {
  const screen = useWindowDimensions();
  const [root, setRoot] = useState({ width: screen.width, height: screen.height });
  const [keyboardTop, setKeyboardTop] = useState<number | null>(null);
  const [box, setBox] = useState<Rect | null>(null);
  const [layers, setLayers] = useState<ReadonlyMap<string, ReactNode>>(new Map());
  const rootRef = useRef<View | null>(null);
  const dismissals = useRef<(() => void)[]>([]);
  const onClose = props.onClose;
  props.dismissRef.current = () => {
    const newest = dismissals.current[dismissals.current.length - 1];
    if (newest) newest();
    else onClose();
  };

  // Phones: boxes and menus never reach under the keyboard.
  useEffect(() => {
    if (Platform.OS === "web") return undefined;
    const ios = Platform.OS === "ios";
    const shown = Keyboard.addListener(ios ? "keyboardWillShow" : "keyboardDidShow", (event) => setKeyboardTop(event.endCoordinates.screenY));
    const hidden = Keyboard.addListener(ios ? "keyboardWillHide" : "keyboardDidHide", () => setKeyboardTop(null));
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, []);

  const pushDismiss = useCallback((dismiss: () => void) => {
    dismissals.current.push(dismiss);
    return () => {
      const index = dismissals.current.lastIndexOf(dismiss);
      if (index !== -1) dismissals.current.splice(index, 1);
    };
  }, []);
  const setLayer = useCallback((id: string, node: ReactNode | null) => {
    setLayers((current) => {
      if (node === null && !current.has(id)) return current;
      const next = new Map(current);
      if (node === null) next.delete(id);
      else next.set(id, node);
      return next;
    });
  }, []);
  const measure = useCallback(async (view: View | null) => {
    const [base, target] = await Promise.all([measureInWindow(rootRef.current), measureInWindow(view)]);
    return base && target ? { x: target.x - base.x, y: target.y - base.y, width: target.width, height: target.height } : null;
  }, []);

  const bottom = Math.min(root.height, keyboardTop ?? root.height);
  const value = useMemo<OverlayContextValue>(
    () => ({
      theme: props.theme,
      phone: root.width < PHONE_WIDTH,
      root,
      bottom,
      keyboardOpen: keyboardTop !== null,
      box,
      setBox,
      pushDismiss,
      close: onClose,
      setLayer,
      measure,
    }),
    [props.theme, root, bottom, keyboardTop, box, pushDismiss, onClose, setLayer, measure],
  );
  const dark = isDarkTheme(props.theme);
  return (
    <OverlayContext.Provider value={value}>
      {/* Presses outside the box fall through to the host's backdrop, where there is one. */}
      <View
        ref={rootRef}
        pointerEvents="box-none"
        style={{ flex: 1 }}
        onLayout={(event) => setRoot({ width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height })}
      >
        {props.scrim ? (
          <Pressable
            accessibilityLabel="Close"
            focusable={false}
            onPress={() => props.dismissRef.current()}
            style={[StyleSheet.absoluteFill, props.scrim === "box" ? { backgroundColor: dark ? "rgba(0, 0, 0, 0.55)" : "rgba(24, 24, 27, 0.32)" } : null]}
          />
        ) : null}
        {props.children}
        {[...layers.entries()].map(([id, node]) => (
          <View key={id} pointerEvents="box-none" style={StyleSheet.absoluteFill}>
            {node}
          </View>
        ))}
      </View>
    </OverlayContext.Provider>
  );
}

/** Renders its children above everything else in the overlay, where no box or scroll clips them. */
export function OverlayLayer(props: { children: ReactNode }) {
  const { setLayer } = useOverlay();
  const id = useId();
  useLayoutEffect(() => {
    setLayer(id, props.children);
  });
  useLayoutEffect(() => () => setLayer(id, null), [id, setLayer]);
  return null;
}

/** Registers a dismissal (a menu's close) that Escape, the back button and the scrim reach first. */
export function useDismiss(active: boolean, dismiss: () => void): void {
  // Outside an overlay there is no stack to join: an embedded menu closes through its own layer.
  const pushDismiss = useContext(OverlayContext)?.pushDismiss;
  const latest = useRef(dismiss);
  latest.current = dismiss;
  useEffect(() => (active && pushDismiss ? pushDismiss(() => latest.current()) : undefined), [active, pushDismiss]);
}

/** Box geometry, for content that sizes itself, such as a text area that grows with its text. */
interface BoxContextValue {
  maxHeight: number;
  /** The box's current height, 0 before its first layout. */
  height: number;
  phone: boolean;
  /** A cap on a growing text area's lines, where the box shares its space with other content. */
  maxLines?: number;
}
const BoxContext = createContext<BoxContextValue>({ maxHeight: 0, height: 0, phone: false });
export const useBox = (): BoxContextValue => useContext(BoxContext);

/**
 * Where menus of a box embedded in a host surface go when no overlay can float them (hosts that
 * predate `Overlay`): a slot the box renders under its content.
 */
interface EmbedContextValue {
  phone: boolean;
  /** Shows `node` in the slot for `owner`'s open menu; null clears it if `owner` still holds it. */
  setInlineMenu: (owner: symbol, node: ReactNode | null) => void;
}
const EmbedContext = createContext<EmbedContextValue | null>(null);
export const useEmbed = (): EmbedContextValue | null => useContext(EmbedContext);

/**
 * The same box content placed inside a host surface, such as the header popover: no scrim and no
 * close button, a border instead of a shadow, and a text area capped at `maxLines`.
 */
export function EmbeddedBox(props: {
  theme: PluginTheme;
  phone: boolean;
  maxLines: number;
  nativeID?: string;
  cover?: ReactNode;
  onLayout?: (event: LayoutChangeEvent) => void;
  children: ReactNode;
}) {
  const { theme } = props;
  const [height, setHeight] = useState(0);
  const [inlineMenu, setInlineMenuState] = useState<{ owner: symbol; node: ReactNode } | null>(null);
  const setInlineMenu = useCallback((owner: symbol, node: ReactNode | null) => {
    setInlineMenuState((current) => (node !== null ? { owner, node } : current?.owner === owner ? null : current));
  }, []);
  const box = useMemo(() => ({ maxHeight: Number.MAX_SAFE_INTEGER, height, phone: props.phone, maxLines: props.maxLines }), [height, props.phone, props.maxLines]);
  const embed = useMemo(() => ({ phone: props.phone, setInlineMenu }), [props.phone, setInlineMenu]);
  return (
    <BoxContext.Provider value={box}>
      <EmbedContext.Provider value={embed}>
        <View
          nativeID={props.nativeID}
          onLayout={(event) => {
            setHeight(event.nativeEvent.layout.height);
            props.onLayout?.(event);
          }}
          style={{
            backgroundColor: theme.colors.surface0,
            borderWidth: 1,
            borderColor: theme.colors.border,
            borderRadius: 12,
            paddingTop: 10,
            paddingLeft: 12,
            paddingRight: 10,
            paddingBottom: 8,
          }}
        >
          {props.children}
          {inlineMenu?.node}
          {props.cover}
        </View>
      </EmbedContext.Provider>
    </BoxContext.Provider>
  );
}

/**
 * The bare box: an optional line of small print on top instead of a title, the content, and a
 * footer that stays in view while the content scrolls. 680 or 440 wide on desktops, a sixth of the
 * way down; pinned under the status bar at full width on phones. A round close button rides on its
 * top right corner, outside the content.
 */
export function OverlayBox(props: {
  size: "wide" | "narrow";
  /** Share of the window the box may grow to; the card panel takes more than a form. */
  maxRatio?: number;
  accessibilityLabel: string;
  meta?: ReactNode;
  footer?: ReactNode;
  /** False when the content scrolls itself, such as a growing text area. */
  scroll?: boolean;
  /** Layered over the box's content, such as the drop hint. */
  cover?: ReactNode;
  /** Paste and drop target for images. */
  nativeID?: string;
  onLayout?: (event: LayoutChangeEvent) => void;
  children: ReactNode;
}) {
  const overlay = useOverlay();
  const { theme, phone, root, bottom, keyboardOpen } = overlay;
  const insets = useContext(InsetsContext);
  const ratio = props.maxRatio ?? 0.7;
  const width = phone ? root.width - PHONE_MARGIN * 2 : Math.min(BOX_WIDTH[props.size], root.width - 48);
  const left = phone ? PHONE_MARGIN : Math.round((root.width - width) / 2);
  const cap = Math.round(root.height * ratio);
  const top = phone ? (insets?.top ?? FALLBACK_TOP_INSET) + PHONE_MARGIN : Math.max(24, Math.min(Math.round(root.height / 6), root.height - cap - 24));
  const maxHeight = phone
    ? keyboardOpen
      ? bottom - top - EDGE
      : Math.min(ratio > 0.8 ? root.height : cap, root.height - top - PHONE_MARGIN - (insets?.bottom ?? 0))
    : Math.min(cap, root.height - top - 16);
  const dark = isDarkTheme(theme);
  const setBox = overlay.setBox;
  const [height, setHeight] = useState(0);
  useEffect(() => () => setBox(null), [setBox]);
  const box = useMemo(() => ({ maxHeight, height, phone }), [maxHeight, height, phone]);
  return (
    <BoxContext.Provider value={box}>
      <View
        nativeID={props.nativeID}
        accessibilityViewIsModal
        accessibilityLabel={props.accessibilityLabel}
        onLayout={(event) => {
          const layout = event.nativeEvent.layout;
          setBox({ x: layout.x, y: layout.y, width: layout.width, height: layout.height });
          setHeight(layout.height);
          props.onLayout?.(event);
        }}
        style={{
          position: "absolute",
          top,
          left,
          width,
          // Content that sizes itself reads the cap from `useBox` instead, and needs the box's real
          // height to do so, which a clipped box would hide.
          ...(props.scroll === false ? {} : { maxHeight }),
          backgroundColor: theme.colors.surface0,
          borderWidth: 1,
          borderColor: theme.colors.border,
          borderRadius: phone ? 14 : 16,
          paddingTop: phone ? 12 : 14,
          paddingLeft: phone ? 12 : 14,
          paddingRight: phone ? 10 : 14,
          paddingBottom: phone ? 8 : 10,
          boxShadow: dark
            ? "0px 28px 72px rgba(0, 0, 0, 0.65), 0px 2px 6px rgba(0, 0, 0, 0.45)"
            : "0px 24px 64px rgba(24, 24, 27, 0.22), 0px 2px 6px rgba(24, 24, 27, 0.08)",
        }}
      >
        {props.meta}
        {props.scroll === false ? (
          <View style={{ flexShrink: 1, minHeight: 0 }}>{props.children}</View>
        ) : (
          <HostScrollView style={{ flexGrow: 0, flexShrink: 1 }} keyboardShouldPersistTaps="handled" bounces={false}>
            {props.children}
          </HostScrollView>
        )}
        {props.footer}
        {props.cover}
        <CloseButton theme={theme} phone={phone} onPress={overlay.close} />
      </View>
    </BoxContext.Provider>
  );
}

function CloseButton(props: { theme: PluginTheme; phone: boolean; onPress: () => void }) {
  const { theme } = props;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Close"
      hitSlop={6}
      onPress={props.onPress}
      style={({ hovered, pressed }: { hovered?: boolean; pressed: boolean }) => ({
        position: "absolute",
        top: props.phone ? -9 : -11,
        right: props.phone ? -8 : -11,
        zIndex: 3,
        width: 26,
        height: 26,
        borderRadius: 13,
        alignItems: "center",
        justifyContent: "center",
        borderWidth: 1,
        borderColor: hovered || pressed ? theme.colors.foregroundMuted : theme.colors.border,
        backgroundColor: theme.colors.surface2,
        boxShadow: "0px 2px 8px rgba(0, 0, 0, 0.35)",
      })}
    >
      <Icon name="X" size={13} color={theme.colors.foreground} />
    </Pressable>
  );
}

/** A box's top line of small print: what it is, instead of a title bar. */
export function MetaLine(props: { theme: PluginTheme; children: ReactNode; style?: ViewStyle }) {
  return (
    <View style={[{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6, marginTop: -2, marginBottom: 8, marginLeft: 2, paddingRight: 12 }, props.style]}>
      {props.children}
    </View>
  );
}

/** Where a floating panel goes: under its anchor when it fits there, above it otherwise. */
export type Placement = { left: number; width: number; maxHeight: number } & ({ top: number } | { bottom: number });

export function placeNear(input: {
  anchor: Rect;
  root: { width: number; height: number };
  bottom: number;
  width: number;
  /** How tall the panel would like to be. */
  wanted: number;
  /** Line up with the anchor's left edge, or with its right edge. */
  align?: "start" | "end";
}): Placement {
  const { anchor, root } = input;
  const width = Math.min(input.width, root.width - EDGE * 2);
  const preferred = input.align === "end" ? anchor.x + anchor.width - width : anchor.x;
  const left = Math.min(Math.max(EDGE, preferred), root.width - width - EDGE);
  const below = input.bottom - EDGE - (anchor.y + anchor.height + GAP);
  const above = anchor.y - GAP - EDGE;
  if (below >= input.wanted || below >= above) return { left, width, top: anchor.y + anchor.height + GAP, maxHeight: Math.min(input.wanted, below) };
  return { left, width, bottom: root.height - anchor.y + GAP, maxHeight: Math.min(input.wanted, above) };
}

/**
 * A menu overlay next to the button that opened it: no scrim and no close button, closed by a
 * press anywhere else, Escape or the back button. `anchor` is the button in window coordinates.
 */
export function AnchoredOverlay(props: {
  theme: PluginTheme;
  open: boolean;
  onClose: () => void;
  anchor: Rect | null;
  width: number;
  wanted: number;
  align?: "start" | "end";
  children: (placement: Placement) => ReactNode;
}) {
  return (
    <Overlay theme={props.theme} open={props.open && props.anchor !== null} onClose={props.onClose} variant="menu">
      {props.anchor ? <Anchored {...props} anchor={props.anchor} /> : null}
    </Overlay>
  );
}

function Anchored(props: { anchor: Rect; width: number; wanted: number; align?: "start" | "end"; children: (placement: Placement) => ReactNode }) {
  const { root, bottom } = useOverlay();
  return <>{props.children(placeNear({ anchor: props.anchor, root, bottom, width: props.width, wanted: props.wanted, ...(props.align ? { align: props.align } : {}) }))}</>;
}
