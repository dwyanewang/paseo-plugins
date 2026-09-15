import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Animated, PanResponder, View, type ScrollView as NativeScrollView } from "react-native";
import { dropColumnAt, type BoardColumn, type MeasuredColumn, type Rect } from "../shared/board";
import type { WorkItemStatus } from "../shared/schema";
import type { WorkItemView } from "./data";
import type { TodoStyles } from "./styles";

/** Distance from the scroll viewport edge that starts auto-scrolling, and the step per tick. */
const EDGE = 56;
const STEP = 16;

function measure(view: View | null | undefined): Promise<Rect | null> {
  return new Promise((resolve) => {
    if (!view) {
      resolve(null);
      return;
    }
    view.measureInWindow((x, y, width, height) => resolve({ x, y, width, height }));
  });
}

interface Grab {
  view: WorkItemView;
  columns: MeasuredColumn[] | null;
  viewport: Rect | null;
  /** Where the grabbed card sat inside the board when it was picked up. */
  origin: { x: number; y: number } | null;
  /** Horizontal scroll offset when the rects were measured. */
  scrollX: number;
  /** Furthest auto-scroll, from the column extents at grab time. */
  maxScrollX: number;
  pointer: { x: number; y: number; dx: number; dy: number };
}

export interface DragHandlers {
  onGrant: (x: number, y: number) => void;
  onMove: (x: number, y: number, dx: number, dy: number) => void;
  onRelease: () => void;
  onCancel: () => void;
}

/** A ref callback per key, stable across renders so views are not detached and re-attached. */
function useRefRegistry<Key>() {
  const views = useRef(new Map<Key, View | null>());
  const register = useMemo(() => {
    const cache = new Map<Key, (view: View | null) => void>();
    return (key: Key) => {
      let ref = cache.get(key);
      if (!ref) {
        ref = (view) => views.current.set(key, view);
        cache.set(key, ref);
      }
      return ref;
    };
  }, []);
  return { views, register };
}

export interface BoardDrag {
  draggingId: string | null;
  targetStatus: WorkItemStatus | null;
  /** The card that follows the pointer, once its size and place are known. */
  ghost: { view: WorkItemView; width: number } | null;
  ghostPosition: Animated.ValueXY;
  boardRef: (view: View | null) => void;
  columnRef: (status: WorkItemStatus) => (view: View | null) => void;
  cardRef: (id: string) => (view: View | null) => void;
  onScroll: (x: number) => void;
  handle: (view: WorkItemView) => DragHandlers;
}

/**
 * Pointer drag between columns on wide boards. Column rects are measured in window coordinates
 * when a card is grabbed; horizontal auto-scroll is folded back in by the scroll delta since then,
 * so hit-testing never re-measures mid-drag. Columns scroll and clip their cards, so the pointer
 * carries a ghost drawn above the whole board while the original stays in place, faded. Order
 * inside a column follows priority, so a drop only picks the column.
 */
export function useBoardDrag(input: {
  columns: BoardColumn<WorkItemView>[];
  scrollRef: RefObject<NativeScrollView | null> | null;
  onDrop: (view: WorkItemView, status: WorkItemStatus) => void;
}): BoardDrag {
  const board = useRef<View | null>(null);
  const boardRef = useMemo(() => (view: View | null) => {
    board.current = view;
  }, []);
  const columns = useRefRegistry<WorkItemStatus>();
  const cards = useRefRegistry<string>();
  const scrollX = useRef(0);
  const grab = useRef<Grab | null>(null);
  const ticker = useRef<ReturnType<typeof setInterval> | null>(null);
  const ghostPosition = useRef(new Animated.ValueXY()).current;
  const latest = useRef(input);
  latest.current = input;
  const [state, setState] = useState<{ draggingId: string | null; targetStatus: WorkItemStatus | null; ghost: BoardDrag["ghost"] }>({
    draggingId: null,
    targetStatus: null,
    ghost: null,
  });

  useEffect(() => () => {
    if (ticker.current) clearInterval(ticker.current);
  }, []);

  function stopTicker() {
    if (ticker.current) clearInterval(ticker.current);
    ticker.current = null;
  }

  function targetOf(current: Grab): WorkItemStatus | null {
    if (!current.columns) return null;
    return dropColumnAt({ x: current.pointer.x + scrollX.current - current.scrollX, y: current.pointer.y }, current.columns);
  }

  function update() {
    const current = grab.current;
    if (!current) return;
    if (current.origin) ghostPosition.setValue({ x: current.origin.x + current.pointer.dx, y: current.origin.y + current.pointer.dy });
    const targetStatus = targetOf(current);
    setState((previous) => (previous.targetStatus === targetStatus ? previous : { ...previous, targetStatus }));
  }

  function autoScroll() {
    const current = grab.current;
    const scroller = latest.current.scrollRef?.current;
    if (!current || !current.viewport || !scroller) return;
    const { x } = current.pointer;
    const direction = x < current.viewport.x + EDGE ? -1 : x > current.viewport.x + current.viewport.width - EDGE ? 1 : 0;
    if (direction === 0) {
      stopTicker();
      return;
    }
    if (ticker.current) return;
    ticker.current = setInterval(() => {
      const next = Math.min(current.maxScrollX, Math.max(0, scrollX.current + direction * STEP));
      if (next === scrollX.current) {
        stopTicker();
        return;
      }
      scroller.scrollTo({ x: next, animated: false });
    }, 16);
  }

  function reset() {
    stopTicker();
    grab.current = null;
    setState({ draggingId: null, targetStatus: null, ghost: null });
  }

  return {
    ...state,
    ghostPosition,
    boardRef,
    columnRef: columns.register,
    cardRef: cards.register,
    onScroll: (x) => {
      scrollX.current = x;
      update();
    },
    handle: (view) => ({
      onGrant: (x, y) => {
        const started: Grab = { view, columns: null, viewport: null, origin: null, scrollX: scrollX.current, maxScrollX: 0, pointer: { x, y, dx: 0, dy: 0 } };
        grab.current = started;
        setState({ draggingId: view.item.id, targetStatus: null, ghost: null });
        void (async () => {
          const [measured, viewport, boardRect, cardRect] = await Promise.all([
            Promise.all(latest.current.columns.map(async (column) => ({ status: column.status, rect: await measure(columns.views.current.get(column.status)) }))),
            latest.current.scrollRef?.current ? measure(latest.current.scrollRef.current as unknown as View) : Promise.resolve(null),
            measure(board.current),
            measure(cards.views.current.get(view.item.id)),
          ]);
          if (grab.current !== started) return;
          started.scrollX = scrollX.current;
          started.viewport = viewport;
          started.columns = measured.flatMap((column) => (column.rect ? [{ status: column.status, rect: column.rect }] : []));
          const rowRight = Math.max(0, ...started.columns.map((column) => column.rect.x + column.rect.width));
          started.maxScrollX = viewport ? Math.max(0, started.scrollX + rowRight - (viewport.x + viewport.width)) : 0;
          if (boardRect && cardRect) {
            started.origin = { x: cardRect.x - boardRect.x, y: cardRect.y - boardRect.y };
            setState((previous) => ({ ...previous, ghost: { view, width: cardRect.width } }));
          }
          update();
        })();
      },
      onMove: (x, y, dx, dy) => {
        if (!grab.current) return;
        grab.current.pointer = { x, y, dx, dy };
        update();
        autoScroll();
      },
      onRelease: () => {
        const current = grab.current;
        const targetStatus = current ? targetOf(current) : null;
        reset();
        if (current && targetStatus && targetStatus !== current.view.item.status) latest.current.onDrop(current.view, targetStatus);
      },
      onCancel: reset,
    }),
  };
}

/**
 * The grip on a wide card. It claims the pointer on contact and keeps it for the whole gesture, so
 * it is only rendered where no touch scrolling competes for it. It is hidden from assistive
 * technology: the move menu is the accessible way to move a card.
 */
export function DragHandle(props: { styles: TodoStyles; theme: PluginTheme; handlers: DragHandlers }) {
  const handlers = useRef(props.handlers);
  handlers.current = props.handlers;
  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: (_event, gesture) => handlers.current.onGrant(gesture.x0, gesture.y0),
        onPanResponderMove: (_event, gesture) => handlers.current.onMove(gesture.moveX, gesture.moveY, gesture.dx, gesture.dy),
        onPanResponderRelease: () => handlers.current.onRelease(),
        onPanResponderTerminate: () => handlers.current.onCancel(),
      }),
    [],
  );
  return (
    <View
      {...responder.panHandlers}
      aria-hidden
      importantForAccessibility="no-hide-descendants"
      style={[props.styles.dragHandle, { cursor: "grab" } as object]}
    >
      <Icon name="GripVertical" size={14} color={props.theme.colors.foregroundMuted} />
    </View>
  );
}
