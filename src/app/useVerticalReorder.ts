import * as React from "react";

const DRAG_THRESHOLD_PX = 5;
const FALLBACK_ROW_HEIGHT = 36;
const FALLBACK_GAP = 2;
const AUTO_SCROLL_EDGE_PX = 36;
const AUTO_SCROLL_MAX_STEP_PX = 8;

interface MeasuredRect {
  top: number;
  bottom: number;
  height: number;
  center: number;
}

interface DragSession {
  id: string;
  fromIndex: number;
  toIndex: number;
  idsSnapshot: string[];
  pointerId: number;
  startX: number;
  startY: number;
  lastClientY: number;
  startScrollTop: number;
  activated: boolean;
  rects: MeasuredRect[];
  stride: number;
}

export interface ActiveDragState {
  id: string;
  fromIndex: number;
  toIndex: number;
  translateY: number;
  stride: number;
}

export interface UseVerticalReorderOptions {
  ids: readonly string[];
  enabled: boolean;
  scrollContainerRef: React.RefObject<HTMLElement | null>;
  onReorder: (nextIds: string[]) => void;
}

export interface VerticalReorderBindings {
  draggingId: string | null;
  isDraggingAny: boolean;
  setItemRef: (id: string) => (node: HTMLElement | null) => void;
  getPointerDownHandler: (id: string) => (event: React.PointerEvent<HTMLElement>) => void;
  consumeSuppressedClick: (id: string) => boolean;
  getItemStyle: (id: string, index: number) => React.CSSProperties | undefined;
  moveBy: (id: string, delta: -1 | 1) => void;
}

/** Move an item in `ids` from `fromIndex` to `toIndex`, returning a new array. */
export function reorderIds(ids: readonly string[], fromIndex: number, toIndex: number): string[] {
  if (
    fromIndex === toIndex ||
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= ids.length ||
    toIndex >= ids.length
  ) {
    return [...ids];
  }
  const next = [...ids];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}

function measureRects(
  ids: readonly string[],
  itemRefs: Map<string, HTMLElement>,
): { rects: MeasuredRect[]; stride: number } {
  const domRects = ids.map((id) => itemRefs.get(id)?.getBoundingClientRect());
  if (domRects.every((rect): rect is DOMRect => Boolean(rect && rect.height > 0))) {
    const rects = domRects.map((rect) => ({
      top: rect.top,
      bottom: rect.bottom,
      height: rect.height,
      center: rect.top + rect.height / 2,
    }));
    const stride =
      rects.length > 1
        ? Math.max(rects[1].top - rects[0].top, rects[0].height)
        : rects[0].height + FALLBACK_GAP;
    return { rects, stride };
  }

  const stride = FALLBACK_ROW_HEIGHT + FALLBACK_GAP;
  const rects = ids.map((_, index) => {
    const top = index * stride;
    return {
      top,
      bottom: top + FALLBACK_ROW_HEIGHT,
      height: FALLBACK_ROW_HEIGHT,
      center: top + FALLBACK_ROW_HEIGHT / 2,
    };
  });
  return { rects, stride };
}

/**
 * Pointer-based vertical drag-to-reorder hook plus keyboard/menu step moves.
 * Avoids HTML5 drag-and-drop so native Tauri file drop (`dragDropEnabled: true`) keeps working.
 */
export function useVerticalReorder({
  ids,
  enabled,
  scrollContainerRef,
  onReorder,
}: UseVerticalReorderOptions): VerticalReorderBindings {
  const itemRefs = React.useRef<Map<string, HTMLElement>>(new Map());
  const sessionRef = React.useRef<DragSession | null>(null);
  const cleanupListenersRef = React.useRef<(() => void) | null>(null);
  const rafIdRef = React.useRef<number | null>(null);
  const suppressedClickIdRef = React.useRef<string | null>(null);
  const suppressTimerRef = React.useRef<number | null>(null);

  const [activeDrag, setActiveDrag] = React.useState<ActiveDragState | null>(null);

  const idsRef = React.useRef(ids);
  idsRef.current = ids;
  const enabledRef = React.useRef(enabled);
  enabledRef.current = enabled;
  const onReorderRef = React.useRef(onReorder);
  onReorderRef.current = onReorder;

  const stopAutoScroll = React.useCallback(() => {
    if (rafIdRef.current !== null) {
      window.cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
  }, []);

  const teardownSession = React.useCallback(() => {
    cleanupListenersRef.current?.();
    cleanupListenersRef.current = null;
    stopAutoScroll();
    sessionRef.current = null;
    delete document.body.dataset.reordering;
  }, [stopAutoScroll]);

  const cancelSession = React.useCallback(() => {
    if (!sessionRef.current) return;
    teardownSession();
    setActiveDrag(null);
  }, [teardownSession]);

  const updateDragPosition = React.useCallback(
    (session: DragSession) => {
      const scrollDelta = (scrollContainerRef.current?.scrollTop ?? 0) - session.startScrollTop;
      const totalDy = session.lastClientY - session.startY + scrollDelta;
      const { rects, fromIndex, stride } = session;
      const minDy = rects[0].top - rects[fromIndex].top;
      const maxDy = rects[rects.length - 1].bottom - rects[fromIndex].bottom;
      const clampedDy = Math.max(minDy, Math.min(maxDy, totalDy));
      const draggedCenter = rects[fromIndex].center + clampedDy;

      let toIndex = fromIndex;
      if (clampedDy > 0) {
        for (let i = fromIndex + 1; i < rects.length; i += 1) {
          if (draggedCenter >= rects[i].center) {
            toIndex = i;
          } else {
            break;
          }
        }
      } else if (clampedDy < 0) {
        for (let i = fromIndex - 1; i >= 0; i -= 1) {
          if (draggedCenter <= rects[i].center) {
            toIndex = i;
          } else {
            break;
          }
        }
      }

      session.toIndex = toIndex;
      setActiveDrag({
        id: session.id,
        fromIndex,
        toIndex,
        translateY: clampedDy,
        stride,
      });
    },
    [scrollContainerRef],
  );

  const startAutoScroll = React.useCallback(() => {
    if (rafIdRef.current !== null) return;
    const tick = () => {
      const session = sessionRef.current;
      if (!session || !session.activated) {
        rafIdRef.current = null;
        return;
      }
      const container = scrollContainerRef.current;
      if (container) {
        const box = container.getBoundingClientRect();
        if (box.height > 0) {
          let step = 0;
          const distTop = session.lastClientY - box.top;
          const distBottom = box.bottom - session.lastClientY;
          if (distTop < AUTO_SCROLL_EDGE_PX && container.scrollTop > 0) {
            const ratio = Math.min(
              1,
              Math.max(0, (AUTO_SCROLL_EDGE_PX - distTop) / AUTO_SCROLL_EDGE_PX),
            );
            step = -Math.max(1, Math.round(ratio * AUTO_SCROLL_MAX_STEP_PX));
          } else if (
            distBottom < AUTO_SCROLL_EDGE_PX &&
            container.scrollTop + container.clientHeight < container.scrollHeight
          ) {
            const ratio = Math.min(
              1,
              Math.max(0, (AUTO_SCROLL_EDGE_PX - distBottom) / AUTO_SCROLL_EDGE_PX),
            );
            step = Math.max(1, Math.round(ratio * AUTO_SCROLL_MAX_STEP_PX));
          }
          if (step !== 0) {
            const before = container.scrollTop;
            container.scrollTop += step;
            if (container.scrollTop !== before) {
              updateDragPosition(session);
            }
          }
        }
      }
      rafIdRef.current = window.requestAnimationFrame(tick);
    };
    rafIdRef.current = window.requestAnimationFrame(tick);
  }, [scrollContainerRef, updateDragPosition]);

  // Cancel any in-flight drag if the underlying list changes structurally or reordering disables.
  const idsKey = ids.join("\0");
  React.useEffect(() => {
    cancelSession();
  }, [idsKey, enabled, cancelSession]);

  React.useEffect(() => {
    return () => {
      teardownSession();
      if (suppressTimerRef.current !== null) {
        window.clearTimeout(suppressTimerRef.current);
        suppressTimerRef.current = null;
      }
    };
  }, [teardownSession]);

  const setItemRef = React.useCallback(
    (id: string) => (node: HTMLElement | null) => {
      if (node) itemRefs.current.set(id, node);
      else itemRefs.current.delete(id);
    },
    [],
  );

  const getPointerDownHandler = React.useCallback(
    (id: string) => (event: React.PointerEvent<HTMLElement>) => {
      if (!enabledRef.current) return;
      const currentIds = idsRef.current;
      if (currentIds.length < 2) return;
      if (event.button !== 0 || event.isPrimary === false) return;
      if ((event.target as HTMLElement | null)?.closest("[data-no-drag]")) return;

      const fromIndex = currentIds.indexOf(id);
      if (fromIndex === -1) return;

      // Reset any previous lingering session before starting a new one.
      cancelSession();

      const { rects, stride } = measureRects(currentIds, itemRefs.current);
      const pointerId = event.pointerId ?? 0;
      const session: DragSession = {
        id,
        fromIndex,
        toIndex: fromIndex,
        idsSnapshot: [...currentIds],
        pointerId,
        startX: event.clientX,
        startY: event.clientY,
        lastClientY: event.clientY,
        startScrollTop: scrollContainerRef.current?.scrollTop ?? 0,
        activated: false,
        rects,
        stride,
      };
      sessionRef.current = session;

      const onPointerMove = (moveEvent: PointerEvent) => {
        const active = sessionRef.current;
        if (!active || (moveEvent.pointerId ?? 0) !== active.pointerId) return;

        if (!active.activated) {
          if (Math.hypot(moveEvent.clientX - active.startX, moveEvent.clientY - active.startY) < DRAG_THRESHOLD_PX) {
            return;
          }
          active.activated = true;
          document.body.dataset.reordering = "true";
          window.getSelection?.()?.removeAllRanges();
          startAutoScroll();
        }

        moveEvent.preventDefault();
        active.lastClientY = moveEvent.clientY;
        updateDragPosition(active);
      };

      const onPointerUp = (upEvent: PointerEvent) => {
        const active = sessionRef.current;
        if (!active || (upEvent.pointerId ?? 0) !== active.pointerId) return;
        const wasActivated = active.activated;
        const { fromIndex: startIdx, toIndex: endIdx, idsSnapshot, id: draggedId } = active;
        teardownSession();

        if (wasActivated) {
          suppressedClickIdRef.current = draggedId;
          if (suppressTimerRef.current !== null) {
            window.clearTimeout(suppressTimerRef.current);
          }
          suppressTimerRef.current = window.setTimeout(() => {
            suppressedClickIdRef.current = null;
            suppressTimerRef.current = null;
          }, 0);

          setActiveDrag(null);
          if (endIdx !== startIdx) {
            onReorderRef.current(reorderIds(idsSnapshot, startIdx, endIdx));
          }
        }
      };

      const onPointerCancel = (cancelEvent: PointerEvent) => {
        const active = sessionRef.current;
        if (!active || (cancelEvent.pointerId ?? 0) !== active.pointerId) return;
        cancelSession();
      };

      const onKeyDown = (keyEvent: KeyboardEvent) => {
        if (keyEvent.key !== "Escape") return;
        const active = sessionRef.current;
        if (!active) return;
        if (active.activated) {
          keyEvent.preventDefault();
          keyEvent.stopPropagation();
        }
        cancelSession();
      };

      const onBlur = () => {
        cancelSession();
      };

      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerCancel);
      window.addEventListener("blur", onBlur);
      window.addEventListener("keydown", onKeyDown, true);

      cleanupListenersRef.current = () => {
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        window.removeEventListener("pointercancel", onPointerCancel);
        window.removeEventListener("blur", onBlur);
        window.removeEventListener("keydown", onKeyDown, true);
      };
    },
    [cancelSession, scrollContainerRef, startAutoScroll, teardownSession, updateDragPosition],
  );

  const consumeSuppressedClick = React.useCallback((id: string) => {
    if (suppressedClickIdRef.current !== id) return false;
    suppressedClickIdRef.current = null;
    if (suppressTimerRef.current !== null) {
      window.clearTimeout(suppressTimerRef.current);
      suppressTimerRef.current = null;
    }
    return true;
  }, []);

  const getItemStyle = React.useCallback(
    (id: string, index: number): React.CSSProperties | undefined => {
      if (!activeDrag) return undefined;
      if (id === activeDrag.id) {
        return { transform: `translate3d(0, ${activeDrag.translateY}px, 0)` };
      }
      if (
        activeDrag.fromIndex < activeDrag.toIndex &&
        index > activeDrag.fromIndex &&
        index <= activeDrag.toIndex
      ) {
        return { transform: `translate3d(0, ${-activeDrag.stride}px, 0)` };
      }
      if (
        activeDrag.toIndex < activeDrag.fromIndex &&
        index >= activeDrag.toIndex &&
        index < activeDrag.fromIndex
      ) {
        return { transform: `translate3d(0, ${activeDrag.stride}px, 0)` };
      }
      return { transform: "translate3d(0, 0, 0)" };
    },
    [activeDrag],
  );

  const moveBy = React.useCallback((id: string, delta: -1 | 1) => {
    if (!enabledRef.current) return;
    const currentIds = idsRef.current;
    const index = currentIds.indexOf(id);
    if (index === -1) return;
    const nextIndex = index + delta;
    if (nextIndex < 0 || nextIndex >= currentIds.length) return;
    onReorderRef.current(reorderIds(currentIds, index, nextIndex));
  }, []);

  return {
    draggingId: activeDrag?.id ?? null,
    isDraggingAny: activeDrag !== null,
    setItemRef,
    getPointerDownHandler,
    consumeSuppressedClick,
    getItemStyle,
    moveBy,
  };
}
