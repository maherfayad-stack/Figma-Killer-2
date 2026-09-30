/**
 * boardSnapping — what a piece of board furniture (a frame, a sticky note, a
 * doc block, a loose layer) snaps TO, and the board-side reads the snap
 * engine needs. The resolver itself is `@core/studio-runtime`'s
 * `snapRules.ts` (alignment, ruler guides, equal spacing, the toggles),
 * shared with the element-level gestures; this module only turns a `Board`
 * into its inputs.
 *
 *  - `collectPeerRects` excludes whichever object is currently being dragged
 *    so it never snaps to itself. Frames without a saved size fall back to
 *    `FRAME_WIDTH`/`FRAME_HEIGHT` — the same fallback `BoardFramesLayer`
 *    itself uses at render time.
 *  - `rulerGuideLines` — the persisted ruler guides as snap lines (P5-F,
 *    IX-5c), in board space.
 *  - `readBoardScreenOrigin` — where board (0, 0) is on screen, so an
 *    element inside a frame can convert those lines into its frame's space
 *    (`guideLinesInSpace`).
 *  - `snapBoardFurniture` — the whole furniture snap in one call, so every
 *    board object (frames, notes, docs, P5-G's loose layers) gets guides,
 *    spacing and the user's toggles without assembling them itself.
 */
import { FRAME_WIDTH, FRAME_HEIGHT, type Board, type BoardGuide } from '@core/studio-board'
import {
  computeSnap,
  snapSourcesFor,
  snapThresholdAtZoom,
  type ScreenSpace,
  type SnapLine,
  type SnapRect,
  type SnapResult,
  type SnapSourceToggles,
} from '@core/studio-runtime'
import { canvasTransformLayerOf, canvasZoomOf } from './canvasZoom'

/** Identifies which furniture is currently being dragged, so `collectPeerRects`
 * can exclude it from its own peer list. */
export type DraggedFurniture =
  | { kind: 'frame'; pageId: string }
  | { kind: 'note'; id: string }
  | { kind: 'doc'; id: string }
  // P5-G — a loose layer: every frame, note and doc is a peer. Other loose
  // layers are too, but their sizes are measured (`canvasLayerGeometry.ts`),
  // not stored on the board, so the caller adds them.
  | { kind: 'layer'; id: string }

/**
 * Every OTHER piece of furniture on `board` (frames, notes, docs) as a flat
 * `SnapRect[]`, excluding whichever one is being dragged. Frames without a
 * saved width/height fall back to `FRAME_WIDTH`/`FRAME_HEIGHT`, mirroring
 * `BoardFramesLayer`'s own render-time fallback.
 */
export function collectPeerRects(board: Board, dragged: DraggedFurniture): SnapRect[] {
  const peers: SnapRect[] = []

  for (const frame of board.frames) {
    if (dragged.kind === 'frame' && frame.pageId === dragged.pageId) continue
    peers.push({
      x: frame.x,
      y: frame.y,
      width: frame.width ?? FRAME_WIDTH,
      height: frame.height ?? FRAME_HEIGHT,
    })
  }

  for (const note of board.notes) {
    if (dragged.kind === 'note' && note.id === dragged.id) continue
    peers.push({ x: note.x, y: note.y, width: note.w, height: note.h })
  }

  for (const doc of board.docs) {
    if (dragged.kind === 'doc' && doc.id === dragged.id) continue
    peers.push({ x: doc.x, y: doc.y, width: doc.w, height: doc.h })
  }

  return peers
}

/**
 * D1 — persisted ruler guides (`@core/studio-board`'s `BoardGuide`, NOT the
 * transient `SnapGuide` a snap draws) as snap lines, in BOARD space. Board
 * furniture snaps to these as they are; an element inside a frame converts
 * them into its frame's space first (`guideLinesInSpace`). P5-F wired them
 * into every snapping gesture (IX-5c); the old off-axis sentinel rects this
 * replaced were never called.
 */
export function rulerGuideLines(guides: readonly BoardGuide[]): SnapLine[] {
  return guides.map((guide) => ({ axis: guide.axis, position: guide.position }))
}

/**
 * The board's screen space, read off the canvas transform layer `element`
 * sits in (a frame's viewport or iframe). Its `transform-origin` is `0 0`, so
 * its rect's top-left IS board (0, 0) at any pan and zoom. `null` outside a
 * board canvas — a live view, a test — where there are no guides to convert.
 */
export function readBoardScreenOrigin(element: Element | null): ScreenSpace | null {
  if (!(element instanceof HTMLElement)) return null
  const layer = canvasTransformLayerOf(element)
  if (!layer) return null
  const rect = layer.getBoundingClientRect()
  return { originX: rect.left, originY: rect.top, scale: canvasZoomOf(layer) }
}

/**
 * One board-furniture snap, the whole question: every other frame, note and
 * doc on `board` as peers, the board's ruler guides as lines, the user's
 * toggles applied, the threshold in screen px. Frames, notes, docs and
 * loose layers ask this rather than assembling the sources themselves, so a
 * new snap source or toggle reaches all of them. Peers the board does not
 * store (a loose layer's measured neighbours) go in `extraPeers`.
 */
export function snapBoardFurniture(input: {
  board: Board | null
  dragged: DraggedFurniture
  rect: SnapRect
  preferences: SnapSourceToggles
  zoom: number
  extraPeers?: readonly SnapRect[]
}): SnapResult {
  const { board, dragged, rect, preferences, zoom, extraPeers = [] } = input
  const boardPeers = board ? collectPeerRects(board, dragged) : []
  const { peers, options } = snapSourcesFor(
    preferences,
    [...boardPeers, ...extraPeers],
    rulerGuideLines(board?.guides ?? []),
  )
  return computeSnap(rect, peers, snapThresholdAtZoom(zoom), options)
}
