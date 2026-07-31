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
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { useEditorStore } from '@site/store/store'
import { selectActiveBoard } from '@site/store/slices/boardSlice'
import type { Page } from '@core/page-tree'
import { isCanvasSpacePanActive } from '../canvasPanInput'
import { FRAME_WIDTH, FRAME_HEIGHT, FRAME_HEADER_HEIGHT } from './frameGrid'
import { framesInMarquee, marqueeRectFromPoints, type MarqueeFrame, type MarqueeRect } from './framesInMarquee'
import { resolveFramesWithPages } from './resolveFramesWithPages'

/** Marquee movement (screen px) before a drag counts as "selecting", so a plain click doesn't flash an empty marquee. */
const MARQUEE_DRAG_THRESHOLD_PX = 3

// Stable fallback reference — see BoardFramesLayer.tsx's own copy for why
// `?? []` inline is banned in a Zustand selector; this one is read via
// `useEditorStore.getState()` (not a selector hook) so the same reasoning
// doesn't strictly apply, but a fresh array per call is still wasteful churn
// this module doesn't need.
const EMPTY_PAGES: Page[] = []

/**
 * Wires the marquee gesture onto `canvasRootRef.current` and returns the
 * current screen-space marquee rect (`null` when no drag is in progress, or
 * before it has crossed the drag threshold). The caller (`BoardFramesLayer`)
 * portals this into the canvas root for rendering — see that component for
 * why the portal target has to be OUTSIDE the transformed `.layer`.
 */
export function useMarqueeSelection(
  canvasRootRef: RefObject<HTMLElement | null> | undefined,
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
      const board = selectActiveBoard(useEditorStore.getState())
      if (!board) return
      const rect = canvasRootEl.getBoundingClientRect()
      marqueeDragRef.current = {
        pointerId: e.pointerId,
        startX: e.clientX - rect.left,
        startY: e.clientY - rect.top,
        additive: e.shiftKey,
        baseSelection: useEditorStore.getState().selectedFrameIds,
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
      const board = selectActiveBoard(state)
      if (!board) return
      const pages = state.site?.pages ?? EMPTY_PAGES
      const marqueeFrames: MarqueeFrame[] = resolveFramesWithPages(board, pages).map(({ frame, page }) => ({
        pageId: page.id,
        x: frame.x,
        y: frame.y,
        width: frame.width ?? FRAME_WIDTH,
        height: (frame.height ?? FRAME_HEIGHT) + FRAME_HEADER_HEIGHT,
      }))
      const hits = framesInMarquee(marqueeFrames, next, { panX: state.panX, panY: state.panY, zoom: state.zoom })
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
  }, [canvasRootRef, setMarqueeRectBoth])

  return marqueeRect
}
