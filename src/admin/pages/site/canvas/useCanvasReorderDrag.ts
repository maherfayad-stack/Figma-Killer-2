import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react'
import { registry } from '@core/module-engine'
import { selectActiveCanvasPage, useEditorStore } from '@site/store/store'
import type { CanvasDropResolution } from './canvasDnd'
import { resolveCanvasDropTarget } from './canvasDnd'
import {
  getViewportLocalPoint,
  getViewportZoom,
  measureCanvasDropCandidates,
} from './canvasDomGeometry'
import { clearCanvasPointerRelay, markCanvasPointerRelay } from './canvasPointerRelay'
import {
  CANVAS_EDITOR_CONTROL_SELECTOR,
  CANVAS_NODE_SELECTOR,
  isElementLike,
} from './canvasEventTargets'
import { iframeLocalPointToParentClientPoint } from './iframeEventCoordinates'
import { isCanvasSpacePanActive, shouldStartCanvasPointerPan } from './canvasPanInput'

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
}

interface DragSession {
  pointerId: number
  draggedId: string
  draggedIds: string[]
  candidates: ReturnType<typeof measureCanvasDropCandidates>
  /** Where the pointer went down — the origin the activation threshold measures from. */
  originX: number
  originY: number
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
}

interface CanvasReorderDragState extends CanvasDropResolution {
  dragging: boolean
}

const EMPTY_DRAG_STATE: CanvasReorderDragState = {
  dragging: false,
  target: null,
  invalid: null,
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
}: UseCanvasReorderDragOptions) {
  const sessionRef = useRef<DragSession | null>(null)
  const latestResolutionRef = useRef<CanvasDropResolution>({ target: null, invalid: null })
  const latestClientPointRef = useRef<{ x: number; y: number } | null>(null)
  const autoPanFrameRef = useRef<number | null>(null)
  const runAutoPanRef = useRef<() => void>(() => {})
  const removeWindowListenersRef = useRef<(() => void) | null>(null)
  const [dragState, setDragState] = useState<CanvasReorderDragState>(EMPTY_DRAG_STATE)

  // Exception #1: closure of `resetDrag`, which feeds the `useEffect` dep array.
  const stopAutoPan = useCallback(() => {
    if (autoPanFrameRef.current !== null) {
      cancelAnimationFrame(autoPanFrameRef.current)
      autoPanFrameRef.current = null
    }
  }, [])

  // Exception #1: closure of `runAutoPan`, which feeds the `useEffect` dep array.
  const queueAutoPanFrame = useCallback(() => {
    autoPanFrameRef.current = requestAnimationFrame(() => runAutoPanRef.current())
  }, [])

  // Exception #1: closure of `resolveAtClientPoint` -> `runAutoPan`, which feeds the `useEffect` dep array.
  const setResolution = useCallback((resolution: CanvasDropResolution) => {
    latestResolutionRef.current = resolution
    setDragState({
      // A session that has not cleared the activation distance is still a click.
      dragging: sessionRef.current?.active === true,
      target: resolution.target,
      invalid: resolution.invalid,
    })
  }, [])

  // Exception #1: closure of `runAutoPan`, which feeds the `useEffect` dep array.
  const resolveAtClientPoint = useCallback((clientX: number, clientY: number) => {
    const session = sessionRef.current
    const viewport = viewportRef.current
    const tree = selectActiveCanvasPage(useEditorStore.getState())
    if (!session || !viewport || !tree) {
      setResolution({ target: null, invalid: null })
      return
    }

    const point = getViewportLocalPoint(viewport, clientX, clientY)
    // Screen-space edge bands (`getCanvasDropZone`) must be converted into
    // the frame-space units `point` / `session.candidates` are measured in —
    // see `MIN_EDGE_HIT_ZONE_SCREEN_PX` in `canvasDnd.ts`.
    const zoom = getViewportZoom(viewport)
    setResolution(resolveCanvasDropTarget({
      tree,
      draggedId: session.draggedId,
      draggedIds: session.draggedIds,
      candidates: session.candidates,
      point,
      zoom,
      canHaveChildren,
    }))
  }, [setResolution, viewportRef])

  // Exception #1: referenced in the `useEffect` dep array below (syncs `runAutoPanRef`).
  const runAutoPan = useCallback(() => {
    autoPanFrameRef.current = null
    const root = canvasRootRef?.current
    const point = latestClientPointRef.current
    // `active` guard: a press that has not become a drag must not pan the canvas.
    if (!root || !point || !panBy || sessionRef.current?.active !== true) return

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

    if (dx !== 0 || dy !== 0) {
      panBy(dx, dy)
      resolveAtClientPoint(point.x, point.y)
      queueAutoPanFrame()
    }
  }, [canvasRootRef, panBy, queueAutoPanFrame, resolveAtClientPoint])

  useEffect(() => {
    runAutoPanRef.current = runAutoPan
  }, [runAutoPan])

  const scheduleAutoPan = (clientX: number, clientY: number) => {
    latestClientPointRef.current = { x: clientX, y: clientY }
    if (autoPanFrameRef.current === null) {
      queueAutoPanFrame()
    }
  }

  // Exception #1: referenced in the `useEffect(() => resetDrag, [resetDrag])` dep array below.
  const resetDrag = useCallback(() => {
    stopAutoPan()
    sessionRef.current = null
    latestClientPointRef.current = null
    latestResolutionRef.current = { target: null, invalid: null }
    removeWindowListenersRef.current?.()
    removeWindowListenersRef.current = null
    // Clear the cross-frame drag signal so iframes stop forwarding pointer
    // events. Mirrors the matching set in `handlePointerDown` below.
    clearCanvasPointerRelay()
    setDragState(EMPTY_DRAG_STATE)
  }, [stopAutoPan])

  // Pointer events forwarded from inside an iframe arrive on `window` with
  // the iframe-internal `pointerId`, which doesn't match the parent-doc
  // pointerId that started the drag. Rather than try to keep IDs in sync,
  // the session is treated as a singleton: there is only ever one canvas
  // reorder drag in flight at a time, so any pointermove during an active
  // session belongs to that drag. We also keep a "preferred" pointerId
  // (the one from the original pointerdown) and prefer events matching it
  // when both an iframe-forwarded event and an outside-iframe event race —
  // but we don't filter out the others, because once the cursor is over an
  // iframe the outside-iframe stream goes silent entirely.
  const handleWindowPointerMove = (event: PointerEvent) => {
    const session = sessionRef.current
    if (!session) return
    event.preventDefault()
    latestClientPointRef.current = { x: event.clientX, y: event.clientY }

    // Hold the gesture as a click until it clears the activation distance. Until
    // then there is deliberately no drop target and no auto-pan, so a pointerup
    // here commits nothing (see DRAG_ACTIVATE_PX).
    if (!session.active) {
      const dx = event.clientX - session.originX
      const dy = event.clientY - session.originY
      if (Math.hypot(dx, dy) < DRAG_ACTIVATE_PX) return
      session.active = true
      // A body drag that started on an UNSELECTED element selects it now, at
      // the moment the gesture stops being a click — so the ring, the toolbar
      // and the inspector all follow what is actually moving. Frame-scoped
      // (`selectedNodeFrameId`) so a "duplicate as variant" sibling frame
      // sharing these node ids doesn't light up too.
      if (session.selectOnActivate) {
        useEditorStore.getState().selectNode(session.selectOnActivate, 'replace', {
          frameId: session.frameId,
        })
      }
      setDragState({ dragging: true, target: null, invalid: null })
    }

    resolveAtClientPoint(event.clientX, event.clientY)
    scheduleAutoPan(event.clientX, event.clientY)
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

    const target = latestResolutionRef.current.target
    resetDrag()

    if (!target) return
    try {
      useEditorStore.getState().moveNodes(target.draggedIds, target.parentId, target.index)
    } catch (err) {
      console.warn('[canvas-dnd] Ignored stale canvas drag target:', err)
    }
  }

  const handleWindowPointerCancel = () => {
    const session = sessionRef.current
    if (!session) return
    resetDrag()
  }

  /**
   * Open a session for `origin` and attach the window listeners that run it.
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

    sessionRef.current = {
      pointerId: origin.pointerId,
      draggedId,
      draggedIds,
      // Iframe-aware measurement: queries the iframe's contentDocument for
      // `[data-node-id]` and translates each rect into editor coords.
      candidates: measureCanvasDropCandidates(viewport, tree, iframeElement),
      originX: origin.clientX,
      originY: origin.clientY,
      // Not a drag yet — `handleWindowPointerMove` promotes it once the pointer
      // clears DRAG_ACTIVATE_PX, so a press that stays put stays a click.
      active: false,
      selectOnActivate: origin.selectOnActivate,
      frameId: origin.frameId,
    }
    latestClientPointRef.current = { x: origin.clientX, y: origin.clientY }

    // Cross-frame drag signal. Every iframe's pointer relay (see
    // `IframeFrameSurface`) reads `data-studio-canvas-dragging` on the parent
    // document's `<html>` and forwards pointermove / up / cancel events to
    // the parent when set. We also stash the originating pointerId so the
    // relay can mint events with the matching id — keeps the eventual
    // window listeners' assumptions consistent.
    markCanvasPointerRelay(origin.pointerId)

    window.addEventListener('pointermove', handleWindowPointerMove)
    window.addEventListener('pointerup', handleWindowPointerUp)
    window.addEventListener('pointercancel', handleWindowPointerCancel)
    removeWindowListenersRef.current = () => {
      window.removeEventListener('pointermove', handleWindowPointerMove)
      window.removeEventListener('pointerup', handleWindowPointerUp)
      window.removeEventListener('pointercancel', handleWindowPointerCancel)
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
    ...dragState,
    handlePointerDown,
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
  tree: NonNullable<ReturnType<typeof selectActiveCanvasPage>>,
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

function canHaveChildren(moduleId: string): boolean {
  return registry.get(moduleId)?.canHaveChildren === true
}

function autoPanSpeed(distanceFromEdge: number): number {
  const ratio = 1 - Math.max(0, Math.min(AUTO_PAN_EDGE_PX, distanceFromEdge)) / AUTO_PAN_EDGE_PX
  return Math.max(1, Math.ceil(ratio * AUTO_PAN_MAX_SPEED))
}
