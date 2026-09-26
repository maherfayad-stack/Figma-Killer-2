/**
 * CanvasPenToolLayer — the pen tool (P5-D, SVG-7): draw a path, write it as
 * ONE new inline `<svg>`.
 *
 * ## The gesture
 *
 *   - click: a corner point; press-and-drag: a smooth point whose handles
 *     follow the pointer (⌥ moves only the outgoing handle);
 *   - ⇧ snaps the new point to 45° from the previous one;
 *   - clicking the FIRST point closes the path and finishes it;
 *   - ⏎ or Escape finishes an open path; ⌘Z / Backspace take back the last
 *     point — a stack local to the session, never the editor's undo (the
 *     `vector-edit` rung claims those keys while a path is in flight).
 *
 * A whole session is ONE write and ONE undo entry, whatever the number of
 * points. Where it lands is decided by the FIRST click, the way the box tools
 * decide at the press: inside a frame, the new `<svg>` is inserted in flow at
 * the same drop target an insertion drag shows (`resolveCanvasPointerInsertionDrop`)
 * — the honest position in a React tree, like R / O — through P5-A's
 * `insertJsxSubtreeIntoPage`, the pasted SVG's own write; on the empty board it
 * becomes a loose layer on the free canvas at the drawn position (OD-14, and
 * OD-10's D1 superseded by it). The tool puts itself away after a path.
 *
 * ## Surface and preview
 *
 * The same parent-document capture surface as `CanvasDrawToolLayer` (its CSS
 * `.layer`): no frame's document sees the presses, and no box is added to any
 * page. The preview is drawn in BOARD units in an svg portalled into the
 * transform layer, so it pans and zooms with the board for free; points are
 * converted through the free canvas's board-origin marker. Per pointer move
 * the preview is written imperatively in one rAF — no React commit.
 */
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { Point } from '@core/vector'
import { pushToast } from '@ui/components/Toast'
import { lookupCanvasPageById, selectActiveCanvasPage, useEditorStore } from '@site/store/store'
import { beginInsertionDragSnapshotSession, type InsertionDragSnapshotSession } from './canvasInsertionDragSnapshot'
import { resolveCanvasPointerInsertionDrop, type CanvasPointerInsertionDrop } from './canvasInsertionDrop'
import { clientToBoardPoint, findBoardOrigin } from './BoardCanvasLayer/canvasLayerGeometry'
import { useEditorKeyScope } from './useEditorKeyDispatcher'
import { penPathData, penSvgElement, withDraggedHandle, type PenAnchor } from './BoardVectorLayer/penPath'
import { circlesPathData, constrainTo45, linesPathData, squaresPathData } from './BoardVectorLayer/vectorGeometry'
import drawStyles from './CanvasDrawToolLayer.module.css'
import vectorStyles from './BoardVectorLayer/BoardVectorLayer.module.css'

/** Screen px within which a click on the first point closes the path. */
const CLOSE_RADIUS_PX = 8
/** Screen px a press travels before it is a drag (a smooth point). */
const DRAG_THRESHOLD_PX = 3
const ANCHOR_HALF_PX = 4
const HANDLE_RADIUS_PX = 3.5

interface PenSession {
  anchors: PenAnchor[]
  /** Where the path is written — resolved at the first click; `null` for the empty board. */
  drop: CanvasPointerInsertionDrop | null
  hover: Point | null
  press: { pointerId: number; start: Point; startClient: Point; index: number; dragged: boolean; alt: boolean } | null
}

export function CanvasPenToolLayer({ transformLayerRef }: { transformLayerRef: RefObject<HTMLDivElement | null> }) {
  const [portalHost, setPortalHost] = useState<HTMLElement | null>(null)
  const sessionRef = useRef<PenSession>({ anchors: [], drop: null, hover: null, press: null })
  const snapshotRef = useRef<InsertionDragSnapshotSession | null>(null)
  const frameRef = useRef<number | null>(null)
  const pendingRef = useRef<{ client: Point; shift: boolean; alt: boolean } | null>(null)
  const pathRef = useRef<SVGPathElement | null>(null)
  const rubberRef = useRef<SVGPathElement | null>(null)
  const anchorsRef = useRef<SVGPathElement | null>(null)
  const handleLinesRef = useRef<SVGPathElement | null>(null)
  const handleDotsRef = useRef<SVGPathElement | null>(null)

  useEffect(() => {
    setPortalHost(transformLayerRef.current)
    snapshotRef.current = beginInsertionDragSnapshotSession()
    return () => {
      snapshotRef.current?.dispose()
      snapshotRef.current = null
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    }
  }, [transformLayerRef])

  const toBoard = (client: Point): { point: Point; zoom: number } | null => {
    const origin = findBoardOrigin()
    return origin ? { point: clientToBoardPoint(client, origin, origin.zoom), zoom: origin.zoom } : null
  }

  /** Every preview path, from the session as it stands. */
  const paint = () => {
    const { anchors, hover } = sessionRef.current
    const zoom = findBoardOrigin()?.zoom ?? 1
    pathRef.current?.setAttribute('d', penPathData(anchors, false))
    anchorsRef.current?.setAttribute('d', squaresPathData(anchors.map((a) => a.point), ANCHOR_HALF_PX / zoom))
    const last = anchors[anchors.length - 1]
    const rubber = last && hover && !sessionRef.current.press
      ? penPathData([last, { point: hover }], false)
      : ''
    rubberRef.current?.setAttribute('d', rubber)
    const handles = last ? [last.in, last.out].filter((h): h is Point => h !== undefined) : []
    handleLinesRef.current?.setAttribute('d', last ? linesPathData(handles.map((h) => [last.point, h] as const)) : '')
    handleDotsRef.current?.setAttribute('d', circlesPathData(handles, HANDLE_RADIUS_PX / zoom))
  }

  const reset = () => {
    sessionRef.current = { anchors: [], drop: null, hover: sessionRef.current.hover, press: null }
    paint()
  }

  const resolveDrop = (client: Point): CanvasPointerInsertionDrop | null => {
    const state = useEditorStore.getState()
    const canvasPage = selectActiveCanvasPage(state)
    const snapshot = snapshotRef.current
    if (!canvasPage || !snapshot) return null
    return resolveCanvasPointerInsertionDrop({
      canvasPage,
      clientX: client.x,
      clientY: client.y,
      label: 'Path',
      candidatesForViewport: (viewport, iframe, tree) => snapshot.candidatesFor(viewport, iframe, tree),
      resolvePageForViewport: (viewport) => {
        const pageId = viewport.closest<HTMLElement>('[data-page-id]')?.dataset.pageId
        if (!pageId || pageId === canvasPage.id) return null
        return state.site ? lookupCanvasPageById(state.site, pageId) : null
      },
    })
  }

  /** Write the path — ONE insert (or one loose layer) — and put the tool away. */
  const finish = (closed: boolean) => {
    const { anchors, drop } = sessionRef.current
    const element = penSvgElement(anchors, closed)
    reset()
    if (!element) return
    const store = useEditorStore.getState()
    store.setCanvasTool('move')
    const children = [{ name: 'path', props: { d: element.d } }]
    if (!drop) {
      if (store.createCanvasLayer({ name: 'svg', props: element.props, children }, { x: element.origin.x, y: element.origin.y }) === null) {
        pushToast({ kind: 'warning', title: 'Path not added', body: 'Draw inside a frame, or open a board to draw on the free canvas.', location: 'site-editor' })
      }
      return
    }
    // P5-A's subtree insert: ONE `insert` whose children carry the path, into
    // the NAMED page (it activates it), queued behind a structural write
    // already on the wire, refusing by name where the container cannot take it.
    const page = store.site ? lookupCanvasPageById(store.site, drop.pageId) : null
    const appendAt = page?.nodes[drop.location.parentId]?.children.length ?? 0
    store.setActiveBreakpoint(drop.breakpointId)
    store.insertJsxSubtreeIntoPage({
      pageId: drop.pageId,
      parentId: drop.location.parentId,
      index: drop.location.index ?? appendAt,
      node: { name: 'svg', props: element.props, children },
      undoLabel: 'Draw path',
    })
  }

  const flush = () => {
    frameRef.current = null
    const pending = pendingRef.current
    pendingRef.current = null
    const session = sessionRef.current
    if (!pending) return
    const board = toBoard(pending.client)
    if (!board) return
    const press = session.press
    if (press) {
      const moved = Math.hypot(pending.client.x - press.startClient.x, pending.client.y - press.startClient.y)
      if (!press.dragged && moved < DRAG_THRESHOLD_PX) return
      press.dragged = true
      press.alt = pending.alt
      const anchor = session.anchors[press.index]
      if (anchor) session.anchors[press.index] = withDraggedHandle(anchor, board.point, pending.alt)
    } else {
      const last = session.anchors[session.anchors.length - 1]
      session.hover = last && pending.shift ? snap(last.point, board.point) : board.point
    }
    paint()
  }

  const schedule = (event: ReactPointerEvent<HTMLDivElement>) => {
    pendingRef.current = { client: { x: event.clientX, y: event.clientY }, shift: event.shiftKey, alt: event.altKey }
    frameRef.current ??= requestAnimationFrame(flush)
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return // wheel / middle-button pan are the canvas's
    event.preventDefault()
    const client = { x: event.clientX, y: event.clientY }
    const board = toBoard(client)
    if (!board) return
    const session = sessionRef.current
    const first = session.anchors[0]
    if (first && session.anchors.length >= 2 && Math.hypot(board.point.x - first.point.x, board.point.y - first.point.y) * board.zoom <= CLOSE_RADIUS_PX) {
      finish(true)
      return
    }
    if (session.anchors.length === 0) session.drop = resolveDrop(client)
    const last = session.anchors[session.anchors.length - 1]
    const point = last && event.shiftKey ? snap(last.point, board.point) : board.point
    session.anchors.push({ point })
    session.press = { pointerId: event.pointerId, start: point, startClient: client, index: session.anchors.length - 1, dragged: false, alt: false }
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch (_err) {
      // A refused capture still leaves the layer's own handlers.
    }
    paint()
  }

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const press = sessionRef.current.press
    if (!press || press.pointerId !== event.pointerId) return
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current)
      flush()
    }
    sessionRef.current.press = null
    paint()
  }

  // The `vector-edit` rung: while a path is in flight its keys are the pen's.
  useEditorKeyScope(
    'vector-edit',
    () => sessionRef.current.anchors.length > 0,
    (event) => {
      const undo = (event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === 'z'
      if (undo || event.key === 'Backspace' || event.key === 'Delete') {
        event.preventDefault()
        sessionRef.current.anchors.pop()
        sessionRef.current.press = null
        paint()
        return true
      }
      if (event.key === 'Enter' || event.key === 'Escape') {
        event.preventDefault()
        if (sessionRef.current.anchors.length < 2) {
          reset()
          useEditorStore.getState().setCanvasTool('move')
          return true
        }
        finish(false)
        return true
      }
      return false
    },
  )

  return (
    <>
      <div
        className={drawStyles.layer}
        data-canvas-draw-layer="pen"
        aria-hidden="true"
        onPointerDown={onPointerDown}
        onPointerMove={schedule}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={() => {
          if (sessionRef.current.press) return
          sessionRef.current.hover = null
          paint()
        }}
      />
      {portalHost &&
        createPortal(
          <svg className={vectorStyles.layer} data-board-vector-layer="pen" aria-hidden="true">
            <path ref={pathRef} className={vectorStyles.penPath} />
            <path ref={rubberRef} className={vectorStyles.penRubberBand} />
            <path ref={handleLinesRef} className={vectorStyles.handleLines} />
            <path ref={anchorsRef} className={vectorStyles.anchors} />
            <path ref={handleDotsRef} className={vectorStyles.handleDots} />
          </svg>,
          portalHost,
        )}
    </>
  )
}

/** `point` snapped to 45° increments around `from` (⇧). */
function snap(from: Point, point: Point): Point {
  const delta = constrainTo45({ x: point.x - from.x, y: point.y - from.y })
  return { x: from.x + delta.x, y: from.y + delta.y }
}
