import type { Board, BoardFrame } from './types'
import { FRAME_HEADER_HEIGHT, FRAME_HEIGHT, FRAME_WIDTH, VARIANT_GAP } from './frameGrid'

interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** A frame's footprint on the board: its box plus the header strip drawn above it. */
function frameFootprint(frame: BoardFrame): Box {
  return {
    x: frame.x,
    y: frame.y - FRAME_HEADER_HEIGHT,
    w: frame.width ?? FRAME_WIDTH,
    h: (frame.height ?? FRAME_HEIGHT) + FRAME_HEADER_HEIGHT,
  }
}

/** Every box on the board a new frame must not land on: frames, sticky notes and doc cards. */
function occupiedBoxes(board: Board): Box[] {
  return [
    ...board.frames.map(frameFootprint),
    ...board.notes.map((note) => ({ x: note.x, y: note.y, w: note.w, h: note.h })),
    ...board.docs.map((doc) => ({ x: doc.x, y: doc.y, w: doc.w, h: doc.h })),
  ]
}

const overlaps = (a: Box, b: Box): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

/**
 * Where a copy of `source` goes: on the source's row, to its right, in the
 * first spot that overlaps nothing on the board (Figma's duplicate). The
 * candidate starts one `VARIANT_GAP` past the source and, while something is
 * in the way, jumps to just past the thing it hit - so a second duplicate
 * lands beside the first rather than on it, and a source with a neighbour
 * close by clears that neighbour too.
 *
 * Pure and shared: the toolbar's store action and the MCP tool both place a
 * copy with it, so they cannot drift apart.
 */
export function freeSlotBeside(board: Board, source: BoardFrame): { x: number; y: number } {
  const size = { w: source.width ?? FRAME_WIDTH, h: (source.height ?? FRAME_HEIGHT) + FRAME_HEADER_HEIGHT }
  const top = source.y - FRAME_HEADER_HEIGHT
  const others = occupiedBoxes(board)
  let x = source.x + size.w + VARIANT_GAP
  for (;;) {
    const candidate: Box = { x, y: top, ...size }
    const hit = others.find((box) => overlaps(candidate, box))
    if (!hit) return { x, y: source.y }
    x = hit.x + hit.w + VARIANT_GAP
  }
}
