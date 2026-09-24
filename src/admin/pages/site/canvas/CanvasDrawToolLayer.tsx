/**
 * CanvasDrawToolLayer — the surface an armed draw tool draws on (P5-E,
 * IX-12, OD-5). Mounted by `CanvasRoot` only while R / O / T / F is armed.
 *
 * It is parent-document chrome, not canvas DOM: a click-catching layer over
 * the whole canvas, BELOW the rulers and the notch, ABOVE the frames. That is
 * what lets one gesture work the same over a portal frame and a live bridge
 * frame — neither frame's document sees the press, so neither selects,
 * reorders or edits anything — and it adds no box to any page (the rule this
 * canvas lives by). Everything it shows is resolved the way an insertion drag
 * resolves it: `findCanvasViewportAtPoint` + the per-gesture candidate
 * snapshot + `resolveCanvasPointerInsertionDrop`, so "where the line says it
 * will land" and "where it lands" are one computation.
 *
 * The pointer stays in the editor document for the whole gesture (pointer
 * capture on this layer), so it needs no cross-iframe relay. Wheel and
 * middle-button presses are not ours and bubble on to the canvas's pan/zoom;
 * holding Space (or the hand tool) makes the layer click-through, so a pan
 * still works with a tool armed.
 *
 * Writes: one `insert` per draw (`useInsertModule`), with the drawn size and
 * the tool's own styles riding the insert as its `style` prop — one source
 * write, one undo entry. T then opens the new text for typing
 * (`createdNodeFollowUp.ts` → `canvasTextEditStart.ts`).
 */
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { registry } from '@core/module-engine'
import { lookupCanvasPageById, selectActiveCanvasPage, useEditorStore } from '@site/store/store'
import type { DrawTool } from '@site/store/slices/canvasSlice'
import { useInsertModule } from '@site/hooks/useInsertModule'
import { CanvasInsertionDragOverlay } from './CanvasInsertionDragOverlay'
import { beginInsertionDragSnapshotSession, type InsertionDragSnapshotSession } from './canvasInsertionDragSnapshot'
import {
  findCanvasViewportAtPoint,
  resolveCanvasPointerInsertionDrop,
  type CanvasPointerInsertionDrop,
  type CanvasDropPreview,
} from './canvasInsertionDrop'
import { getViewportZoom } from './canvasDomGeometry'
import { canvasZoomOf } from './canvasZoom'
import {
  acceptsBoardDraws,
  DRAW_TOOL_SPECS,
  drawInsertStyles,
  drawnRect,
  isDrawDrag,
  offerBoardDraw,
  setDrawGestureActive,
  type DrawPoint,
  type DrawRect,
} from './canvasDrawTool'
import { armCreatedNodeFollowUp } from './createdNodeFollowUp'
import { startCanvasTextEdit } from './canvasTextEditStart'
import styles from './CanvasDrawToolLayer.module.css'

interface CanvasDrawToolLayerProps {
  tool: DrawTool
  /** The board's transform layer — board units for an empty-board draw (P5-G). */
  transformLayerRef: React.RefObject<HTMLDivElement | null>
}

interface HoverState {
  x: number
  y: number
  preview: CanvasDropPreview | null
}

interface DrawSession {
  pointerId: number
  start: DrawPoint
  current: DrawPoint
  /** Where the element lands — resolved at the PRESS point, as Penpot does. `null` over the empty board. */
  drop: CanvasPointerInsertionDrop | null
  /** The pressed frame's on-screen scale, to turn the drawn screen px into CSS px. */
  scale: number
  /** The board frame pressed in (`null` outside a board) — where T's new text opens. */
  frameId: string | null
}

export function CanvasDrawToolLayer({ tool, transformLayerRef }: CanvasDrawToolLayerProps) {
  const spec = DRAW_TOOL_SPECS[tool]
  const insertModule = useInsertModule()
  const [hover, setHover] = useState<HoverState | null>(null)
  const [drawn, setDrawn] = useState<DrawRect | null>(null)
  const sessionRef = useRef<DrawSession | null>(null)
  const snapshotRef = useRef<InsertionDragSnapshotSession | null>(null)
  const frameRef = useRef<number | null>(null)
  const pendingRef = useRef<{ x: number; y: number; modifiers: { square: boolean; fromCenter: boolean } } | null>(null)

  // One candidate snapshot for as long as the tool is armed: each frame is
  // measured once, the first time the pointer visits it (`speed-06`).
  useEffect(() => {
    snapshotRef.current = beginInsertionDragSnapshotSession()
    return () => {
      snapshotRef.current?.dispose()
      snapshotRef.current = null
      setDrawGestureActive(false)
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    }
  }, [])

  const resolveDrop = (clientX: number, clientY: number): CanvasPointerInsertionDrop | null => {
    const state = useEditorStore.getState()
    const canvasPage = selectActiveCanvasPage(state)
    const snapshot = snapshotRef.current
    if (!canvasPage || !snapshot) return null
    return resolveCanvasPointerInsertionDrop({
      canvasPage,
      clientX,
      clientY,
      label: spec.label,
      candidatesForViewport: (viewport, iframe, tree) => snapshot.candidatesFor(viewport, iframe, tree),
      // A board shows many pages; resolve against the page the hovered frame shows.
      resolvePageForViewport: (viewport) => {
        const pageId = viewport.closest<HTMLElement>('[data-page-id]')?.dataset.pageId
        if (!pageId || pageId === canvasPage.id) return null
        return state.site ? lookupCanvasPageById(state.site, pageId) : null
      },
    })
  }

  // At most one resolve and one React commit per animation frame, with the
  // LAST pointer position — a 1000 Hz mouse must not mean 1000 commits.
  const flush = () => {
    frameRef.current = null
    const pending = pendingRef.current
    pendingRef.current = null
    if (!pending) return
    const session = sessionRef.current
    if (session) {
      session.current = { x: pending.x, y: pending.y }
      setDrawn(isDrawDrag(session.start, session.current) ? drawnRect(session.start, session.current, pending.modifiers) : null)
      return
    }
    setHover({ x: pending.x, y: pending.y, preview: resolveDrop(pending.x, pending.y)?.preview ?? null })
  }

  const schedule = (event: ReactPointerEvent<HTMLDivElement>) => {
    pendingRef.current = { x: event.clientX, y: event.clientY, modifiers: { square: event.shiftKey, fromCenter: event.altKey } }
    frameRef.current ??= requestAnimationFrame(flush)
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return // wheel / middle-button pan are the canvas's
    event.preventDefault()
    event.stopPropagation()
    const start = { x: event.clientX, y: event.clientY }
    const viewport = findCanvasViewportAtPoint(start.x, start.y)
    sessionRef.current = {
      pointerId: event.pointerId,
      start,
      current: start,
      drop: viewport ? resolveDrop(start.x, start.y) : null,
      scale: viewport ? getViewportZoom(viewport) : 1,
      frameId: viewport?.closest<HTMLElement>('[data-frame-id]')?.dataset.frameId ?? null,
    }
    setDrawGestureActive(true)
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch (_err) {
      // A capture the browser refuses still leaves the layer's own handlers.
    }
  }

  const finish = (event: ReactPointerEvent<HTMLDivElement>, commit: boolean) => {
    const session = sessionRef.current
    if (!session || session.pointerId !== event.pointerId) return
    sessionRef.current = null
    setDrawGestureActive(false)
    setDrawn(null)
    if (!commit) return
    const end = { x: event.clientX, y: event.clientY }
    const dragged = isDrawDrag(session.start, end)
    const rect = dragged ? drawnRect(session.start, end, { square: event.shiftKey, fromCenter: event.altKey }) : null
    if (session.drop) {
      commitFrameDraw(session.drop, rect, session.scale, session.frameId)
      return
    }
    commitBoardDraw(session.start, rect)
  }

  const commitFrameDraw = (drop: CanvasPointerInsertionDrop, rect: DrawRect | null, scale: number, frameId: string | null) => {
    const definition = registry.get(spec.moduleId)
    if (!definition) return
    const store = useEditorStore.getState()
    // Every insert writes through the ACTIVE tree, so the frame's page must be
    // active before it runs (`useCanvasInsertionDrag` does the same).
    if (drop.pageId !== selectActiveCanvasPage(store)?.id) store.openPageInCanvas(drop.pageId)
    if (tool === 'text') armCreatedNodeFollowUp((nodeId) => { startCanvasTextEdit(nodeId, frameId) })
    const nodeId = insertModule(definition, drop.location, { inlineStyles: drawInsertStyles(spec, rect, scale) })
    if (nodeId !== null) useEditorStore.getState().setActiveBreakpoint(drop.breakpointId)
    useEditorStore.getState().setCanvasTool('move')
  }

  const commitBoardDraw = (start: DrawPoint, rect: DrawRect | null) => {
    const layer = transformLayerRef.current
    if (!layer) return
    const bounds = layer.getBoundingClientRect()
    const zoom = canvasZoomOf(layer)
    const client = rect ?? { x: start.x, y: start.y, width: 0, height: 0 }
    const created = offerBoardDraw({
      tool,
      spec,
      dragged: rect !== null,
      boardRect: {
        x: (client.x - bounds.left) / zoom,
        y: (client.y - bounds.top) / zoom,
        width: client.width / zoom,
        height: client.height / zoom,
      },
    })
    if (created) useEditorStore.getState().setCanvasTool('move')
  }

  const ghostLabel = hover && !hover.preview && !acceptsBoardDraws() ? `${spec.label} — draw inside a frame` : spec.label

  return (
    <>
      <div
        className={styles.layer}
        data-canvas-draw-layer={tool}
        aria-hidden="true"
        onPointerDown={onPointerDown}
        onPointerMove={schedule}
        onPointerUp={(event) => finish(event, true)}
        onPointerCancel={(event) => finish(event, false)}
        onLostPointerCapture={(event) => finish(event, false)}
        onPointerLeave={() => {
          if (!sessionRef.current) setHover(null)
        }}
      />
      {drawn &&
        createPortal(
          <div
            className={styles.drawnRect}
            data-canvas-drawn-rect="true"
            style={
              {
                '--drawn-left': `${drawn.x}px`,
                '--drawn-top': `${drawn.y}px`,
                '--drawn-width': `${drawn.width}px`,
                '--drawn-height': `${drawn.height}px`,
              } as React.CSSProperties
            }
          />,
          document.body,
        )}
      <CanvasInsertionDragOverlay drag={!drawn && hover ? { ghost: tool, x: hover.x, y: hover.y, preview: hover.preview } : null}>
        {ghostLabel}
      </CanvasInsertionDragOverlay>
    </>
  )
}
