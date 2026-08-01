/**
 * boardBulkFrameActions — WS-7.2's bulk frame actions (set size, apply width
 * to all, fit-height, align, distribute, tidy), as PURE `Board -> Board | null`
 * transforms. Split out of `boardSlice.ts` (which stays the thin `set`/`get`
 * wiring) purely to stay under the module-size-budget ceiling — same
 * reasoning `tokenExtractTailwind.ts`/`colorSchemeDetect.ts` give for their
 * own splits.
 *
 * WS-10 Phase 2 — `selectedFrameIds` (the input to every function here) is
 * PAGE-id-keyed, not frame-id-keyed (a deliberate, documented scope boundary
 * — see `boardSlice.ts`'s module doc). `firstFrameForPage` is therefore the
 * resolution every function uses: the first frame matching a selected page
 * id. For a board with no duplicated variants this is exact; once a page has
 * a "duplicate as variant" sibling, a bulk action here still only reaches the
 * first one — the single-frame path (drag, resize handles, `FrameSizePanel`,
 * duplicate, remove) is what stays fully frame-id-precise.
 *
 * Each function returns `null` for "nothing to do" so `boardSlice.ts` can
 * skip the `set()` call entirely rather than flipping `boardsDirty` for a
 * no-op.
 */
import {
  moveFrame,
  resizeFrame,
  defaultFramePosition,
  FRAME_WIDTH,
  FRAME_HEIGHT,
  type Board,
} from '@core/studio-board'
import { alignFrames, distributeFrames, type AlignableFrame, type FrameAlignEdge } from '@site/canvas/BoardFramesLayer/frameAlign'

/** First frame matching `pageId` on `board` — see this module's doc for why "first match" is the accepted resolution. */
export function firstFrameForPage(board: Board, pageId: string) {
  return board.frames.find((f) => f.pageId === pageId)
}

export function setSelectedFramesSize(
  board: Board,
  selectedFrameIds: string[],
  width: number | null,
  height: number | null,
): Board | null {
  if (selectedFrameIds.length === 0) return null
  let nextBoard = board
  for (const pageId of selectedFrameIds) {
    const frame = firstFrameForPage(nextBoard, pageId)
    if (!frame) continue
    const w = width ?? frame.width ?? FRAME_WIDTH
    const h = height ?? frame.height ?? FRAME_HEIGHT
    nextBoard = resizeFrame(nextBoard, frame.id, w, h)
  }
  return nextBoard
}

export function applyWidthToAllFrames(board: Board, width: number): Board | null {
  if (board.frames.length === 0) return null
  let nextBoard = board
  for (const frame of board.frames) {
    // Preserve each frame's own height (explicit, or the shared default made
    // explicit) — only width is the "apply to all pages" ask.
    nextBoard = resizeFrame(nextBoard, frame.id, width, frame.height ?? FRAME_HEIGHT)
  }
  return nextBoard
}

export function setFrameHeights(board: Board, heightsByPageId: Record<string, number>): Board | null {
  let nextBoard = board
  let changed = false
  for (const [pageId, height] of Object.entries(heightsByPageId)) {
    const frame = firstFrameForPage(nextBoard, pageId)
    if (!frame || !Number.isFinite(height) || height <= 0) continue
    nextBoard = resizeFrame(nextBoard, frame.id, frame.width ?? FRAME_WIDTH, height)
    changed = true
  }
  return changed ? nextBoard : null
}

export function alignSelectedFrames(board: Board, selectedFrameIds: string[], edge: FrameAlignEdge): Board | null {
  if (selectedFrameIds.length < 2) return null
  // `AlignableFrame.pageId` is a generic key field in this pure geometry
  // helper — passing the frame's own `id` through it (not literally its page
  // id) is what lets two variant frames of one page be aligned independently.
  const rects: AlignableFrame[] = []
  for (const pageId of selectedFrameIds) {
    const frame = firstFrameForPage(board, pageId)
    if (frame) rects.push({ pageId: frame.id, x: frame.x, y: frame.y, width: frame.width ?? FRAME_WIDTH, height: frame.height ?? FRAME_HEIGHT })
  }
  if (rects.length < 2) return null
  const positions = alignFrames(rects, edge)
  let nextBoard = board
  for (const [frameId, pos] of positions) nextBoard = moveFrame(nextBoard, frameId, pos.x, pos.y)
  return nextBoard
}

export function distributeSelectedFrames(board: Board, selectedFrameIds: string[], axis: 'horizontal' | 'vertical'): Board | null {
  if (selectedFrameIds.length < 3) return null
  const rects: AlignableFrame[] = []
  for (const pageId of selectedFrameIds) {
    const frame = firstFrameForPage(board, pageId)
    if (frame) rects.push({ pageId: frame.id, x: frame.x, y: frame.y, width: frame.width ?? FRAME_WIDTH, height: frame.height ?? FRAME_HEIGHT })
  }
  const positions = distributeFrames(rects, axis)
  if (positions.size === 0) return null
  let nextBoard = board
  for (const [frameId, pos] of positions) nextBoard = moveFrame(nextBoard, frameId, pos.x, pos.y)
  return nextBoard
}

export function tidySelectedFrames(board: Board, selectedFrameIds: string[]): Board | null {
  if (selectedFrameIds.length === 0) return null
  let nextBoard = board
  let index = 0
  for (const pageId of selectedFrameIds) {
    const frame = firstFrameForPage(nextBoard, pageId)
    if (!frame) continue
    const { x, y } = defaultFramePosition(index)
    nextBoard = moveFrame(nextBoard, frame.id, x, y)
    index += 1
  }
  return nextBoard
}
