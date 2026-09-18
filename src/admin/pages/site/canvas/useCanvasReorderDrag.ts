/**
 * useCanvasReorderDrag — moving an element on the canvas, as ONE SESSION.
 *
 * ## The shape (S2 / D2's `dragSession`)
 *
 * `pointerdown` opens a session and measures everything the gesture will need
 * (`frameCandidateIndex`, `canvasDragSession.ts`). Every `pointermove` writes
 * a ref and asks for a rAF. ONE rAF resolves the drop target and paints the
 * indicator by direct DOM mutation (`canvasDragPainter.ts`). `pointerup`
 * writes the store ONCE.
 *
 * **Per `pointermove`: zero React commits and zero forced layout reads.** What
 * it replaced did two `getBoundingClientRect()` calls and one `setState` on
 * EVERY raw pointermove — and a raw pointermove stream from a trackpad or a
 * high-rate mouse runs several times per painted frame, so a gesture that
 * changes no layout was invalidating layout dozens of times a frame and
 * re-rendering the whole selection overlay with it.
 *
 * The gesture commits React exactly twice, at its two edges: `dragging` flips
 * on when the press stops being a click and off at release. That flag is
 * rendered from (the selection overlay's measurement scheduler keeps
 * measuring while a continuous gesture is in flight), which is why it is
 * state and not a ref — but nothing between the edges renders at all.
 *
 * The pattern is `useElementResizeDrag`'s, which already coalesced its writes
 * to one per animation frame; this hook adds the measurement half (the index)
 * because a reorder has to hit-test a whole page, not one element's width.
 *
 * Three things follow from "the store is written once":
 *
 *  - **Escape cancels.** The tree was never touched, so cancelling is just
 *    dropping the session. Listened for on the parent document AND on the
 *    frame's own document, because a keystroke raised inside an iframe does
 *    not reach the parent window (same two-document listener
 *    `useElementResizeDrag` attaches).
 *  - **Shift constrains the axis.** The pointer is projected onto whichever
 *    axis it has travelled further along, in client space, before the
 *    frame-space conversion — so the axis the user locked is the one they see.
 *  - **The ghost follows the cursor exactly**, because it is painted from the
 *    same pointer position the resolution used, in the same frame.
 *
 * ## Why the live transform, never the store's
 *
 * `transformRef` (D1) is the canvas's CURRENT pan/zoom. The store's
 * `zoom`/`panX`/`panY` are the ~100 ms-debounced COMMIT values `useCanvas.ts`
 * writes after a gesture settles, so during a drag with auto-pan they are
 * behind by design. The index compares against the live ref and re-measures
 * its origin only when the transform actually moved — see
 * `refreshFrameCandidateIndex`.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { lookupCanvasPageById, selectActiveCanvasPage, useEditorStore } from '@site/store/store'
import { measureBoardDropSurfaces } from './canvasDragBoard'
import { commitCanvasDrag } from './canvasDragCommit'
import {
  DRAG_ACTIVATE_PX,
  EMPTY_REFLOW,
  EMPTY_RESOLUTION,
  EMPTY_TRANSPLANT_RESOLUTION,
  dragLabel,
  resolveDraggedIds,
  runCanvasDragFrame,
  type DragSession,
} from './canvasDragFrame'
import { buildFrameCandidateIndex, type CanvasDragOrigin } from './canvasDragSession'
import { paintCanvasDrag } from './canvasDragPainter'
import { clearFreeMovePreview } from './canvasFreeMove'
import { beginCanvasGesture, endCanvasGesture } from './canvasGesture'
import { useCanvasBodyDragTrigger } from './useCanvasBodyDragTrigger'
import { clearCanvasPointerRelay, markCanvasPointerRelay } from './canvasPointerRelay'
import { resolvePortalDocument } from './frameAdapter/resolvePortalDocument'
import type { CanvasTransform } from './math'

interface UseCanvasReorderDragOptions {
  viewportRef: React.RefObject<HTMLElement | null>
  /**
   * Iframe that hosts the breakpoint's page tree. Drop-candidate measurement
   * queries the iframe's contentDocument for `[data-node-id]` and translates
   * each rect into editor coords.
   *
   * Cross-iframe pointer relay: the drag originates in the parent doc
   * (selection toolbar handle), but pointermove / up / cancel events
   * inside the iframe don't bubble to the parent window. This hook
   * tags the parent's `<html>` with `data-studio-canvas-dragging` while a
   * drag is in flight; each `IframeFrameSurface` reads that flag and
   * forwards its pointer events back to the parent so the window
   * listeners keep ticking even when the cursor is over a frame.
   */
  iframeElement: HTMLIFrameElement | null
  /**
   * The in-iframe overlay host (`CanvasSelectionOverlayInjector`'s root), or
   * `null`. Two jobs here:
   *
   *  1. It is the DESIGN-FRAME gate. The injector is design-mode only, so a
   *     live/prototype `IframeFrameSurface` never creates one — pressing an
   *     element in a live frame must behave exactly like the published page,
   *     never start an editor drag.
   *  2. It is the handle on the iframe's CURRENT document
   *     (`overlayRoot.ownerDocument`). A frame reload mints a new document and
   *     a new overlay root together, so keying the body-drag listener on this
   *     value re-attaches it to the right document automatically — where
   *     `iframeElement` alone stays referentially stable across the swap and
   *     would leave the listener bound to a dead document.
   */
  overlayRoot: HTMLElement | null
  selectedNodeIds: readonly string[]
  /** Frame that owns this overlay, for frame-scoped selection (`selectedNodeFrameId`). */
  frameId?: string | null
  /**
   * D2 G3 — the PAGE this frame renders, which is the file a drag out of it
   * would be moving markup from. `null`/absent on a surface with no page of
   * its own (a CMS breakpoint frame, a test harness): the board branch then
   * stays off entirely and the drag behaves exactly as it did before
   * cross-frame drops existed.
   */
  pageId?: string | null
  /** The selection toolbar's hand-grab handle is available (structural edit + a selection). */
  enabled: boolean
  /**
   * Pressing an element's own body may start a drag. Broader than `enabled`:
   * the toolbar only exists once something is selected, but press-and-drag has
   * to work on the first gesture, before anything is selected.
   */
  bodyDragEnabled: boolean
  panBy?: (dx: number, dy: number) => void
  canvasRootRef?: React.RefObject<HTMLElement | null>
  /**
   * D1's live canvas transform. Optional: a surface outside
   * `CanvasTransformLayer` (a live frame, a test harness) has none, and the
   * index simply stops watching for transform changes — see
   * `FrameCandidateIndex.transform`.
   */
  transformRef?: React.RefObject<CanvasTransform>
}

export function useCanvasReorderDrag({
  viewportRef,
  iframeElement,
  overlayRoot,
  selectedNodeIds,
  frameId = null,
  pageId = null,
  enabled,
  bodyDragEnabled,
  panBy,
  canvasRootRef,
  transformRef,
}: UseCanvasReorderDragOptions) {
  const sessionRef = useRef<DragSession | null>(null)
  const dropLayerRef = useRef<HTMLDivElement | null>(null)
  const frameRef = useRef<number | null>(null)
  const teardownRef = useRef<(() => void) | null>(null)
  const gestureTokenRef = useRef<symbol | null>(null)
  /**
   * The ONE piece of React state this gesture owns, and it flips exactly
   * twice: on at activation (the moment a press stops being a click), off at
   * release or cancel. Zero flips per `pointermove` — everything the drag
   * DRAWS is painted straight into the DOM by `canvasDragPainter`.
   *
   * It stays state rather than a ref because a consumer genuinely renders
   * from it: the selection overlay's measurement scheduler keeps measuring
   * while a continuous gesture is in flight (S4), and a ref would leave that
   * loop off for the whole drag.
   */
  const [dragging, setDragging] = useState(false)

  /**
   * The single rAF. `canvasDragFrame.ts` owns what it DOES — refresh, resolve
   * the frame under the pointer, resolve the drop, paint — and this owns the
   * three refs it needs from React plus the one store read a cross-frame drop
   * makes (the destination page's tree, on frame ENTRY only, never per move).
   */
  const runFrame = () => {
    frameRef.current = null
    const session = sessionRef.current
    const viewport = viewportRef.current
    if (!session || !viewport) return
    runCanvasDragFrame(session, {
      viewport,
      iframe: iframeElement,
      dropLayer: dropLayerRef.current,
      canvasRoot: canvasRootRef?.current ?? null,
      transform: transformRef?.current ?? null,
      ...(panBy ? { panBy } : {}),
      scheduleFrame: () => scheduleFrame(),
      readPage: (pageId) => {
        const site = useEditorStore.getState().site
        return site ? lookupCanvasPageById(site, pageId) : null
      },
    })
  }

  const scheduleFrame = () => {
    frameRef.current ??= requestAnimationFrame(runFrame)
  }

  // Exception #1: referenced in the `useEffect(() => resetDrag, [resetDrag])` dep array below.
  const resetDrag = useCallback(() => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }
    // K6 — drop the free-move preview BEFORE anything else: it is the SAME
    // DOM property the commit is about to write, so clearing it afterwards
    // would delete exactly what React just wrote (and React would not write it
    // again, the style prop not having changed from its point of view).
    const previewed = sessionRef.current?.free
    if (previewed?.ok) clearFreeMovePreview(previewed.plan)
    // D2 G3 — the chrome may be sitting in ANOTHER frame's layer (the pointer
    // was over a different screen when the gesture ended). Clear whichever one
    // was last painted as well as this frame's own, so nothing is ever left
    // behind in a frame the session no longer owns.
    const painted = sessionRef.current?.paintedLayer ?? null
    sessionRef.current = null
    if (painted && painted !== dropLayerRef.current) paintCanvasDrag(painted, null)
    paintCanvasDrag(dropLayerRef.current, null)
    teardownRef.current?.()
    teardownRef.current = null
    // Unfreeze the derived geometry this gesture held (auto-height refit, the
    // parent-doc anchor) and let the settle pass recompute ONCE — see
    // `canvasGesture.ts`. Ended before the commit, so the settle measures the
    // tree the move produced rather than the one it started from.
    if (gestureTokenRef.current) {
      endCanvasGesture(gestureTokenRef.current)
      gestureTokenRef.current = null
    }
    // Clear the cross-frame drag signal so iframes stop forwarding pointer
    // events. Mirrors the matching set in `beginDrag` below.
    clearCanvasPointerRelay()
    setDragging(false)
  }, [])

  // Pointer events forwarded from inside an iframe arrive on `window` with
  // the iframe-internal `pointerId`, which doesn't match the parent-doc
  // pointerId that started the drag. Rather than try to keep IDs in sync,
  // the session is treated as a singleton: there is only ever one canvas
  // reorder drag in flight at a time, so any pointermove during an active
  // session belongs to that drag.
  const handleWindowPointerMove = (event: PointerEvent) => {
    const session = sessionRef.current
    if (!session) return
    event.preventDefault()
    session.point = { x: event.clientX, y: event.clientY }
    session.axisLocked = event.shiftKey
    // K2 — read per event, not latched: release Alt and the drop is a move
    // again, press it and the same drop becomes a copy.
    session.duplicating = event.altKey
    // K6 — same treatment for ⌘/Ctrl: the gesture may change its mind between
    // "reorder this" and "place this".
    session.freeRequested = event.metaKey || event.ctrlKey

    // Hold the gesture as a click until it clears the activation distance.
    // Until then there is deliberately no drop target and no auto-pan, so a
    // pointerup here commits nothing (see DRAG_ACTIVATE_PX).
    if (!session.active) {
      const dx = event.clientX - session.origin.x
      const dy = event.clientY - session.origin.y
      if (Math.hypot(dx, dy) < DRAG_ACTIVATE_PX) return
      session.active = true
      // The single React commit of the whole gesture — see `dragging`.
      setDragging(true)
      // A body drag that started on an UNSELECTED element selects it now, at
      // the moment the gesture stops being a click — so the ring, the toolbar
      // and the inspector all follow what is actually moving. Frame-scoped
      // (`selectedNodeFrameId`) so a "duplicate as variant" sibling frame
      // sharing these node ids doesn't light up too. This is the ONE store
      // write a drag makes before `pointerup`, and it happens once.
      if (session.selectOnActivate) {
        useEditorStore.getState().selectNode(session.selectOnActivate, 'replace', {
          frameId: session.frameId,
        })
      }
    }

    scheduleFrame()
  }

  const handleWindowPointerUp = (event: PointerEvent) => {
    const session = sessionRef.current
    if (!session) return
    event.preventDefault()

    // A press that never cleared the activation distance is a click on the
    // handle, not a drag. Reset and move nothing.
    if (!session.active) {
      resetDrag()
      return
    }

    // A drag whose last pointermove and pointerup land inside ONE animation
    // frame (a flick) would otherwise commit the previous frame's target, or
    // nothing at all on a drag that never got a frame. Resolving the pending
    // frame synchronously here costs one measurement at the end of a gesture
    // and makes the commit always match the last position the user pointed at.
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current)
      runFrame()
    }

    // Everything the commit needs, captured BEFORE `resetDrag` drops the
    // session (and, for a free move, the preview with it).
    const commit = {
      draggedId: session.draggedId,
      resolution: session.resolution,
      free: session.free,
      freeStep: session.freeStep,
      // K2 — the modifier state at RELEASE decides, which is the only reading
      // that matches what the ghost was showing the instant before.
      duplicating: session.duplicating || event.altKey,
      // D2 G3 — the pointer was over a frame showing another page, and that
      // frame's own verdict said the drop may land.
      foreign:
        session.foreign && session.foreignResolution.target && session.originPageId
          ? {
              originPageId: session.originPageId,
              pageId: session.foreign.pageId,
              target: session.foreignResolution.target,
            }
          : null,
    }
    resetDrag()

    try {
      commitCanvasDrag(commit)
    } catch (err) {
      console.warn('[canvas-dnd] Ignored stale canvas drag target:', err)
    }
  }

  const handleWindowPointerCancel = () => {
    if (!sessionRef.current) return
    resetDrag()
  }

  /**
   * Escape abandons the gesture. Nothing to undo — the tree has not been
   * touched — so this is a plain reset. Bound to BOTH documents because a
   * keystroke raised inside the frame's iframe never reaches the parent
   * window; same two-document arrangement `useElementResizeDrag` uses.
   */
  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || !sessionRef.current) return
    event.preventDefault()
    event.stopPropagation()
    resetDrag()
  }

  /**
   * Open a session for `origin` and attach the listeners that run it.
   *
   * The single place a canvas reorder drag begins. Both entry points — the
   * selection toolbar's hand-grab handle (parent document) and a press on the
   * element's own body (inside the frame's iframe) — funnel through here, so
   * activation distance, candidate measurement, the cross-iframe relay flag and
   * the commit path cannot drift apart between the two gestures.
   *
   * `origin.clientX/clientY` are always PARENT-DOCUMENT client coordinates:
   * every subsequent pointermove reaches the window listeners in that space
   * (either natively, or translated by `IframeFrameSurface`'s relay), so an
   * origin measured in any other space would make the activation distance and
   * the first resolved drop target wrong by the iframe's offset.
   */
  const beginDrag = (origin: CanvasDragOrigin): boolean => {
    const viewport = viewportRef.current
    const state = useEditorStore.getState()
    const tree = selectActiveCanvasPage(state)
    if (!viewport || !tree) return false

    const draggedIds = resolveDraggedIds(tree, origin.candidateIds)
    const draggedId = origin.preferredDraggedId && draggedIds.includes(origin.preferredDraggedId)
      ? origin.preferredDraggedId
      : draggedIds[draggedIds.length - 1]

    if (!draggedId || draggedIds.length === 0) return false

    resetDrag()

    const point = { x: origin.clientX, y: origin.clientY }
    sessionRef.current = {
      draggedId,
      draggedIds,
      tree,
      // The one expensive measurement of the whole gesture (G6): every
      // `[data-node-id]` in the frame, translated into frame space, once.
      index: buildFrameCandidateIndex(viewport, tree, iframeElement, transformRef?.current ?? null),
      origin: point,
      point,
      axisLocked: false,
      duplicating: origin.altKey,
      freeRequested: origin.freeKey,
      freeStep: null,
      // Not a drag yet — `handleWindowPointerMove` promotes it once the pointer
      // clears DRAG_ACTIVATE_PX, so a press that stays put stays a click.
      active: false,
      selectOnActivate: origin.selectOnActivate,
      frameId: origin.frameId,
      // D2 G3 — the page the dragged markup is written in. Read from the
      // FRAME rather than from `activePageId`: a cross-frame drag activates
      // the destination frame on the way (`openPageInCanvas` fires from
      // `onPointerDownCapture`), so the active page is already the wrong end
      // of the gesture by the time it commits.
      originPageId: pageId,
      label: dragLabel(tree, draggedIds, draggedId),
      resolution: EMPTY_RESOLUTION,
      // Every mounted frame's client rect, measured once like the candidate
      // index above and refreshed on the same two signals — see
      // `canvasDragBoard.ts`.
      board: measureBoardDropSurfaces(transformRef?.current ?? null),
      foreign: null,
      foreignResolution: EMPTY_TRANSPLANT_RESOLUTION,
      paintedLayer: null,
      // K6 — no drop target has been resolved yet, so no sibling is making
      // room for one. Filled by the first frame that resolves one.
      reflow: EMPTY_REFLOW,
      reflowKey: '',
      reflowCandidates: null,
    } satisfies DragSession

    // Cross-frame drag signal. Every iframe's pointer relay (see
    // `IframeFrameSurface`) reads `data-studio-canvas-dragging` on the parent
    // document's `<html>` and forwards pointermove / up / cancel events to
    // the parent when set. We also stash the originating pointerId so the
    // relay can mint events with the matching id.
    markCanvasPointerRelay(origin.pointerId)

    // Freeze the derived geometry a page-mutating pointer gesture invalidates
    // (`canvasGesture.ts`): the frame's auto-height refit and the parent-doc
    // selection anchor. A reorder writes nothing until `pointerup`, so this is
    // not about the drag's OWN edits — it is about the two things that would
    // otherwise reflow the frame mid-gesture and invalidate the candidate
    // index measured above, from underneath a pointer the user has not moved.
    gestureTokenRef.current = beginCanvasGesture()

    const frameDoc = resolvePortalDocument(iframeElement)
    // A real reflow inside the frame (an image finishing, a font swapping, a
    // live-frame HMR patch) is the ONLY thing that invalidates the candidate
    // rects mid-gesture — the drag itself writes nothing until pointerup.
    // Observing the body rather than polling is what keeps the steady state
    // at zero measurements.
    let observer: ResizeObserver | null = null
    const frameBody = frameDoc?.body ?? null
    if (frameBody && typeof ResizeObserver === 'function') {
      observer = new ResizeObserver(() => {
        const session = sessionRef.current
        if (!session) return
        session.index.stale = true
        scheduleFrame()
      })
      observer.observe(frameBody)
    }

    window.addEventListener('pointermove', handleWindowPointerMove)
    window.addEventListener('pointerup', handleWindowPointerUp)
    window.addEventListener('pointercancel', handleWindowPointerCancel)
    window.addEventListener('keydown', handleKeyDown, true)
    frameDoc?.addEventListener('keydown', handleKeyDown, true)
    teardownRef.current = () => {
      observer?.disconnect()
      window.removeEventListener('pointermove', handleWindowPointerMove)
      window.removeEventListener('pointerup', handleWindowPointerUp)
      window.removeEventListener('pointercancel', handleWindowPointerCancel)
      window.removeEventListener('keydown', handleKeyDown, true)
      frameDoc?.removeEventListener('keydown', handleKeyDown, true)
    }
    return true
  }

  /** Entry point 1 — the selection toolbar's hand-grab handle, in the parent document. */
  const handlePointerDown = (event: React.PointerEvent<HTMLElement>) => {
    if (!enabled || event.button !== 0) return

    const state = useEditorStore.getState()
    const started = beginDrag({
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      candidateIds: selectedNodeIds,
      preferredDraggedId: state.selectedNodeId,
      selectOnActivate: null,
      frameId,
      altKey: event.altKey,
        freeKey: event.metaKey || event.ctrlKey,
    })
    if (!started) return

    event.preventDefault()
    event.stopPropagation()

    // Implicit pointer capture is unreliable for left-click mouse drags
    // across iframe boundaries. Calling setPointerCapture on the drag
    // handle keeps the parent-doc event stream alive while the cursor is
    // still inside the parent doc; once it enters an iframe, the iframe's
    // pointer relay (gated by the data attribute above) takes over.
    if (typeof event.currentTarget.setPointerCapture === 'function') {
      try {
        event.currentTarget.setPointerCapture(event.pointerId)
      } catch {
        // Some test envs / older browsers reject setPointerCapture; the
        // iframe relay path still works without it.
      }
    }
  }

  // Entry point 2 — a press on the element's OWN BODY, inside the frame's
  // iframe. Its own module because it owns a different question (does this
  // press mean a drag at all, or does the pan / an inline edit / a resize
  // handle own this pointer) and meets the session at exactly one call.
  useCanvasBodyDragTrigger({
    enabled: bodyDragEnabled,
    iframeElement,
    overlayRoot,
    frameId,
    beginDrag,
  })

  useEffect(() => resetDrag, [resetDrag])

  return {
    handlePointerDown,
    /** Handed to `CanvasDropIndicators`; the session paints through it. */
    dropLayerRef,
    /**
     * True from the moment a press clears the activation distance until
     * release, Escape or cancel. Flips exactly twice per gesture and never
     * per `pointermove` — the indicator, the refusal chip and the ghost are
     * all painted straight into the DOM, so there is nothing for a
     * per-move commit to render.
     */
    dragging,
  }
}
