/**
 * P5-F — the snap vocabulary beyond alignment: equal spacing and its pills
 * (IX-5d), ruler guides in a frame's space (IX-5c), the two toggles (IX-5e)
 * and the Shift axis lock. All pure: `snapSpacing.ts`, `boardSnapping.ts`,
 * `canvasSnapPeers.ts`.
 */
import { describe, expect, it } from 'bun:test'
import {
  computeSnap,
  snapBoardFurniture,
  snapSourcesFor,
  type SnapRect,
} from '@site/canvas/boardSnapping'
import { findSpacingSnap, formatSpacing, spacingSegments } from '@site/canvas/snapSpacing'
import { guideLinesInSpace } from '@site/canvas/canvasSnapPeers'
import { DEFAULT_SNAP_PREFERENCES } from '@site/canvas/snapPreferences'
import { createBoard } from '@core/studio-board'

const T = 8

/** Three cards in a row, 20 px apart: [0,100] [120,220] and a third dragged in. */
const A: SnapRect = { x: 0, y: 0, width: 100, height: 50 }
const B: SnapRect = { x: 120, y: 0, width: 100, height: 50 }

describe('IX-5d — equal spacing snap', () => {
  it('snaps the gap after the right-most card to the gap the row already has', () => {
    // Dropped 4 px short of a 20 px gap after B.
    const dragged: SnapRect = { x: 236, y: 5, width: 60, height: 40 }
    expect(findSpacingSnap('x', dragged, [A, B], T)).toEqual({ start: 240, distance: 4 })
    const result = computeSnap(dragged, [A, B], T)
    expect(result.x).toBe(240)
    // No alignment guide for a spacing snap — the pills explain it.
    expect(result.guides.filter((g) => g.axis === 'x')).toEqual([])
  })

  it('snaps before the left-most card too', () => {
    const dragged: SnapRect = { x: -83, y: 0, width: 60, height: 50 }
    // A starts at 0; a 20 px gap puts the dragged right edge at -20, so x = -80.
    expect(findSpacingSnap('x', dragged, [A, B], T)?.start).toBe(-80)
  })

  it('centres between two neighbours: equal gaps on both sides', () => {
    const left: SnapRect = { x: 0, y: 0, width: 100, height: 50 }
    const right: SnapRect = { x: 300, y: 0, width: 100, height: 50 }
    // Room 200, width 80 → 60 px each side → x = 160.
    const dragged: SnapRect = { x: 157, y: 0, width: 80, height: 50 }
    expect(computeSnap(dragged, [left, right], T).x).toBe(160)
  })

  it('ignores peers that do not share the row', () => {
    const far: SnapRect = { x: 400, y: 500, width: 100, height: 50 }
    expect(findSpacingSnap('x', { x: 236, y: 0, width: 60, height: 50 }, [far], T)).toBeNull()
  })

  it('does not snap outside the threshold', () => {
    expect(findSpacingSnap('x', { x: 250, y: 0, width: 60, height: 50 }, [A, B], T)).toBeNull()
  })

  it('works on the y axis (a column)', () => {
    const top: SnapRect = { x: 0, y: 0, width: 100, height: 40 }
    const mid: SnapRect = { x: 0, y: 56, width: 100, height: 40 }
    const dragged: SnapRect = { x: 10, y: 115, width: 80, height: 40 }
    expect(computeSnap(dragged, [top, mid], T).y).toBe(112)
  })

  it('a closer alignment snap wins over a spacing snap', () => {
    // A peer whose left edge is 1 px from the dragged left edge beats the 4 px spacing snap.
    const below: SnapRect = { x: 237, y: 400, width: 10, height: 10 }
    expect(computeSnap({ x: 236, y: 5, width: 60, height: 40 }, [A, B, below], T).x).toBe(237)
  })
})

describe('IX-5d — the pills describe where the rect ends up', () => {
  it('equal gaps are drawn: the row gap and the new one', () => {
    const segments = spacingSegments({ x: 240, y: 0, width: 60, height: 50 }, [A, B])
    expect(segments).toEqual([
      { axis: 'x', from: 220, to: 240, at: 25, value: 20 },
      { axis: 'x', from: 100, to: 120, at: 25, value: 20 },
    ])
  })

  it('an unequal gap draws nothing', () => {
    expect(spacingSegments({ x: 250, y: 0, width: 60, height: 50 }, [A, B])).toEqual([])
  })

  it('centred between two: both of its own gaps', () => {
    const left: SnapRect = { x: 0, y: 0, width: 100, height: 50 }
    const right: SnapRect = { x: 300, y: 0, width: 100, height: 50 }
    const segments = spacingSegments({ x: 160, y: 0, width: 80, height: 50 }, [left, right])
    expect(segments.map((s) => [s.from, s.to])).toEqual([[100, 160], [240, 300]])
  })

  it('computeSnap returns them, and none when spacing is off', () => {
    const dragged: SnapRect = { x: 238, y: 0, width: 60, height: 50 }
    expect(computeSnap(dragged, [A, B], T).spacings).toHaveLength(2)
    expect(computeSnap(dragged, [A, B], T, { spacing: false })).toEqual({ x: 238, y: 0, guides: expect.any(Array), spacings: [] })
  })

  it('the pill number is whole px, or one decimal', () => {
    expect(formatSpacing(20)).toBe('20')
    expect(formatSpacing(19.96)).toBe('20')
    expect(formatSpacing(12.34)).toBe('12.3')
  })
})

describe('Shift axis lock — the held axis never snaps', () => {
  it('leaves y exactly where the constraint put it', () => {
    const peer: SnapRect = { x: 500, y: 103, width: 40, height: 40 }
    const dragged: SnapRect = { x: 200, y: 100, width: 40, height: 40 }
    expect(computeSnap(dragged, [peer], T).y).toBe(103)
    expect(computeSnap(dragged, [peer], T, { lockedAxis: 'y' }).y).toBe(100)
  })
})

describe('IX-5e — the toggles', () => {
  const peers = [A, B]
  const lines = [{ axis: 'x' as const, position: 500 }]

  it('both on: everything is offered', () => {
    const sources = snapSourcesFor(DEFAULT_SNAP_PREFERENCES, peers, lines)
    expect(sources.peers).toBe(peers)
    expect(sources.options).toEqual({ lines, spacing: true })
  })

  it('objects off: no peers and no spacing, guides still pull', () => {
    const sources = snapSourcesFor({ objects: false, guides: true }, peers, lines)
    expect(sources.peers).toEqual([])
    const result = computeSnap({ x: 497, y: 0, width: 40, height: 10 }, sources.peers, T, sources.options)
    expect(result.x).toBe(500)
    expect(computeSnap({ x: 236, y: 5, width: 60, height: 40 }, sources.peers, T, sources.options).x).toBe(236)
  })

  it('guides off: the ruler guide no longer pulls', () => {
    const sources = snapSourcesFor({ objects: true, guides: false }, peers, lines)
    expect(computeSnap({ x: 496, y: 300, width: 10, height: 10 }, sources.peers, T, sources.options).x).toBe(496)
  })

  it('board furniture snaps to the ruler guides through one entry, and the toggle turns it off', () => {
    const board = createBoard('b1', 'Board')
    board.guides = [{ id: 'g1', axis: 'x', position: 1000 }]
    const rect = { x: 1004, y: 5000, width: 200, height: 100 }
    const on = snapBoardFurniture({ board, dragged: { kind: 'note', id: 'n' }, rect, preferences: DEFAULT_SNAP_PREFERENCES, zoom: 1 })
    expect(on.x).toBe(1000)
    const off = snapBoardFurniture({ board, dragged: { kind: 'note', id: 'n' }, rect, preferences: { objects: true, guides: false }, zoom: 1 })
    expect(off.x).toBe(1004)
  })
})

describe('IX-5c — a board guide in a frame\'s space', () => {
  it('goes through the screen: board origin and zoom, then the frame\'s origin and scale', () => {
    // Board (0,0) is on screen at (80, 60), zoom 2. The frame's (0,0) is at
    // screen (280, 160), drawn at the same zoom. A guide at board x = 150 is on
    // screen at 80 + 300 = 380, which is frame x (380 - 280) / 2 = 50.
    const lines = guideLinesInSpace(
      [{ axis: 'x', position: 150 }, { axis: 'y', position: 100 }],
      { originX: 80, originY: 60, scale: 2 },
      { originX: 280, originY: 160, scale: 2 },
    )
    expect(lines).toEqual([
      { axis: 'x', position: 50 },
      { axis: 'y', position: 50 },
    ])
  })
})
