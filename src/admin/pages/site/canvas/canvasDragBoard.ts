/**
 * canvasDragBoard — D2 G3's half of the drag session: which OTHER frame the
 * pointer is over, and everything that frame needs to answer a drop.
 *
 * ## The shape, and why it mirrors `canvasDragSession.ts`
 *
 * A same-frame drag measures its candidates once because nothing it does can
 * move them (`canvasDragSession.ts`'s own doc). The board-wide layer obeys the
 * same rule one level up: every registered frame's CLIENT RECT is measured
 * once at `beginDrag` and re-measured only when something that can actually
 * move it has moved —
 *
 *  - the canvas transform (a pan, a zoom, an auto-pan under a stationary
 *    pointer), compared against the LIVE `transformRef`, never the store's
 *    debounced commit values;
 *  - the registry's own version, because auto-panning to the board's edge
 *    genuinely mounts frames that did not exist when the gesture started.
 *
 * A frame's CANDIDATES are measured lazily, the first time the pointer enters
 * it, and then kept for the rest of the gesture. On a 12-frame board a drag
 * that never leaves its own frame therefore costs exactly nothing here beyond
 * one rect per frame, once.
 *
 * ## Read phase only
 *
 * Nothing in this module writes a style or touches a drag layer. The session
 * calls it inside its rAF's READ half and paints afterwards — the same
 * read-then-write split the overlay positioning already enforces, for the same
 * reason (interleaving them is layout thrash).
 *
 * ## `pageId`, not `frameId`
 *
 * Two frames can render the same page (a "duplicate as variant" sibling). A
 * drop between those two is an ordinary same-file reparent and must keep going
 * through the existing move path, so the "is this foreign?" test compares PAGE
 * ids. A frame with no page id at all (a CMS breakpoint frame, a live frame)
 * is never foreign, because there is no second file for a drop to write into.
 */
import type { NodeTree, PageNode } from '@core/page-tree'
import { buildFrameCandidateIndex, refreshFrameCandidateIndex, type ClientPoint, type FrameCandidateIndex } from './canvasDragSession'
import {
  canvasDropSurfaceVersion,
  listCanvasDropSurfaces,
  type CanvasDropSurface,
} from './canvasDropSurfaceRegistry'
import type { CanvasTransform } from './math'

interface SurfaceRect {
  surface: CanvasDropSurface
  left: number
  top: number
  right: number
  bottom: number
}

/** Every mounted frame's client rect, and the two inputs that invalidate them. */
export interface BoardDropSurfaces {
  rects: SurfaceRect[]
  version: number
  transform: CanvasTransform | null
}

/** One foreign frame the pointer has entered, with everything a drop there needs. */
export interface ForeignFrameDrop {
  surface: CanvasDropSurface
  pageId: string
  /** The destination page's tree, read once on entry. */
  tree: NodeTree<PageNode>
  /** That frame's candidates, in ITS OWN frame space — so nothing needs converting. */
  index: FrameCandidateIndex
}

/** Measure every registered frame's client rect. The one layout read this module makes. */
export function measureBoardDropSurfaces(transform: CanvasTransform | null): BoardDropSurfaces {
  const rects: SurfaceRect[] = []
  for (const surface of listCanvasDropSurfaces()) {
    const rect = surface.viewport.getBoundingClientRect()
    // A frame mid-mount can report a zero box; including it would make
    // `surfaceAtPoint` match nothing and cost a rect every frame anyway.
    if (rect.width <= 0 || rect.height <= 0) continue
    rects.push({ surface, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom })
  }
  return { rects, version: canvasDropSurfaceVersion(), transform: transform ? { ...transform } : null }
}

/**
 * Bring `board` up to date with whatever has actually changed, and nothing
 * else. A no-op in the common case — a pointer moving over a still board on a
 * still canvas costs zero layout reads here.
 */
export function refreshBoardDropSurfaces(
  board: BoardDropSurfaces,
  transform: CanvasTransform | null,
): BoardDropSurfaces {
  if (board.version !== canvasDropSurfaceVersion()) return measureBoardDropSurfaces(transform)
  if (transformMoved(board.transform, transform)) return measureBoardDropSurfaces(transform)
  return board
}

function transformMoved(previous: CanvasTransform | null, next: CanvasTransform | null): boolean {
  // Same reading `FrameCandidateIndex.transform` gives its own `null`: with no
  // live transform on either side there is nothing this comparison could catch.
  if (!previous || !next) return false
  return previous.zoom !== next.zoom || previous.panX !== next.panX || previous.panY !== next.panY
}

/**
 * The frame under `point` whose page differs from `originPageId`, or `null`.
 *
 * Last match wins, which is the honest reading when frames overlap: board
 * frames are freely positioned and can be dragged on top of one another, and
 * the one registered later is the one painted later, so it is the one the user
 * sees under the cursor.
 */
export function foreignSurfaceAtPoint(
  board: BoardDropSurfaces,
  point: ClientPoint,
  originPageId: string | null,
): CanvasDropSurface | null {
  let found: CanvasDropSurface | null = null
  for (const entry of board.rects) {
    const { surface } = entry
    if (!surface.pageId || surface.pageId === originPageId) continue
    if (point.x < entry.left || point.x > entry.right) continue
    if (point.y < entry.top || point.y > entry.bottom) continue
    found = surface
  }
  return found
}

/**
 * Keep `current` if the pointer is still inside the same foreign frame,
 * otherwise enter the new one (measuring its candidates once) or leave
 * entirely.
 *
 * `readPage` is the caller's store read, passed in rather than imported, so
 * this module stays testable without a composed store and so the session keeps
 * ONE place that touches `useEditorStore`.
 */
export function resolveForeignFrameDrop(
  board: BoardDropSurfaces,
  point: ClientPoint,
  originPageId: string | null,
  current: ForeignFrameDrop | null,
  transform: CanvasTransform | null,
  readPage: (pageId: string) => NodeTree<PageNode> | null,
): ForeignFrameDrop | null {
  const surface = foreignSurfaceAtPoint(board, point, originPageId)
  if (!surface || !surface.pageId) return null

  if (current && current.surface === surface) {
    refreshFrameCandidateIndex(current.index, surface.viewport, current.tree, surface.iframe, transform)
    return current
  }

  const tree = readPage(surface.pageId)
  if (!tree) return null

  return {
    surface,
    pageId: surface.pageId,
    tree,
    index: buildFrameCandidateIndex(surface.viewport, tree, surface.iframe, transform),
  }
}
