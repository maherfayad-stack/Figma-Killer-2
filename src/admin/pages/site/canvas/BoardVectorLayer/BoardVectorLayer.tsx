/**
 * BoardVectorLayer — vector edit mode (P5-D): the anchors and handles of an
 * inline `<svg>`'s paths, drawn in BOARD space, and the drag that moves them.
 *
 * ## Why board space (audit 08 §4.2, option c)
 *
 * Mounted inside `CanvasTransformLayer` beside `BoardPrototypeLayer`, whose
 * precedent it follows: pan and zoom move the layer for free, a point's board
 * position is `frame origin + part CTM · p` measured once per session
 * (`vectorEditParts.ts`), and chrome is sized in screen pixels by dividing by
 * the zoom. Nothing here is canvas DOM: the frame's page gains no element and
 * no attribute but the mirrored `d` below.
 *
 * ## One gesture, one write — and zero React commits while it runs
 *
 * `pointerdown` on an anchor or handle captures the pointer and snapshots the
 * part's model. Each `pointermove` only stores the point; one rAF callback
 * moves the model (`@core/vector`, token-preserving), re-emits `d` for the
 * touched segments only, and writes it to the overlay AND to the real in-frame
 * `<path>` (owner decision D6: the real shape updates live). Those are
 * `setAttribute` calls on ref'd elements — no state, no store — held inside
 * `beginCanvasGesture()` so the frame's attribute observers stay quiet.
 * `pointerup` posts ONE `svg-attr` edit (`svgPartCommits.ts`) and records one
 * undo entry. A write that does not land puts the old `d` back.
 *
 * The overlay's own paths are also written imperatively (`paint`): React
 * renders the elements, never their geometry, so a drag's DOM writes and a
 * re-render can never disagree about what is on screen.
 *
 * ## DOM size is O(1)
 *
 * Every idle anchor is ONE path of squares, every hit target ONE transparent
 * path; a 2,000-anchor graphic is a handful of elements (SVG-9's budget).
 * `pointerdown` finds which anchor was hit by a linear nearest-point search.
 *
 * ## Leaving
 *
 * Escape / Enter (`useVectorEditKeys`), selecting anything else, or the
 * graphic disappearing. A click that is not on an anchor falls through to the
 * frame, where it selects — which, unless it selects this same svg, leaves.
 */
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { moveAnchor, moveHandle, serializePathModel, type PathModel, type Point } from '@core/vector'
import { pushToast } from '@ui/components/Toast'
import { cn } from '@ui/cn'
import { lookupCanvasPageById, useEditorStore } from '@site/store/store'
import { commitSvgPartAttributes } from '@site/studio/svgPartCommits'
import { beginCanvasGesture, endCanvasGesture } from '../canvasGesture'
import { clientToBoardPoint, findBoardOrigin, type BoardOrigin } from '../BoardCanvasLayer/canvasLayerGeometry'
import { exitVectorEdit, useVectorEditTarget, type VectorEditTarget } from './vectorEditState'
import { resolveVectorHost, type VectorPart } from './vectorEditParts'
import {
  affineTransformAttribute,
  anchorHandles,
  applyAffine,
  applyLinear,
  circlesPathData,
  constrainTo45,
  linesPathData,
  modelAnchors,
  nearestPointIndex,
  squaresPathData,
  type VectorHandle,
} from './vectorGeometry'
import { useVectorEditKeys, type VectorSelection } from './useVectorEditKeys'
import styles from './BoardVectorLayer.module.css'

/** Screen-pixel chrome sizes (Penpot's point radius 5, handle 6, hit 15 — ÷ zoom). */
const ANCHOR_HALF_PX = 4
const HANDLE_RADIUS_PX = 3.5
const HIT_HALF_PX = 8
/** Screen px the pointer travels before a press on an anchor is a drag. */
const DRAG_THRESHOLD_PX = 3

export function BoardVectorLayer() {
  const target = useVectorEditTarget()
  if (!target) return null
  return <VectorEditOverlay key={`${target.pageId}|${target.frameId}|${target.hostNodeId}`} target={target} />
}

interface DragState {
  pointerId: number
  part: number
  segment: number
  handle: 'c1' | 'c2' | null
  origin: BoardOrigin
  startBoard: Point
  startModel: PathModel
  startD: string
  lastClient: Point | null
  shift: boolean
  gesture: symbol | null
}

function VectorEditOverlay({ target }: { target: VectorEditTarget }) {
  const zoom = useEditorStore((s) => s.zoom)
  const markup = useEditorStore((s) => {
    const page = s.site ? lookupCanvasPageById(s.site, target.pageId) : null
    const svg = page?.nodes[target.hostNodeId]?.props.svg
    return typeof svg === 'string' ? svg : null
  })
  const selectedNodeId = useEditorStore((s) => s.selectedNodeId)
  // The stamps of the measured parts — the only React-visible fact of a
  // session besides the selected anchor. Geometry lives in `partsRef`.
  const [partKeys, setPartKeys] = useState<readonly string[]>([])
  const [selection, setSelection] = useState<VectorSelection | null>(null)

  const partsRef = useRef<VectorPart[]>([])
  const svgRef = useRef<SVGSVGElement | null>(null)
  const outlineRefs = useRef<(SVGPathElement | null)[]>([])
  const anchorsRef = useRef<SVGPathElement | null>(null)
  const activeRef = useRef<SVGPathElement | null>(null)
  const handleLinesRef = useRef<SVGPathElement | null>(null)
  const handleDotsRef = useRef<SVGPathElement | null>(null)
  const hitRef = useRef<SVGPathElement | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const frameRef = useRef<number | null>(null)
  const selectionRef = useRef<VectorSelection | null>(null)

  // Leave when the graphic is no longer the selection, or no longer exists.
  useEffect(() => {
    if (markup === null || (selectedNodeId !== null && selectedNodeId !== target.hostNodeId)) exitVectorEdit()
  }, [markup, selectedNodeId, target.hostNodeId])

  // (Re)measure after every commit that changed the host's markup: a
  // re-applied `__html` recreated every inner element.
  useLayoutEffect(() => {
    if (markup === null) return
    const resolution = resolveVectorHost(target.frameId, target.hostNodeId)
    if (!resolution.ok) {
      pushToast({ kind: 'warning', title: 'Cannot edit points', body: resolution.message, location: 'site-editor' })
      exitVectorEdit()
      return
    }
    partsRef.current = resolution.value.parts
    setPartKeys(resolution.value.parts.map((part) => part.part))
  }, [markup, target.frameId, target.hostNodeId])

  const half = (px: number) => px / (zoom > 0 ? zoom : 1)

  /** Every visible handle of the selected anchor, in board units. */
  const selectedHandles = (): (VectorHandle & { board: Point; anchorBoard: Point })[] => {
    const sel = selectionRef.current
    const part = sel ? partsRef.current[sel.part] : undefined
    if (!sel || !part) return []
    return anchorHandles(part.model, sel.part, sel.segment).map((h) => ({
      ...h,
      board: applyAffine(part.toBoard, h.local),
      anchorBoard: applyAffine(part.toBoard, h.anchorLocal),
    }))
  }

  const anchorBoards = (skip?: { part: number; segment: number }) => {
    const out: { part: number; segment: number; board: Point }[] = []
    partsRef.current.forEach((part, index) => {
      for (const anchor of modelAnchors(part.model, index)) {
        if (skip && skip.part === index && skip.segment === anchor.segment) continue
        out.push({ part: index, segment: anchor.segment, board: applyAffine(part.toBoard, anchor.local) })
      }
    })
    return out
  }

  /** The parts of the overlay a drag moves: the outline, the active anchor, its handles. */
  const paintActive = () => {
    const sel = selectionRef.current
    const part = sel ? partsRef.current[sel.part] : undefined
    const outline = sel ? outlineRefs.current[sel.part] : null
    if (part && outline) outline.setAttribute('d', part.d)
    const anchor = part && sel ? part.model.segments[sel.segment]?.to : undefined
    activeRef.current?.setAttribute('d', part && anchor ? squaresPathData([applyAffine(part.toBoard, anchor)], half(ANCHOR_HALF_PX)) : '')
    const handles = selectedHandles()
    handleLinesRef.current?.setAttribute('d', linesPathData(handles.map((h) => [h.anchorBoard, h.board] as const)))
    handleDotsRef.current?.setAttribute('d', circlesPathData(handles.map((h) => h.board), half(HANDLE_RADIUS_PX)))
  }

  /** Everything, from the parts as they stand. */
  const paint = () => {
    partsRef.current.forEach((part, index) => {
      const outline = outlineRefs.current[index]
      if (!outline) return
      outline.setAttribute('d', part.d)
      outline.setAttribute('transform', affineTransformAttribute(part.toBoard))
    })
    const anchors = anchorBoards()
    anchorsRef.current?.setAttribute('d', squaresPathData(anchors.map((a) => a.board), half(ANCHOR_HALF_PX)))
    const hits = [...anchors.map((a) => a.board), ...selectedHandles().map((h) => h.board)]
    hitRef.current?.setAttribute('d', squaresPathData(hits, half(HIT_HALF_PX)))
    fitToPoints(hits)
    paintActive()
  }

  /**
   * Size the svg's own box to the hit targets (board units, `viewBox` equal to
   * the box, so a coordinate is still a board unit). Content outside an svg's
   * box PAINTS with `overflow: visible` but is not reliably hit-testable, and
   * the hit targets are what must be.
   */
  const fitToPoints = (points: readonly Point[]) => {
    const svg = svgRef.current
    if (!svg || points.length === 0) return
    const pad = half(HIT_HALF_PX) * 2
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const p of points) {
      minX = Math.min(minX, p.x)
      minY = Math.min(minY, p.y)
      maxX = Math.max(maxX, p.x)
      maxY = Math.max(maxY, p.y)
    }
    const box = { x: minX - pad, y: minY - pad, width: maxX - minX + pad * 2, height: maxY - minY + pad * 2 }
    svg.setAttribute('viewBox', `${box.x} ${box.y} ${box.width} ${box.height}`)
    svg.style.setProperty('--vector-x', `${box.x}px`)
    svg.style.setProperty('--vector-y', `${box.y}px`)
    svg.style.setProperty('--vector-w', `${box.width}px`)
    svg.style.setProperty('--vector-h', `${box.height}px`)
  }
  const paintRef = useRef(paint)
  // Refs are synced after render (never during it), then everything is painted.
  useLayoutEffect(() => {
    paintRef.current = paint
    selectionRef.current = selection
  })
  useLayoutEffect(() => {
    paintRef.current()
  }, [partKeys, zoom, selection])

  useEffect(() => () => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    const drag = dragRef.current
    if (drag?.gesture) endCanvasGesture(drag.gesture)
  }, [])

  /** The one write a finished gesture makes; a write that does not land puts the old `d` back. */
  const commitPart = (partIndex: number, startModel: PathModel, startD: string, label: string) => {
    const part = partsRef.current[partIndex]
    if (!part || part.d === startD) return
    const written = part.d
    void commitSvgPartAttributes(
      [{ hostNodeId: target.hostNodeId, part: part.part, partTag: 'path', set: { d: written }, previous: { d: startD } }],
      label,
      () => {
        // Still the same session and nothing newer landed on this part: restore it.
        const current = partsRef.current.find((p) => p.part === part.part)
        if (!current || current.d !== written) return
        current.model = startModel
        current.d = startD
        current.element.setAttribute('d', startD)
        paintRef.current()
      },
    )
  }

  const moveSelection = (part: VectorPart, drag: DragState, deltaBoard: Point) => {
    const delta = applyLinear(part.toLocal, drag.shift ? constrainTo45(deltaBoard) : deltaBoard)
    const model = drag.handle === null
      ? moveAnchor(drag.startModel, drag.segment, delta)
      : moveHandle(drag.startModel, drag.segment, drag.handle, delta)
    part.model = model
    part.d = serializePathModel(model, { decimals: part.decimals }).d
    part.element.setAttribute('d', part.d) // D6 — the real shape follows the pointer
    paintActive()
  }

  const applyDrag = () => {
    frameRef.current = null
    const drag = dragRef.current
    const client = drag?.lastClient
    const part = drag ? partsRef.current[drag.part] : undefined
    if (!drag || !client || !part) return
    const board = clientToBoardPoint(client, drag.origin, drag.origin.zoom)
    const deltaBoard = { x: board.x - drag.startBoard.x, y: board.y - drag.startBoard.y }
    if (drag.gesture === null) {
      if (Math.hypot(deltaBoard.x, deltaBoard.y) * drag.origin.zoom < DRAG_THRESHOLD_PX) return
      // The first real move: hold the frame's observers, and take the dragged
      // anchor out of the idle path once (not per frame).
      drag.gesture = beginCanvasGesture()
      if (drag.handle === null) {
        anchorsRef.current?.setAttribute(
          'd',
          squaresPathData(anchorBoards({ part: drag.part, segment: drag.segment }).map((a) => a.board), half(ANCHOR_HALF_PX)),
        )
      }
    }
    moveSelection(part, drag, deltaBoard)
  }

  const onPointerDown = (event: ReactPointerEvent<SVGPathElement>) => {
    if (event.button !== 0) return
    const origin = findBoardOrigin()
    if (!origin) return
    const board = clientToBoardPoint({ x: event.clientX, y: event.clientY }, origin, origin.zoom)
    const radius = HIT_HALF_PX / origin.zoom
    // A handle of the selected anchor wins over an anchor under it.
    const handles = selectedHandles()
    const handleHit = nearestPointIndex(handles.map((h) => h.board), board, radius)
    const anchors = anchorBoards()
    const anchorHit = handleHit === -1 ? nearestPointIndex(anchors.map((a) => a.board), board, radius) : -1
    const hit = handleHit !== -1
      ? { part: handles[handleHit]!.part, segment: handles[handleHit]!.segment, handle: handles[handleHit]!.handle }
      : anchorHit !== -1
        ? { part: anchors[anchorHit]!.part, segment: anchors[anchorHit]!.segment, handle: null }
        : null
    if (!hit) return
    const part = partsRef.current[hit.part]
    if (!part) return
    event.preventDefault()
    if (hit.handle === null) {
      // The ref too: the drag's first frame may paint before the re-render syncs it.
      selectionRef.current = { part: hit.part, segment: hit.segment }
      setSelection(selectionRef.current)
    }
    dragRef.current = {
      pointerId: event.pointerId,
      part: hit.part,
      segment: hit.segment,
      handle: hit.handle,
      origin,
      startBoard: board,
      startModel: part.model,
      startD: part.d,
      lastClient: null,
      shift: event.shiftKey,
      gesture: null,
    }
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch (_err) {
      // A refused capture still leaves the element's own move/up handlers.
    }
  }

  const onPointerMove = (event: ReactPointerEvent<SVGPathElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    drag.lastClient = { x: event.clientX, y: event.clientY }
    drag.shift = event.shiftKey
    frameRef.current ??= requestAnimationFrame(applyDrag)
  }

  const finish = (event: ReactPointerEvent<SVGPathElement>, commit: boolean) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current)
      applyDrag()
    }
    dragRef.current = null
    if (drag.gesture === null) return // a click: selection only
    endCanvasGesture(drag.gesture)
    const part = partsRef.current[drag.part]
    if (!commit && part) {
      part.model = drag.startModel
      part.d = drag.startD
      part.element.setAttribute('d', drag.startD)
    } else {
      commitPart(drag.part, drag.startModel, drag.startD, drag.handle === null ? 'Move point' : 'Move handle')
    }
    paintRef.current()
  }

  useVectorEditKeys({
    partsRef,
    selectionRef,
    repaint: () => paintRef.current(),
    commitPart,
  })

  return (
    <svg ref={svgRef} className={cn(styles.layer, styles.fitted)} data-board-vector-layer="edit" aria-hidden="true">
      {partKeys.map((key, index) => (
        <path
          key={key}
          className={styles.outline}
          ref={(el) => {
            outlineRefs.current[index] = el
          }}
        />
      ))}
      <path ref={handleLinesRef} className={styles.handleLines} />
      <path ref={anchorsRef} className={styles.anchors} data-vector-anchors="" />
      <path ref={handleDotsRef} className={styles.handleDots} />
      <path ref={activeRef} className={styles.active} data-vector-active="" />
      <path
        ref={hitRef}
        className={styles.hit}
        data-vector-hit=""
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(event) => finish(event, true)}
        onPointerCancel={(event) => finish(event, false)}
      />
    </svg>
  )
}
