/**
 * D2 G3's board scan — the part of a cross-frame drag that runs on EVERY
 * animation frame, so the part whose cost is the whole design.
 *
 * Two invariants, both of them performance invariants with correctness
 * consequences:
 *
 *  - a still board on a still canvas re-measures NOTHING (the rects are
 *    constant for the length of the gesture, exactly like the candidate
 *    index's);
 *  - and yet it does re-measure on the two things that genuinely move them —
 *    the live transform (auto-pan moves the board under a stationary pointer)
 *    and a frame arriving or leaving (auto-panning to the edge mounts frames
 *    that did not exist when the gesture started).
 *
 * Getting the first wrong costs a rect per frame per frame; getting the second
 * wrong drops the element one frame off, or into a frame that is no longer
 * there.
 */
import { describe, it, expect, afterEach } from 'bun:test'
import {
  foreignSurfaceAtPoint,
  measureBoardDropSurfaces,
  refreshBoardDropSurfaces,
} from '@site/canvas/canvasDragBoard'
import {
  registerCanvasDropSurface,
  unregisterCanvasDropSurface,
} from '@site/canvas/canvasDropSurfaceRegistry'

const keys: object[] = []
let measurements = 0

function surface(pageId: string | null, box: { left: number; top: number; right: number; bottom: number }) {
  const viewport = document.createElement('div')
  viewport.getBoundingClientRect = () => {
    measurements += 1
    return {
      ...box,
      width: box.right - box.left,
      height: box.bottom - box.top,
      x: box.left,
      y: box.top,
    } as DOMRect
  }
  const key = {}
  keys.push(key)
  registerCanvasDropSurface(key, {
    frameId: pageId,
    pageId,
    viewport,
    iframe: null,
    dropLayer: () => null,
  })
  return viewport
}

afterEach(() => {
  for (const key of keys.splice(0)) unregisterCanvasDropSurface(key)
  measurements = 0
})

describe('measureBoardDropSurfaces / refreshBoardDropSurfaces', () => {
  it('measures every registered frame once and then nothing at all', () => {
    surface('home', { left: 0, top: 0, right: 500, bottom: 800 })
    surface('about', { left: 600, top: 0, right: 1100, bottom: 800 })

    const transform = { zoom: 1, panX: 0, panY: 0 }
    const board = measureBoardDropSurfaces(transform)
    expect(measurements).toBe(2)

    // Three frames of a still pointer on a still canvas.
    let current = board
    for (let i = 0; i < 3; i += 1) current = refreshBoardDropSurfaces(current, transform)
    expect(measurements).toBe(2)
    expect(current).toBe(board)
  })

  it('re-measures when the live transform moved — auto-pan slides the board under a still pointer', () => {
    surface('home', { left: 0, top: 0, right: 500, bottom: 800 })
    const board = measureBoardDropSurfaces({ zoom: 1, panX: 0, panY: 0 })
    expect(measurements).toBe(1)

    const next = refreshBoardDropSurfaces(board, { zoom: 1, panX: -40, panY: 0 })
    expect(measurements).toBe(2)
    expect(next).not.toBe(board)
  })

  it('re-measures when a frame arrives mid-gesture', () => {
    surface('home', { left: 0, top: 0, right: 500, bottom: 800 })
    const transform = { zoom: 1, panX: 0, panY: 0 }
    const board = measureBoardDropSurfaces(transform)
    expect(measurements).toBe(1)

    surface('about', { left: 600, top: 0, right: 1100, bottom: 800 })
    const next = refreshBoardDropSurfaces(board, transform)
    expect(measurements).toBe(3) // both frames re-measured
    expect(next.rects).toHaveLength(2)
  })

  it('skips a frame reporting a zero box — a mount in flight is not a drop target', () => {
    surface('home', { left: 0, top: 0, right: 0, bottom: 0 })
    expect(measureBoardDropSurfaces(null).rects).toHaveLength(0)
  })
})

describe('foreignSurfaceAtPoint', () => {
  it('finds the frame under the pointer when its page differs', () => {
    surface('home', { left: 0, top: 0, right: 500, bottom: 800 })
    surface('about', { left: 600, top: 0, right: 1100, bottom: 800 })
    const board = measureBoardDropSurfaces(null)

    expect(foreignSurfaceAtPoint(board, { x: 700, y: 100 }, 'home')?.pageId).toBe('about')
  })

  it('ignores a frame showing the SAME page — that is an ordinary reparent', () => {
    surface('home', { left: 600, top: 0, right: 1100, bottom: 800 })
    const board = measureBoardDropSurfaces(null)

    expect(foreignSurfaceAtPoint(board, { x: 700, y: 100 }, 'home')).toBeNull()
  })

  it('ignores a frame with no page of its own', () => {
    surface(null, { left: 600, top: 0, right: 1100, bottom: 800 })
    const board = measureBoardDropSurfaces(null)

    expect(foreignSurfaceAtPoint(board, { x: 700, y: 100 }, 'home')).toBeNull()
  })

  it('returns nothing over the empty board between frames', () => {
    surface('about', { left: 600, top: 0, right: 1100, bottom: 800 })
    const board = measureBoardDropSurfaces(null)

    expect(foreignSurfaceAtPoint(board, { x: 550, y: 100 }, 'home')).toBeNull()
  })

  it('picks the LAST registered frame when two overlap — the one painted on top', () => {
    surface('about', { left: 600, top: 0, right: 1100, bottom: 800 })
    surface('contact', { left: 650, top: 0, right: 1150, bottom: 800 })
    const board = measureBoardDropSurfaces(null)

    expect(foreignSurfaceAtPoint(board, { x: 700, y: 100 }, 'home')?.pageId).toBe('contact')
  })
})
