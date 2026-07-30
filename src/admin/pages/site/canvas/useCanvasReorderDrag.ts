import { useCallback, useEffect, useRef, useState } from 'react'
import { registry } from '@core/module-engine'
import { selectActiveCanvasPage, useEditorStore } from '@site/store/store'
import type { CanvasDropResolution } from './canvasDnd'
import { resolveCanvasDropTarget } from './canvasDnd'
import {
  getViewportLocalPoint,
  measureCanvasDropCandidates,
} from './canvasDomGeometry'
import { clearCanvasPointerRelay, markCanvasPointerRelay } from './canvasPointerRelay'

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
   * tags the parent's `<html>` with `data-instatic-canvas-dragging` while a
   * drag is in flight; each `IframeFrameSurface` reads that flag and
   * forwards its pointer events back to the parent so the window
   * listeners keep ticking even when the cursor is over a frame.
   */
  iframeElement: HTMLIFrameElement | null
  selectedNodeIds: readonly string[]
  enabled: boolean
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
  selectedNodeIds,
  enabled,
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
    setResolution(resolveCanvasDropTarget({
      tree,
      draggedId: session.draggedId,
      draggedIds: session.draggedIds,
      candidates: session.candidates,
      point,
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

  const handlePointerDown = (event: React.PointerEvent<HTMLElement>) => {
    if (!enabled || event.button !== 0) return

    const viewport = viewportRef.current
    const state = useEditorStore.getState()
    const tree = selectActiveCanvasPage(state)
    if (!viewport || !tree) return

    const draggedIds = resolveDraggedIds(tree, selectedNodeIds)
    const draggedId = state.selectedNodeId && draggedIds.includes(state.selectedNodeId)
      ? state.selectedNodeId
      : draggedIds[draggedIds.length - 1]

    if (!draggedId || draggedIds.length === 0) return

    event.preventDefault()
    event.stopPropagation()
    resetDrag()

    // Implicit pointer capture is unreliable for left-click mouse drags
    // across iframe boundaries. Calling setPointerCapture on the drag
    // handle keeps the parent-doc event stream alive while the cursor is
    // still inside the parent doc; once it enters an iframe, the iframe's
    // pointer relay (gated by the data attribute below) takes over.
    if (typeof event.currentTarget.setPointerCapture === 'function') {
      try {
        event.currentTarget.setPointerCapture(event.pointerId)
      } catch {
        // Some test envs / older browsers reject setPointerCapture; the
        // iframe relay path still works without it.
      }
    }

    sessionRef.current = {
      pointerId: event.pointerId,
      draggedId,
      draggedIds,
      // Iframe-aware measurement: queries the iframe's contentDocument for
      // `[data-node-id]` and translates each rect into editor coords.
      candidates: measureCanvasDropCandidates(viewport, tree, iframeElement),
      originX: event.clientX,
      originY: event.clientY,
      // Not a drag yet — `handleWindowPointerMove` promotes it once the pointer
      // clears DRAG_ACTIVATE_PX, so a click on the handle stays a click.
      active: false,
    }
    latestClientPointRef.current = { x: event.clientX, y: event.clientY }

    // Cross-frame drag signal. Every iframe's pointer relay (see
    // `IframeFrameSurface`) reads `data-instatic-canvas-dragging` on the parent
    // document's `<html>` and forwards pointermove / up / cancel events to
    // the parent when set. We also stash the originating pointerId so the
    // relay can mint events with the matching id — keeps the eventual
    // window listeners' assumptions consistent.
    markCanvasPointerRelay(event.pointerId)

    window.addEventListener('pointermove', handleWindowPointerMove)
    window.addEventListener('pointerup', handleWindowPointerUp)
    window.addEventListener('pointercancel', handleWindowPointerCancel)
    removeWindowListenersRef.current = () => {
      window.removeEventListener('pointermove', handleWindowPointerMove)
      window.removeEventListener('pointerup', handleWindowPointerUp)
      window.removeEventListener('pointercancel', handleWindowPointerCancel)
    }
  }

  useEffect(() => resetDrag, [resetDrag])

  return {
    ...dragState,
    handlePointerDown,
  }
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
