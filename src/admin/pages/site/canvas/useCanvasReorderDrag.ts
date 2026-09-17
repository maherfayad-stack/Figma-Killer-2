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
 * Between `pointerdown` and `pointerup` there is **no React commit and no
 * forced layout read**. What it replaced did two `getBoundingClientRect()`
 * calls and one `setState` per RAW pointermove — and a raw pointermove stream
 * from a trackpad or a high-rate mouse runs several times per painted frame,
 * so a gesture that changes no layout was invalidating layout dozens of times
 * a frame and re-rendering the whole selection overlay with it.
 *
 * The pattern is `useElementResizeDrag`'s, which already coalesced its writes
 * to one per animation frame for exactly this reason; this hook adds the
 * measurement half (the index) because a reorder has to hit-test a whole page,
 * not just push one element's width.
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
import { useCallback, useEffect, useEffectEvent, useRef } from 'react'
import { registry } from '@core/module-engine'
import { getNodeDisplayName } from '@core/page-tree'
import type { NodeTree, PageNode } from '@core/page-tree'
import { selectActiveCanvasPage, useEditorStore } from '@site/store/store'
import type { CanvasDropResolution } from './canvasDnd'
import { resolveCanvasDropTarget } from './canvasDnd'
import {
  buildFrameCandidateIndex,
  constrainToDragAxis,
  indexLocalPoint,
  refreshFrameCandidateIndex,
  type ClientPoint,
  type FrameCandidateIndex,
} from './canvasDragSession'
import { paintCanvasDrag } from './canvasDragPainter'
import { clearCanvasPointerRelay, markCanvasPointerRelay } from './canvasPointerRelay'
import {
  CANVAS_EDITOR_CONTROL_SELECTOR,
  CANVAS_NODE_SELECTOR,
  isElementLike,
} from './canvasEventTargets'
import { iframeLocalPointToParentClientPoint } from './iframeEventCoordinates'
import { isCanvasSpacePanActive, shouldStartCanvasPointerPan } from './canvasPanInput'
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

interface DragSession {
  draggedId: string
  draggedIds: string[]
  /**
   * The page tree as it was when the gesture opened. Captured, not re-read
   * per move: a reorder drag writes nothing until `pointerup`, so the tree
   * cannot change under it — and the COMMIT re-reads the live store anyway
   * (`moveNodes` resolves its own plan), so a mid-drag resync can only cost a
   * stale PREVIEW, never a wrong write.
   */
  tree: NodeTree<PageNode>
  /** Measured once; refreshed only on a real reflow or a real transform change. */
  index: FrameCandidateIndex
  /** Where the pointer went down — the origin the activation threshold measures from. */
  origin: ClientPoint
  /** Latest pointer position, in PARENT-document client coordinates. */
  point: ClientPoint
  /** Shift was held at the last pointer event — constrain to one axis. */
  axisLocked: boolean
  /**
   * False until the pointer has travelled `DRAG_ACTIVATE_PX` from the origin.
   * While false the session resolves no drop target, runs no auto-pan, and
   * commits no move on pointerup — see `DRAG_ACTIVATE_PX`.
   */
  active: boolean
  /**
   * Node to select when the gesture becomes a real drag, or `null`.
   *
   * Set only by the body-drag path, and only when the pressed element was NOT
   * already part of the selection. Selecting on POINTERDOWN would make a press
   * that turns out to be a click select twice (once here, once from
   * `NodeRenderer`'s click) and would fight Cmd/Shift-click's modifier
   * semantics; selecting on ACTIVATION leaves the click path untouched and
   * still puts the ring on what the user is dragging.
   */
  selectOnActivate: string | null
  /** Frame the drag started in, so the activation selection stays frame-scoped. */
  frameId: string | null
  /** What the ghost says — resolved once, from the tree captured above. */
  label: string
  /** The last resolution painted, and what `pointerup` commits. */
  resolution: CanvasDropResolution
}

const AUTO_PAN_EDGE_PX = 48
const AUTO_PAN_MAX_SPEED = 18

/**
 * How far the pointer must travel before a press on the drag handle becomes a
 * drag. Below this the gesture is a click and commits nothing.
 *
 * Without a threshold the session went live on pointerdown, so a plain click on
 * the handle was a completed zero-distance drag: a couple of pixels of hand
 * jitter is enough for one `pointermove` to resolve a drop target, and pointerup
 * then committed `moveNodes` to it. The selected element reparented itself under
 * a click the user meant as a click — it appeared to jump away on its own.
 *
 * 4px is the usual activation distance for this gesture (`@dnd-kit`'s
 * `activationConstraint: { distance: … }`, which the DOM-panel tree uses); it is
 * under the ~5px of travel a deliberate drag covers in its first frames and over
 * anything a click produces.
 */
const DRAG_ACTIVATE_PX = 4

const EMPTY_RESOLUTION: CanvasDropResolution = { target: null, invalid: null }

export function useCanvasReorderDrag({
  viewportRef,
  iframeElement,
  overlayRoot,
  selectedNodeIds,
  frameId = null,
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

  /**
   * The single rAF. It runs the WHOLE visual half of the gesture — refresh,
   * resolve, auto-pan, paint — and re-arms itself only while auto-pan is
   * still moving the canvas, so a stationary pointer costs nothing.
   *
   * READ phase then WRITE phase, never interleaved: `refreshFrameCandidateIndex`
   * is the only thing here that can touch layout, and it runs before the first
   * style write.
   */
  const runFrame = () => {
    frameRef.current = null
    const session = sessionRef.current
    const viewport = viewportRef.current
    if (!session || !viewport) return

    // ── READ ────────────────────────────────────────────────────────────
    refreshFrameCandidateIndex(
      session.index,
      viewport,
      session.tree,
      iframeElement,
      transformRef?.current ?? null,
    )
    const screenPoint = session.axisLocked
      ? constrainToDragAxis(session.origin, session.point)
      : session.point
    const point = indexLocalPoint(session.index, screenPoint)

    session.resolution = resolveCanvasDropTarget({
      tree: session.tree,
      draggedId: session.draggedId,
      draggedIds: session.draggedIds,
      candidates: session.index.candidates,
      point,
      zoom: session.index.scale,
      canHaveChildren,
    })

    const pan = autoPanDelta(canvasRootRef?.current ?? null, screenPoint)

    // ── WRITE ───────────────────────────────────────────────────────────
    paintCanvasDrag(dropLayerRef.current, {
      ...session.resolution,
      ghost: { point, label: session.label },
    })

    if (pan && panBy) {
      panBy(pan.dx, pan.dy)
      // The layer moved under a stationary pointer, so the next frame must
      // re-resolve even if no pointermove arrives. `refreshFrameCandidateIndex`
      // picks the new origin up from `transformRef` on its own.
      scheduleFrame()
    }
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
    sessionRef.current = null
    paintCanvasDrag(dropLayerRef.current, null)
    teardownRef.current?.()
    teardownRef.current = null
    // Clear the cross-frame drag signal so iframes stop forwarding pointer
    // events. Mirrors the matching set in `beginDrag` below.
    clearCanvasPointerRelay()
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

    // Hold the gesture as a click until it clears the activation distance.
    // Until then there is deliberately no drop target and no auto-pan, so a
    // pointerup here commits nothing (see DRAG_ACTIVATE_PX).
    if (!session.active) {
      const dx = event.clientX - session.origin.x
      const dy = event.clientY - session.origin.y
      if (Math.hypot(dx, dy) < DRAG_ACTIVATE_PX) return
      session.active = true
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

    const target = session.resolution.target
    resetDrag()

    if (!target) return
    try {
      useEditorStore.getState().moveNodes(target.draggedIds, target.parentId, target.index)
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
  const beginDrag = (origin: DragOrigin): boolean => {
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
      // Not a drag yet — `handleWindowPointerMove` promotes it once the pointer
      // clears DRAG_ACTIVATE_PX, so a press that stays put stays a click.
      active: false,
      selectOnActivate: origin.selectOnActivate,
      frameId: origin.frameId,
      label: dragLabel(tree, draggedIds, draggedId),
      resolution: EMPTY_RESOLUTION,
    }

    // Cross-frame drag signal. Every iframe's pointer relay (see
    // `IframeFrameSurface`) reads `data-studio-canvas-dragging` on the parent
    // document's `<html>` and forwards pointermove / up / cancel events to
    // the parent when set. We also stash the originating pointerId so the
    // relay can mint events with the matching id.
    markCanvasPointerRelay(origin.pointerId)

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

  // Reads the latest render closure (`beginDrag` -> `selectedNodeIds`,
  // `iframeElement`, `frameId`) without becoming a dependency of the effect
  // below — the listener must be attached once per iframe document, not
  // re-attached on every selection change.
  const beginBodyDrag = useEffectEvent((origin: DragOrigin) => beginDrag(origin))

  /**
   * Entry point 2 — pressing the element's OWN BODY inside the frame's iframe.
   *
   * Until this existed, the only way to move an element on the canvas was the
   * selection toolbar's hand-grab icon: pressing the element and moving did
   * nothing at all, which is the opposite of what every design tool does and
   * what the user reported.
   *
   * A NATIVE capture-phase listener on the iframe's own document, not a React
   * handler on the node:
   *
   *  - it must run BEFORE `NodeRenderer`'s `onPointerDownCapture` (which
   *    focuses the node and latches authored form-control suppression), and a
   *    document-level capture listener in the iframe is the only position that
   *    is guaranteed to;
   *  - it must see presses on EVERY node, and `NodeRenderer` would need the
   *    handler threaded through a context into every module's prop bag —
   *    per-node work for a gesture that is global by nature (one pointer, one
   *    drag);
   *  - no wrapper element is introduced, which is the canvas's first rule.
   *
   * Deliberately NOT deps-keyed on `selectedNodeIds`: the selection is read
   * fresh from the store inside the handler, so the listener is attached once
   * per iframe document instead of re-attached on every selection change.
   */
  useEffect(() => {
    if (!bodyDragEnabled) return
    const iframe = iframeElement
    const doc = overlayRoot?.ownerDocument ?? null
    if (!iframe || !doc) return

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || event.defaultPrevented) return
      // Space + left-drag and middle-drag are the canvas's PAN gesture on the
      // same button. `IframeFrameSurface`'s relay claims those; starting a
      // reorder here would make one gesture mean two things.
      if (shouldStartCanvasPointerPan(event, { spaceHeld: isCanvasSpacePanActive(document) })) return

      const state = useEditorStore.getState()
      // An inline text edit owns the pointer inside its contentEditable: a
      // press-and-drag there is selecting text, not moving the element. Same
      // stand-down the keyboard bridge makes for the same reason.
      if (state.activeInlineEdit) return

      const target = event.target
      if (!isElementLike(target)) return
      // Editor chrome portaled into this SAME document (WS-5.1). The overlay
      // root is `pointer-events: none`, so in practice only the resize handles
      // inside it are pressable — and a resize is `useElementResizeDrag`'s
      // gesture, not this one. Matched on the overlay root rather than the
      // handle so anything else that opts back into pointer events later is
      // excluded by default.
      if (target.closest(CANVAS_EDITOR_CONTROL_SELECTOR)) return
      if (target.closest('[data-studio-canvas-overlay-root]')) return
      // Any authored contentEditable region: the caret is the user's target.
      if (target.closest('[contenteditable]')) return

      const nodeElement = target.closest(CANVAS_NODE_SELECTOR)
      const nodeId = nodeElement?.getAttribute('data-node-id')
      if (!nodeId) return

      // Pressing INSIDE the current selection drags the whole selection —
      // otherwise a multi-select would silently collapse to one node the
      // moment you tried to move it. Pressing outside it drags just that node.
      const selected = state.selectedNodeIds
      const inSelection = selected.includes(nodeId)

      const rect = iframe.getBoundingClientRect()
      const point = iframeLocalPointToParentClientPoint(
        rect,
        { width: iframe.clientWidth, height: iframe.clientHeight },
        { x: event.clientX, y: event.clientY },
      )

      const started = beginBodyDrag({
        pointerId: event.pointerId,
        clientX: point.x,
        clientY: point.y,
        candidateIds: inSelection ? selected : [nodeId],
        preferredDraggedId: nodeId,
        selectOnActivate: inSelection ? null : nodeId,
        frameId,
      })
      if (!started) return

      // Cancel the browser's default press behaviour — text selection and the
      // native image/link drag — both of which fight a pointer drag for the
      // same gesture. Canceling `pointerdown` suppresses the compatibility
      // MOUSE events only; `click` still fires, so `NodeRenderer`'s
      // click-to-select is untouched and a press that never becomes a drag is
      // still an ordinary click. Focus is not lost either: `NodeRenderer`'s
      // `onPointerDownCapture` focuses the node explicitly
      // (`focusNodeWithoutScrolling`) rather than relying on the default.
      event.preventDefault()
    }

    doc.addEventListener('pointerdown', onPointerDown, true)
    return () => doc.removeEventListener('pointerdown', onPointerDown, true)
  }, [bodyDragEnabled, iframeElement, overlayRoot, frameId])

  useEffect(() => resetDrag, [resetDrag])

  return {
    handlePointerDown,
    /** Handed to `CanvasDropIndicators`; the session paints through it. */
    dropLayerRef,
    /**
     * Whether a real (past-threshold) drag is in flight, READ AT CALL TIME.
     *
     * A getter, not state, and that is the point of S2: flipping a `useState`
     * here would re-render the whole selection overlay in the middle of a
     * gesture whose entire visual output is written straight to the DOM. No
     * production surface renders from this — everything a drag changes on
     * screen is painted by `canvasDragPainter` — so there is nothing to
     * re-render for. It is the session's observable, for tests and for any
     * future caller that needs to ask rather than subscribe.
     */
    get dragging(): boolean {
      return sessionRef.current?.active === true
    },
  }
}

/** Everything `beginDrag` needs, in whichever coordinate space it was captured. */
interface DragOrigin {
  pointerId: number
  /** PARENT-document client coordinates — see `beginDrag`. */
  clientX: number
  clientY: number
  /** Node ids this gesture proposes to move, before locked/root filtering. */
  candidateIds: readonly string[]
  /** The one of `candidateIds` the gesture is "about", when it has an opinion. */
  preferredDraggedId: string | null
  selectOnActivate: string | null
  frameId: string | null
}

function resolveDraggedIds(
  tree: NodeTree<PageNode>,
  selectedNodeIds: readonly string[],
): string[] {
  const result: string[] = []
  for (const id of selectedNodeIds) {
    const node = tree.nodes[id]
    if (!node) return []
    if (id === tree.rootNodeId) return []
    if (node.locked) return []
    result.push(id)
  }
  return result
}

/**
 * What the ghost says: the node's own display name, or how many are moving.
 *
 * Visual components are passed `undefined` deliberately — a
 * `base.visual-component-ref` falls back to its module name, which is the
 * right level of detail for a label that exists for half a second, and
 * reading the VC list would mean a second store read per gesture for it.
 */
function dragLabel(tree: NodeTree<PageNode>, draggedIds: string[], draggedId: string): string {
  if (draggedIds.length > 1) return `${draggedIds.length} layers`
  const node = tree.nodes[draggedId]
  return node ? getNodeDisplayName(node, registry.get(node.moduleId), undefined) : 'Layer'
}

function canHaveChildren(moduleId: string): boolean {
  return registry.get(moduleId)?.canHaveChildren === true
}

/**
 * How far to nudge the canvas this frame because the pointer is in an edge
 * band, or `null` when it is not. Pure apart from the one
 * `getBoundingClientRect()` on the canvas ROOT — which is a stable,
 * untransformed element, so this read costs no layout invalidation of the
 * frames themselves.
 */
function autoPanDelta(
  root: HTMLElement | null,
  point: ClientPoint,
): { dx: number; dy: number } | null {
  if (!root) return null
  const rect = root.getBoundingClientRect()
  const leftDistance = point.x - rect.left
  const rightDistance = rect.right - point.x
  const topDistance = point.y - rect.top
  const bottomDistance = rect.bottom - point.y

  let dx = 0
  let dy = 0

  if (leftDistance >= 0 && leftDistance < AUTO_PAN_EDGE_PX) {
    dx = autoPanSpeed(leftDistance)
  } else if (rightDistance >= 0 && rightDistance < AUTO_PAN_EDGE_PX) {
    dx = -autoPanSpeed(rightDistance)
  }

  if (topDistance >= 0 && topDistance < AUTO_PAN_EDGE_PX) {
    dy = autoPanSpeed(topDistance)
  } else if (bottomDistance >= 0 && bottomDistance < AUTO_PAN_EDGE_PX) {
    dy = -autoPanSpeed(bottomDistance)
  }

  return dx === 0 && dy === 0 ? null : { dx, dy }
}

function autoPanSpeed(distanceFromEdge: number): number {
  const ratio = 1 - Math.max(0, Math.min(AUTO_PAN_EDGE_PX, distanceFromEdge)) / AUTO_PAN_EDGE_PX
  return Math.max(1, Math.ceil(ratio * AUTO_PAN_MAX_SPEED))
}
