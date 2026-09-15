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
  /** Horizontal scroll offset when the rects were measured. */
  scrollX: number;
  /**
   * Furthest auto-scroll, from the column extents at grab time. The translated card widens the
   * scrollable content as it moves, so trusting the scroll view's own limit would run away.
   */
  maxScrollX: number;
  pointer: { x: number; y: number; dx: number; dy: number };
}

export interface DragHandlers {
  onGrant: (x: number, y: number) => void;
  onMove: (x: number, y: number, dx: number, dy: number) => void;
  onRelease: () => void;
  onCancel: () => void;
}

export interface BoardDrag {
  draggingId: string | null;
  targetStatus: WorkItemStatus | null;
  translate: Animated.ValueXY;
  columnRef: (status: WorkItemStatus) => (view: View | null) => void;
  onScroll: (x: number) => void;
  handle: (view: WorkItemView) => DragHandlers;
}

/**
 * Pointer drag between columns on wide boards. Column rects are measured in window coordinates
 * when a card is grabbed; horizontal auto-scroll is folded back in by the scroll delta since then,
 * so hit-testing never re-measures mid-drag. The dragged card is translated in place rather than
 * cloned. Order inside a column follows priority, so a drop only picks the column.
 */
export function useBoardDrag(input: {
  columns: BoardColumn<WorkItemView>[];
  scrollRef: RefObject<NativeScrollView | null> | null;
  onDrop: (view: WorkItemView, status: WorkItemStatus) => void;
}): BoardDrag {
  const columnViews = useRef(new Map<WorkItemStatus, View | null>());
  const scrollX = useRef(0);
  const grab = useRef<Grab | null>(null);
  const ticker = useRef<ReturnType<typeof setInterval> | null>(null);
  const translate = useRef(new Animated.ValueXY()).current;
  const latest = useRef(input);
  latest.current = input;
  const [state, setState] = useState<{ draggingId: string | null; targetStatus: WorkItemStatus | null }>({
    draggingId: null,
    targetStatus: null,
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
    translate.setValue({ x: current.pointer.dx + scrollX.current - current.scrollX, y: current.pointer.dy });
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

  const columnRef = useMemo(() => {
    const cache = new Map<WorkItemStatus, (view: View | null) => void>();
    return (status: WorkItemStatus) => {
      let ref = cache.get(status);
      if (!ref) {
        ref = (view) => columnViews.current.set(status, view);
        cache.set(status, ref);
      }
      return ref;
    };
  }, []);

  function reset() {
    stopTicker();
    grab.current = null;
    translate.setValue({ x: 0, y: 0 });
    setState({ draggingId: null, targetStatus: null });
  }

  return {
    ...state,
    translate,
    columnRef,
    onScroll: (x) => {
      scrollX.current = x;
      update();
    },
    handle: (view) => ({
      onGrant: (x, y) => {
        const started: Grab = { view, columns: null, viewport: null, scrollX: scrollX.current, maxScrollX: 0, pointer: { x, y, dx: 0, dy: 0 } };
        grab.current = started;
        translate.setValue({ x: 0, y: 0 });
        setState({ draggingId: view.item.id, targetStatus: null });
        void (async () => {
          const columns = await Promise.all(
            latest.current.columns.map(async (column) => ({ status: column.status, rect: await measure(columnViews.current.get(column.status)) })),
          );
          const viewport = latest.current.scrollRef?.current ? await measure(latest.current.scrollRef.current as unknown as View) : null;
          if (grab.current !== started) return;
          started.scrollX = scrollX.current;
          started.viewport = viewport;
          started.columns = columns.flatMap((column) => (column.rect ? [{ status: column.status, rect: column.rect }] : []));
          const rowRight = Math.max(0, ...started.columns.map((column) => column.rect.x + column.rect.width));
          started.maxScrollX = viewport ? Math.max(0, started.scrollX + rowRight - (viewport.x + viewport.width)) : 0;
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
      <Icon name="GripVertical" size={16} color={props.theme.colors.foregroundMuted} />
    </View>
  );
}
