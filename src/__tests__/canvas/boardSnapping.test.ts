/**
 * boardSnapping.ts — pure function unit tests.
 *
 * @see src/admin/pages/site/canvas/boardSnapping.ts
 */
import { describe, it, expect } from 'bun:test'
import {
  computeSnap,
  collectPeerRects,
  rulerGuideLines,
  SNAP_THRESHOLD_SCREEN_PX,
  snapThresholdAtZoom,
  type SnapRect,
} from '@site/canvas/boardSnapping'
import { createBoard, type BoardGuide } from '@core/studio-board'

const THRESHOLD = 8

describe('computeSnap', () => {
  it('does not snap when there are no peers', () => {
    const dragged: SnapRect = { x: 100, y: 100, width: 50, height: 50 }
    const result = computeSnap(dragged, [], THRESHOLD)
    expect(result).toEqual({ x: 100, y: 100, guides: [], spacings: [] })
  })

  it('snaps the dragged left edge to a peer left edge within threshold', () => {
    const dragged: SnapRect = { x: 104, y: 300, width: 50, height: 50 }
    const peer: SnapRect = { x: 100, y: 0, width: 50, height: 50 }
    const result = computeSnap(dragged, [peer], THRESHOLD)

    expect(result.x).toBe(100)
    expect(result.y).toBe(300) // y axis had no match — untouched
    expect(result.guides).toHaveLength(1)
    expect(result.guides[0]).toEqual({
      axis: 'x',
      position: 100,
      start: 0, // peer.y
      end: 350, // dragged.y + dragged.height
    })
  })

  it('snaps the dragged center to a peer center', () => {
    // dragged center = 100 + 25 = 125. Peer is wider (100) so its left edge
    // (79) is far from dragged's, but its center (79 + 50 = 129) is close —
    // this isolates a genuine center-to-center match (not a same-offset
    // left-edge match that would also happen to look like a center match).
    const dragged: SnapRect = { x: 100, y: 0, width: 50, height: 50 }
    const peer: SnapRect = { x: 79, y: 0, width: 100, height: 50 }
    const result = computeSnap(dragged, [peer], THRESHOLD)

    expect(result.x + 25).toBe(129) // dragged center now equals peer center
    expect(result.guides[0].position).toBe(129)
  })

  it('snaps both axes independently when both are within threshold', () => {
    const dragged: SnapRect = { x: 105, y: 202, width: 50, height: 50 }
    const peer: SnapRect = { x: 100, y: 200, width: 50, height: 50 }
    const result = computeSnap(dragged, [peer], THRESHOLD)

    expect(result.x).toBe(100)
    expect(result.y).toBe(200)
    expect(result.guides).toHaveLength(2)
    expect(result.guides.map((g) => g.axis).sort()).toEqual(['x', 'y'])
  })

  it('does not snap when just outside the threshold', () => {
    const dragged: SnapRect = { x: 100 + THRESHOLD + 5, y: 0, width: 50, height: 50 }
    const peer: SnapRect = { x: 100, y: 500, width: 50, height: 50 }
    const result = computeSnap(dragged, [peer], THRESHOLD)

    expect(result.x).toBe(dragged.x)
    expect(result.y).toBe(dragged.y)
    expect(result.guides).toHaveLength(0)
  })

  it('picks the closest of several candidate alignments', () => {
    const dragged: SnapRect = { x: 106, y: 0, width: 50, height: 50 }
    const farPeer: SnapRect = { x: 100, y: 900, width: 50, height: 50 } // |106-100| = 6
    const closePeer: SnapRect = { x: 104, y: 100, width: 50, height: 50 } // |106-104| = 2
    const result = computeSnap(dragged, [farPeer, closePeer], THRESHOLD)

    // closePeer (distance 2) wins over farPeer (distance 6).
    expect(result.x).toBe(104)
    expect(result.guides[0].position).toBe(104)
    expect(result.guides[0].start).toBe(0) // min(dragged.y=0, closePeer.y=100)
    expect(result.guides[0].end).toBe(150) // max(dragged.y+height=50, closePeer.y+height=150)
  })

  it('emits a guide spanning the union of dragged and matched-peer extents', () => {
    const dragged: SnapRect = { x: 100, y: 500, width: 50, height: 50 }
    const peer: SnapRect = { x: 100, y: 0, width: 50, height: 200 }
    const result = computeSnap(dragged, [peer], THRESHOLD)

    expect(result.guides[0]).toEqual({
      axis: 'x',
      position: 100,
      start: 0, // min(dragged.y=500, peer.y=0)
      end: 550, // max(dragged.y+height=550, peer.y+height=200)
    })
  })

  it('exposes a sensible positive default threshold', () => {
    expect(SNAP_THRESHOLD_SCREEN_PX).toBeGreaterThan(0)
  })

  it('IX-5a: the threshold is screen px — rect units scale with 1 / zoom', () => {
    expect(snapThresholdAtZoom(1)).toBe(SNAP_THRESHOLD_SCREEN_PX)
    expect(snapThresholdAtZoom(0.5)).toBe(SNAP_THRESHOLD_SCREEN_PX * 2)
    expect(snapThresholdAtZoom(4)).toBe(SNAP_THRESHOLD_SCREEN_PX / 4)
    // An unreadable zoom is 100%, never an infinite pull.
    expect(snapThresholdAtZoom(0)).toBe(SNAP_THRESHOLD_SCREEN_PX)
    expect(snapThresholdAtZoom(Number.NaN)).toBe(SNAP_THRESHOLD_SCREEN_PX)
  })
})

describe('collectPeerRects', () => {
  it('flattens frames, notes, and docs into rects', () => {
    const board = {
      ...createBoard('b1', 'Board 1'),
      frames: [{ pageId: 'home', x: 0, y: 0, width: 1024, height: 800 }],
      notes: [{ id: 'n1', x: 10, y: 10, w: 180, h: 120, text: '', color: 'yellow' as const }],
      docs: [{ id: 'd1', x: 20, y: 20, w: 320, h: 200, markdown: '' }],
    }

    const rects = collectPeerRects(board, { kind: 'frame', pageId: 'nonexistent' })

    expect(rects).toEqual([
      { x: 0, y: 0, width: 1024, height: 800 },
      { x: 10, y: 10, width: 180, height: 120 },
      { x: 20, y: 20, width: 320, height: 200 },
    ])
  })

  it('excludes the dragged frame by pageId', () => {
    const board = {
      ...createBoard('b1', 'Board 1'),
      frames: [
        { pageId: 'home', x: 0, y: 0 },
        { pageId: 'about', x: 200, y: 0 },
      ],
    }

    const rects = collectPeerRects(board, { kind: 'frame', pageId: 'home' })

    expect(rects).toEqual([{ x: 200, y: 0, width: 1024, height: 800 }])
  })

  it('falls back to FRAME_WIDTH/FRAME_HEIGHT for frames without a saved size', () => {
    const board = {
      ...createBoard('b1', 'Board 1'),
      frames: [{ pageId: 'home', x: 0, y: 0 }],
    }

    const rects = collectPeerRects(board, { kind: 'frame', pageId: 'other' })

    expect(rects[0].width).toBe(1024)
    expect(rects[0].height).toBe(800)
  })

  it('excludes the dragged note by id', () => {
    const board = {
      ...createBoard('b1', 'Board 1'),
      notes: [
        { id: 'n1', x: 0, y: 0, w: 180, h: 120, text: '', color: 'yellow' as const },
        { id: 'n2', x: 200, y: 0, w: 180, h: 120, text: '', color: 'blue' as const },
      ],
    }

    const rects = collectPeerRects(board, { kind: 'note', id: 'n1' })

    expect(rects).toEqual([{ x: 200, y: 0, width: 180, height: 120 }])
  })

  it('excludes the dragged doc by id', () => {
    const board = {
      ...createBoard('b1', 'Board 1'),
      docs: [
        { id: 'd1', x: 0, y: 0, w: 320, h: 200, markdown: '' },
        { id: 'd2', x: 400, y: 0, w: 320, h: 200, markdown: '' },
      ],
    }

    const rects = collectPeerRects(board, { kind: 'doc', id: 'd1' })

    expect(rects).toEqual([{ x: 400, y: 0, width: 320, height: 200 }])
  })
})

describe('rulerGuideLines + computeSnap lines (D1, P5-F IX-5c)', () => {
  it('returns [] for no guides', () => {
    expect(rulerGuideLines([])).toEqual([])
  })

  it('keeps each guide on its own axis at its own board position', () => {
    const guides: BoardGuide[] = [
      { id: 'g1', axis: 'x', position: 320 },
      { id: 'g2', axis: 'y', position: -80 },
    ]
    expect(rulerGuideLines(guides)).toEqual([
      { axis: 'x', position: 320 },
      { axis: 'y', position: -80 },
    ])
  })

  it('an x-axis guide is a real snap target on the x axis, and draws along the dragged extent', () => {
    const lines = rulerGuideLines([{ id: 'g1', axis: 'x', position: 100 }])
    const dragged: SnapRect = { x: 104, y: 300, width: 50, height: 50 }
    const result = computeSnap(dragged, [], THRESHOLD, { lines })
    expect(result.x).toBe(100)
    expect(result.y).toBe(300)
    expect(result.guides).toEqual([{ axis: 'x', position: 100, start: 300, end: 350 }])
  })

  it('an x-axis guide never matches on the y axis', () => {
    const lines = rulerGuideLines([{ id: 'g1', axis: 'x', position: 100 }])
    const dragged: SnapRect = { x: 400, y: 98, width: 50, height: 50 }
    const result = computeSnap(dragged, [], THRESHOLD, { lines })
    expect(result).toEqual({ x: 400, y: 98, guides: [], spacings: [] })
  })

  it('the right edge or the centre can land on a guide too', () => {
    const lines = rulerGuideLines([{ id: 'g1', axis: 'x', position: 200 }])
    expect(computeSnap({ x: 147, y: 0, width: 50, height: 10 }, [], THRESHOLD, { lines }).x).toBe(150)
    expect(computeSnap({ x: 172, y: 0, width: 50, height: 10 }, [], THRESHOLD, { lines }).x).toBe(175)
  })
})
