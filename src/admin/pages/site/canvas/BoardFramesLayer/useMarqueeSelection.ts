/**
 * useMarqueeSelection — the marquee (drag-to-select) gesture for board
 * frames (WS-7.1). Extracted out of `BoardFramesLayer.tsx` (module-size-
 * budgets ceiling — the gesture wiring was ~140 lines on its own).
 *
 * Marquee gesture arbitration (board-02): the listeners live on
 * `canvasRootRef.current` (the untransformed canvas root DOM node from
 * `CanvasViewportActionsContext`), NOT on `.layer` itself. `.layer` is
 * `position: absolute; top: 0; left: 0` with no explicit size — in studio
 * board mode its only children are themselves absolutely-positioned (each
 * `.frame`, the notes/docs layers), which don't contribute to an
 * absolutely-positioned parent's auto size, so `.layer` (and its own
 * ancestor `.transformLayer`, same story) is an effectively 0×0 element.
 * A pointerdown on genuinely empty canvas space therefore never lands on
 * `.layer` at all — `elementFromPoint` resolves it straight to
 * `canvasRootRef.current` (confirmed in a real browser; this was the actual
 * defect behind "click and drag don't select multiple", not the pointer-
 * capture redirect originally suspected). Attaching NATIVE listeners
 * directly to that node (not JSX props on `.layer`) fixes the hit-testing
 * and, as a deliberate side effect, resolves who wins between marquee-drag
 * and `useCanvas`'s pan gesture: native listeners on a specific DOM node
 * fire during actual native bubbling, which reaches that node BEFORE the
 * event finishes bubbling to the app root where React's synthetic dispatch
 * (and therefore `useCanvas`'s `bind()`-spread pan handlers) lives. So when
 * `handlePointerDown` below decides to arm a marquee, calling
 * `stopPropagation()` deterministically means the pan gesture's own
 * pointerdown handler never runs for that event at all — no ambiguity, no
 * dependence on `isDraggingRef`'s button-mask guard happening to no-op.
 * Space-held or middle-button drags are explicitly NOT claimed here (the
 * same `isCanvasSpacePanActive`/button checks as before), so they fall
 * through untouched to the pan gesture, unchanged.
 * `setPointerCapture` on that same node keeps move/up events targeting it
 * even when the cursor crosses a live frame's `<iframe>` (a separate
 * browsing context — without capture, hovering the iframe mid-drag would
 * start delivering pointer events to the IFRAME's own document instead).
 * A completed drag (one that crossed `MARQUEE_DRAG_THRESHOLD_PX`) also
 * suppresses the single trailing native 'click' event mouseup generates —
 * without that, `CanvasRoot`'s background-click-to-deselect handler would
 * immediately clear the selection the drag just made.
 *
 * `select-01`: a non-additive marquee also clears any NODE selection as soon as
 * it passes the threshold. It is a replacing gesture, and `setSelectedFrameIds`
 * only drops the node selection when it selects at least one frame — so a drag
 * over empty board used to end with the old node still selected.
 *
 * `board-03`: what the marquee hit-tests against is now each frame's RENDERED
 * box, measured once at pointerdown (`measureFrameRects`), not a board-space
 * rect derived from `board.frames[].height`. See `framesInMarquee.ts` for why
 * the derived rect was a fiction for every auto-height frame — which is every
 * frame on a freshly seeded board.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { useEditorStore } from '@site/store/store'
import { isCanvasSpacePanActive } from '../canvasPanInput'
import { framesInMarquee, marqueeRectFromPoints, type MarqueeFrame, type MarqueeRect } from './framesInMarquee'

/** Marquee movement (screen px) before a drag counts as "selecting", so a plain click doesn't flash an empty marquee. */
const MARQUEE_DRAG_THRESHOLD_PX = 3

/**
 * Every board frame's RENDERED box, in the same canvas-root-relative screen
 * space the marquee rect is built in.
 *
 * Read once per gesture, at pointerdown: a marquee drag owns the pointer for
 * its whole duration (it claims the event before `useCanvas`'s pan gesture
 * sees it, and nothing else moves or resizes a frame meanwhile), so one layout
 * pass covers the drag. Every frame on the board is measurable regardless of
 * virtualization — `BoardFramesLayer` only swaps a frame's BODY for a poster
 * when it goes offscreen, the `.frame` box itself always stays mounted.
 */
function measureFrameRects(layerEl: HTMLElement, canvasRootEl: HTMLElement): MarqueeFrame[] {
  const origin = canvasRootEl.getBoundingClientRect()
  const frames: MarqueeFrame[] = []
  for (const el of layerEl.querySelectorAll<HTMLElement>('[data-page-id]')) {
    const pageId = el.dataset.pageId
    if (!pageId) continue
    const rect = el.getBoundingClientRect()
    frames.push({
      pageId,
      x: rect.left - origin.left,
      y: rect.top - origin.top,
      width: rect.width,
      height: rect.height,
    })
  }
  return frames
}

/**
 * Wires the marquee gesture onto `canvasRootRef.current` and returns the
 * current screen-space marquee rect (`null` when no drag is in progress, or
 * before it has crossed the drag threshold). The caller (`BoardFramesLayer`)
 * portals this into the canvas root for rendering — see that component for
 * why the portal target has to be OUTSIDE the transformed `.layer`.
 *
 * `framesLayerRef` points at `BoardFramesLayer`'s own `.layer` div, which is
 * both the frame-rect source and the "are we on a studio board at all?" gate:
 * it is only rendered in studio board mode, so a null ref means a drag on the
 * CMS/Visual-Component canvas, which must fall through to the pan gesture.
 */
export function useMarqueeSelection(
  canvasRootRef: RefObject<HTMLElement | null> | undefined,
  framesLayerRef: RefObject<HTMLElement | null>,
): MarqueeRect | null {
  // Marquee drag (WS-7.1). `marqueeDragRef` carries the in-progress gesture;
  // `marqueeRect` is only set once movement crosses MARQUEE_DRAG_THRESHOLD_PX,
  // so a plain background click never flashes an empty marquee (and never
  // touches the selection — see CanvasRoot's background-click handler for
  // the "click empty canvas to deselect" path).
  const marqueeDragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    additive: boolean
    baseSelection: string[]
    frames: MarqueeFrame[]
  } | null>(null)
  const [marqueeRect, setMarqueeRect] = useState<MarqueeRect | null>(null)
  // Mirrors `marqueeRect` for the native pointer-event effect below, which
  // (deliberately) does not re-run per render — its closures would otherwise
  // see the `marqueeRect` value from the render that mounted the effect
  // forever, never a later update. `setMarqueeRectBoth` keeps the two in
  // lockstep at every call site.
  const marqueeRectRef = useRef<MarqueeRect | null>(null)
  // Exception #1 (react-compiler-and-memoization): referenced in the native
  // pointer-event effect's dependency array below.
  const setMarqueeRectBoth = useCallback((next: MarqueeRect | null) => {
    marqueeRectRef.current = next
    setMarqueeRect(next)
  }, [])

  // Attached once per mount of the canvas root (the ref itself is stable —
  // a `useRef` owned by `CanvasRoot` — so this doesn't thrash on every
  // render); every handler below reads fresh state via
  // `useEditorStore.getState()` instead of closing over render-scoped
  // values, since the effect intentionally does not re-run per render.
  useEffect(() => {
    const canvasRootEl = canvasRootRef?.current
    if (!canvasRootEl) return

    // Set once a completed drag (past the threshold) ends, so the single
    // trailing native 'click' event mouseup generates doesn't reach
    // `CanvasRoot`'s background-click-to-deselect handler and immediately
    // wipe the selection the drag just made.
    let suppressNextClick = false

    const handlePointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return
      if (e.target !== canvasRootEl) return
      if (isCanvasSpacePanActive(document)) return
      const layerEl = framesLayerRef.current
      if (!layerEl) return
      const rect = canvasRootEl.getBoundingClientRect()
      marqueeDragRef.current = {
        pointerId: e.pointerId,
        startX: e.clientX - rect.left,
        startY: e.clientY - rect.top,
        additive: e.shiftKey,
        baseSelection: useEditorStore.getState().selectedFrameIds,
        frames: measureFrameRects(layerEl, canvasRootEl),
      }
      canvasRootEl.setPointerCapture(e.pointerId)
      // Claim the whole gesture — see the module doc for why this
      // deterministically means the pan gesture's pointerdown never runs
      // for this event.
      e.stopPropagation()
    }

    const handlePointerMove = (e: PointerEvent) => {
      const drag = marqueeDragRef.current
      if (!drag || drag.pointerId !== e.pointerId) return
      e.stopPropagation()
      const rect = canvasRootEl.getBoundingClientRect()
      const currentX = e.clientX - rect.left
      const currentY = e.clientY - rect.top
      const next = marqueeRectFromPoints(drag.startX, drag.startY, currentX, currentY)
      if (next.width < MARQUEE_DRAG_THRESHOLD_PX && next.height < MARQUEE_DRAG_THRESHOLD_PX) return

      setMarqueeRectBoth(next)
      const state = useEditorStore.getState()
      // A non-additive marquee REPLACES the selection, and that has to include
      // the node selection — `setSelectedFrameIds` only clears it when it
      // selects at least one frame, so a drag across genuinely empty board
      // ended with the previously selected node still ringed (`select-01`:
      // "a marquee that selects nothing must end at nothing selected").
      // Self-limiting: after the first clearing move the set is already empty.
      if (!drag.additive && state.selectedNodeIds.length > 0) state.clearSelection()
      const hits = framesInMarquee(drag.frames, next)
      const nextIds = drag.additive
        ? [...drag.baseSelection, ...hits.filter((id) => !drag.baseSelection.includes(id))]
        : hits
      state.setSelectedFrameIds(nextIds)
    }

    const handlePointerEnd = (e: PointerEvent) => {
      if (marqueeDragRef.current?.pointerId !== e.pointerId) return
      e.stopPropagation()
      if (marqueeRectRef.current) suppressNextClick = true
      marqueeDragRef.current = null
      setMarqueeRectBoth(null)
    }

    // The single native 'click' event generated after a completed
    // marquee-drag's mouseup — suppressed exactly once, so a later, genuine
    // background click still deselects normally.
    const handleClick = (e: MouseEvent) => {
      if (!suppressNextClick) return
      suppressNextClick = false
      e.stopPropagation()
    }

    canvasRootEl.addEventListener('pointerdown', handlePointerDown)
    canvasRootEl.addEventListener('pointermove', handlePointerMove)
    canvasRootEl.addEventListener('pointerup', handlePointerEnd)
    canvasRootEl.addEventListener('pointercancel', handlePointerEnd)
    canvasRootEl.addEventListener('click', handleClick)
    return () => {
      canvasRootEl.removeEventListener('pointerdown', handlePointerDown)
      canvasRootEl.removeEventListener('pointermove', handlePointerMove)
      canvasRootEl.removeEventListener('pointerup', handlePointerEnd)
      canvasRootEl.removeEventListener('pointercancel', handlePointerEnd)
      canvasRootEl.removeEventListener('click', handleClick)
    }
  }, [canvasRootRef, framesLayerRef, setMarqueeRectBoth])

  return marqueeRect
}
