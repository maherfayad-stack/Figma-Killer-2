/**
 * useCanvasLayerPointer — pressing, hovering and dragging loose layers on the
 * free canvas (P5-G, FC-5: G6 move, G8 place into a frame).
 *
 * ## The surface takes no input; the board does
 *
 * The free-canvas surface is one iframe under the whole viewport, and an iframe
 * swallows every pointer event over it — gaps between layers included, where a
 * marquee, a deselect or a space-pan must still start. Forwarding those out of
 * the iframe (design §4.4's "gap forwarding") would mean re-creating each board
 * gesture's own hit rules from outside. So the surface is `pointer-events:
 * none`, and this hook hit-tests the LAYERS geometrically from the board side:
 * a press on the canvas root that lands on a loose layer's box
 * (`canvasLayerGeometry.ts`) is claimed here, and every other press falls
 * through to the marquee and the pan exactly as before. There is nothing to
 * forward because nothing ever entered the iframe.
 *
 * Claimed in the CAPTURE phase with `stopImmediatePropagation`, so the marquee
 * (a native listener on the same element) and the pan (React handlers bubbling
 * to the app root) never see a press that picked up a layer. Space held, the
 * hand tool, or any button but the primary one: not claimed.
 *
 * ## One gesture, zero React commits while it moves
 *
 * `pointermove` writes a ref and asks for a rAF; the rAF moves the host inside
 * the surface and its ring on the board by writing the SAME custom properties
 * React renders (`--studio-layer-x/y`, `--ring-x/y`), so when the store commits
 * on release React writes the value that is already on screen and nothing
 * flashes. The only store write mid-gesture is the snap guides, which no-op
 * while the guide list is unchanged (`setBoardSnapGuides`).
 *
 * While a drag is live the surface is lifted above the frames
 * (`data-studio-lifted`), so the layer stays visible while it is aimed at one
 * (design §4.4). Over a frame, a single dragged layer resolves a drop exactly
 * as an OS image drop does, and the frame's own drag layer shows the line and
 * the verdict (`canvasLayerDropPreview.ts`). Release there PLACES it (⌥ copies);
 * release anywhere else MOVES it, as one board undo entry.
 *
 * ERR-12's guard ends a drag whose release was never heard; Escape abandons it
 * and puts every layer back.
 */
import { useEffect, type RefObject } from 'react'
import { guardDragSession } from '@core/studio-runtime'
import { canvasLayerPageId, layerPaintOrder, boardLayers } from '@core/studio-board'
import { lookupCanvasPageById, useEditorStore } from '@site/store/store'
import { selectActiveBoard } from '@site/store/slices/boardSelectors'
import { canvasLayerRootNodeId } from '@site/store/slices/canvasLayerGestures'
import { collectPeerRects, computeSnap, snapThresholdAtZoom, type SnapRect } from '../boardSnapping'
import { measureBoardDropSurfaces } from '../canvasDragBoard'
import { paintCanvasDrag } from '../canvasDragPainter'
import type { ClientPoint } from '../canvasDragSession'
import { isCanvasSpacePanActive } from '../canvasPanInput'
import type { CanvasTransform } from '../math'
import { canvasLayerAtPoint, canvasLayerRects, clientToBoardPoint, readBoardOrigin, type CanvasLayerRect } from './canvasLayerGeometry'
import { resolveCanvasLayerDrop, type CanvasLayerDropState, type CanvasLayerFrameTarget } from './canvasLayerDropPreview'
import { setHoveredCanvasLayer } from './canvasLayerHover'

/** Screen px a press travels before it is a drag — the element drag's own activation distance. */
const DRAG_ACTIVATE_PX = 4

interface LayerDragSession {
  pointerId: number
  origin: ClientPoint
  point: ClientPoint
  active: boolean
  copy: boolean
  /** Every layer moving (the selection), with its board position at the press. */
  starts: Map<string, { x: number; y: number }>
  /** Where each one is now — what a release commits. */
  current: Map<string, { x: number; y: number }>
  primary: CanvasLayerRect
  peers: SnapRect[]
  /** Frame-drop state — a single dragged layer only; several at once only move. */
  drop: CanvasLayerDropState | null
  target: CanvasLayerFrameTarget | null
  paintedLayer: HTMLElement | null
  frame: number | null
  disposeGuard: () => void
}

export interface CanvasLayerPointerOptions {
  /** Off without structural edit rights: nothing on the free canvas is pressed, moved or placed. */
  enabled: boolean
  canvasRootRef: RefObject<HTMLElement | null> | undefined
  transformRef: RefObject<CanvasTransform> | undefined
  /** The surface iframe's document — where the hosts are. `null` while it is not mounted. */
  surfaceDocumentRef: RefObject<Document | null>
  /** The surface's wrapper element in the board — lifted above the frames during a drag. */
  surfaceElementRef: RefObject<HTMLElement | null>
  /** An element at board (0, 0) inside the transform layer — how a client point becomes a board point. */
  boardOriginRef: RefObject<HTMLElement | null>
}

let gestureSerial = 0

export function useCanvasLayerPointer({
  enabled,
  canvasRootRef,
  transformRef,
  surfaceDocumentRef,
  surfaceElementRef,
  boardOriginRef,
}: CanvasLayerPointerOptions): void {
  useEffect(() => {
    const root = canvasRootRef?.current
    if (!root || !enabled) return
    let session: LayerDragSession | null = null
    let suppressClick = false

    const liveTransform = (): CanvasTransform => {
      const state = useEditorStore.getState()
      return transformRef?.current ?? { zoom: state.zoom, panX: state.panX, panY: state.panY }
    }

    const layerAt = (client: ClientPoint): CanvasLayerRect | null => {
      const state = useEditorStore.getState()
      const board = selectActiveBoard(state)
      if (!board) return null
      const layers = layerPaintOrder(boardLayers(board)).filter((layer) => canvasLayerPageId(layer.id) in state.canvasLayerPages)
      if (layers.length === 0) return null
      const locked = new Set(layers.filter((layer) => layer.locked).map((layer) => layer.id))
      const element = boardOriginRef.current
      if (!element) return null
      const origin = readBoardOrigin(element)
      return canvasLayerAtPoint(canvasLayerRects(layers), clientToBoardPoint(client, origin, origin.zoom), locked)
    }

    /** Write positions into the surface hosts and the board rings — the ONLY per-frame DOM writes. */
    const writePositions = (positions: ReadonlyMap<string, { x: number; y: number }>) => {
      const doc = surfaceDocumentRef.current
      for (const [id, at] of positions) {
        const host = doc?.querySelector<HTMLElement>(`[data-studio-layer-id="${id}"]`)
        host?.style.setProperty('--studio-layer-x', `${at.x}px`)
        host?.style.setProperty('--studio-layer-y', `${at.y}px`)
        const ring = root.querySelector<HTMLElement>(`[data-canvas-layer-ring="${id}"]`)
        ring?.style.setProperty('--ring-x', `${at.x}px`)
        ring?.style.setProperty('--ring-y', `${at.y}px`)
      }
    }

    const clearPaint = (drag: LayerDragSession) => {
      if (drag.paintedLayer) paintCanvasDrag(drag.paintedLayer, null)
      drag.paintedLayer = null
    }

    const endSession = () => {
      const drag = session
      session = null
      if (!drag) return
      if (drag.frame !== null) cancelAnimationFrame(drag.frame)
      drag.disposeGuard()
      clearPaint(drag)
      const lifted = surfaceElementRef.current
      if (lifted) delete lifted.dataset.studioLifted
      useEditorStore.getState().setBoardSnapGuides([])
      try {
        root.releasePointerCapture(drag.pointerId)
      } catch {
        // Already released (a lost release) — nothing to hand back.
      }
    }

    const runFrame = () => {
      const drag = session
      if (!drag) return
      drag.frame = null
      const transform = liveTransform()
      const zoom = transform.zoom > 0 ? transform.zoom : 1
      const dx = (drag.point.x - drag.origin.x) / zoom
      const dy = (drag.point.y - drag.origin.y) / zoom
      const snapped = computeSnap(
        { x: drag.primary.x + dx, y: drag.primary.y + dy, width: drag.primary.width, height: drag.primary.height },
        drag.peers,
        snapThresholdAtZoom(zoom),
      )
      const ox = snapped.x - (drag.primary.x + dx)
      const oy = snapped.y - (drag.primary.y + dy)

      // READ: which frame is under the pointer, and what a drop there means.
      let resolution = null
      if (drag.drop) {
        const state = useEditorStore.getState()
        const layerTree = state.canvasLayerPages[canvasLayerPageId(drag.primary.id)]
        const rootNodeId = layerTree ? canvasLayerRootNodeId(layerTree) : null
        if (layerTree && rootNodeId) {
          resolution = resolveCanvasLayerDrop(drag.drop, {
            point: drag.point,
            transform,
            readPage: (pageId) => (state.site ? lookupCanvasPageById(state.site, pageId) : null),
            layerTree,
            rootNodeId,
            copy: drag.copy,
          })
        }
      }

      // WRITE: positions, then the frame's drop chrome.
      for (const [id, start] of drag.starts) {
        drag.current.set(id, { x: Math.round(start.x + dx + ox), y: Math.round(start.y + dy + oy) })
      }
      writePositions(drag.current)
      useEditorStore.getState().setBoardSnapGuides(resolution?.layer ? [] : snapped.guides)
      if (drag.paintedLayer && drag.paintedLayer !== resolution?.layer) paintCanvasDrag(drag.paintedLayer, null)
      drag.paintedLayer = resolution?.layer ?? null
      if (resolution?.layer) paintCanvasDrag(resolution.layer, resolution.paint)
      drag.target = resolution?.target ?? null
    }

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || event.target !== root) return
      if (isCanvasSpacePanActive(document)) return
      const state = useEditorStore.getState()
      if (state.canvasTool !== 'move') return
      const hit = layerAt({ x: event.clientX, y: event.clientY })
      if (!hit) return
      event.stopImmediatePropagation()
      event.preventDefault()

      const selected = state.selectedCanvasLayerIds
      if (event.shiftKey) state.selectCanvasLayer(hit.id, 'toggle')
      else if (!selected.includes(hit.id)) state.selectCanvasLayer(hit.id, 'replace')
      const moving = useEditorStore.getState().selectedCanvasLayerIds
      if (!moving.includes(hit.id)) return // Shift-click just deselected it: a click, not a drag.

      const board = selectActiveBoard(useEditorStore.getState())
      const placements = board ? boardLayers(board) : []
      const starts = new Map<string, { x: number; y: number }>()
      for (const layer of placements) {
        if (moving.includes(layer.id) && !layer.locked) starts.set(layer.id, { x: layer.x, y: layer.y })
      }
      const others = canvasLayerRects(placements.filter((layer) => !starts.has(layer.id)))
      root.setPointerCapture(event.pointerId)
      const pointerId = event.pointerId
      session = {
        pointerId,
        origin: { x: event.clientX, y: event.clientY },
        point: { x: event.clientX, y: event.clientY },
        active: false,
        copy: event.altKey,
        starts,
        current: new Map(starts),
        primary: hit,
        peers: [...(board ? collectPeerRects(board, { kind: 'layer', id: hit.id }) : []), ...others],
        drop: null,
        target: null,
        paintedLayer: null,
        frame: null,
        disposeGuard: guardDragSession({
          documents: [document],
          focusWindow: window,
          onReleaseLost: (lost) => finish(lost),
          onAbandon: cancel,
        }),
      }
    }

    const onPointerMove = (event: PointerEvent) => {
      const drag = session
      if (!drag) {
        // Hover — only over the empty board itself, and only a change notifies.
        setHoveredCanvasLayer(event.target === root && event.buttons === 0 ? layerAt({ x: event.clientX, y: event.clientY })?.id ?? null : null)
        return
      }
      if (event.pointerId !== drag.pointerId) return
      event.stopImmediatePropagation()
      drag.point = { x: event.clientX, y: event.clientY }
      drag.copy = event.altKey
      if (!drag.active) {
        if (Math.hypot(drag.point.x - drag.origin.x, drag.point.y - drag.origin.y) < DRAG_ACTIVATE_PX) return
        drag.active = true
        setHoveredCanvasLayer(null)
        const lift = surfaceElementRef.current
        if (lift) lift.dataset.studioLifted = ''
        // A single layer can be placed into a frame; several only move.
        if (drag.starts.size === 1) {
          drag.drop = { board: measureBoardDropSurfaces(transformRef?.current ?? null), frame: null }
        }
      }
      drag.frame ??= requestAnimationFrame(runFrame)
    }

    const finish = (event: PointerEvent) => {
      const drag = session
      if (!drag) return
      if (!drag.active) {
        endSession()
        return
      }
      if (drag.frame !== null) {
        cancelAnimationFrame(drag.frame)
        drag.point = { x: event.clientX, y: event.clientY }
        runFrame()
      }
      const target = drag.target
      const copy = drag.copy || event.altKey
      const current = new Map(drag.current)
      const starts = drag.starts
      suppressClick = true
      endSession()

      const store = useEditorStore.getState()
      if (target && starts.size === 1) {
        // A copy leaves the layer where it was; a move takes it off the board.
        if (copy) writePositions(starts)
        store.placeCanvasLayer(drag.primary.id, { ...target, copy })
        return
      }
      store.moveCanvasLayers(current, `board:canvas-layer-move:${++gestureSerial}`)
      store.endBoardGesture()
    }

    const cancel = () => {
      const drag = session
      if (!drag) return
      writePositions(drag.starts)
      endSession()
    }

    const onPointerUp = (event: PointerEvent) => {
      if (session?.pointerId !== event.pointerId) return
      event.stopImmediatePropagation()
      finish(event)
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !session) return
      event.preventDefault()
      event.stopPropagation()
      cancel()
    }

    // The click a press on a layer ends with must not reach `CanvasRoot`'s
    // empty-board click, which would deselect what the press just selected.
    const onClick = (event: MouseEvent) => {
      if (!suppressClick && !(event.target === root && layerAt({ x: event.clientX, y: event.clientY }))) return
      suppressClick = false
      event.stopImmediatePropagation()
    }

    const onPointerLeave = () => setHoveredCanvasLayer(null)

    root.addEventListener('pointerdown', onPointerDown, true)
    root.addEventListener('pointermove', onPointerMove, true)
    root.addEventListener('pointerup', onPointerUp, true)
    root.addEventListener('pointercancel', cancel, true)
    root.addEventListener('click', onClick, true)
    root.addEventListener('pointerleave', onPointerLeave)
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      cancel()
      setHoveredCanvasLayer(null)
      root.removeEventListener('pointerdown', onPointerDown, true)
      root.removeEventListener('pointermove', onPointerMove, true)
      root.removeEventListener('pointerup', onPointerUp, true)
      root.removeEventListener('pointercancel', cancel, true)
      root.removeEventListener('click', onClick, true)
      root.removeEventListener('pointerleave', onPointerLeave)
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [enabled, canvasRootRef, transformRef, surfaceDocumentRef, surfaceElementRef, boardOriginRef])
}
