/**
 * Connector routing. Pure board-space maths, which is exactly why it can be
 * tested at all — happy-dom has no layout engine, so anything that measured a
 * real element here would be asserting on zeros.
 */
import { describe, it, expect } from 'bun:test'
import {
  controlOffset,
  facingSide,
  frameAtBoardPoint,
  handlePoint,
  oppositeSide,
  routeConnector,
  routeDraftConnector,
  routesBounds,
  type BoardRect,
} from '../connectorGeometry'

const button: BoardRect = { x: 100, y: 200, width: 120, height: 40 }

function frame(x: number, y: number): BoardRect {
  return { x, y, width: 390, height: 844 }
}

describe('facingSide', () => {
  it('points at the side the target actually lies on', () => {
    expect(facingSide(button, frame(900, 200))).toBe('right')
    expect(facingSide(button, frame(-900, 200))).toBe('left')
    expect(facingSide(button, frame(100, 2000))).toBe('bottom')
    expect(facingSide(button, frame(100, -2000))).toBe('top')
  })

  it('prefers horizontal on an exact tie, because boards are laid out in rows', () => {
    // Target centre exactly 500 right and 500 down of the button's centre.
    // A connector out of the BOTTOM here reads as pointing at a frame below,
    // and on a board laid out in rows that is almost never what was meant.
    const tied: BoardRect = { x: 465, y: 525, width: 390, height: 390 }
    expect(facingSide(button, tied)).toBe('right')
  })

  it('is its own inverse through oppositeSide', () => {
    for (const side of ['left', 'right', 'top', 'bottom'] as const) {
      expect(oppositeSide(oppositeSide(side))).toBe(side)
    }
  })
})

describe('routeConnector', () => {
  it('leaves the source edge and arrives at the facing target edge', () => {
    const route = routeConnector(button, frame(900, 200))
    expect(route.fromSide).toBe('right')
    expect(route.toSide).toBe('left')
    // Right edge of the button, vertically centred.
    expect(route.from).toEqual({ x: 220, y: 220 })
    // Left edge of the frame, vertically centred.
    expect(route.to).toEqual({ x: 900, y: 622 })
  })

  it('emits a cubic bezier, not a straight line', () => {
    const route = routeConnector(button, frame(900, 200))
    expect(route.path).toStartWith('M 220 220 C ')
    expect(route.path.split('C')).toHaveLength(2)
  })

  it('is unaffected by pan and zoom, because it never sees them', () => {
    // The whole performance argument: the layer is inside the transform, so a
    // pan changes nothing here. Shifting BOTH rects by the same amount is the
    // only thing that should move a connector.
    const a = routeConnector(button, frame(900, 200))
    const shifted = routeConnector(
      { ...button, x: button.x + 1000, y: button.y + 1000 },
      frame(1900, 1200),
    )
    expect(shifted.from).toEqual({ x: a.from.x + 1000, y: a.from.y + 1000 })
    expect(shifted.to).toEqual({ x: a.to.x + 1000, y: a.to.y + 1000 })
  })
})

describe('controlOffset', () => {
  it('scales with the gap so near and far links both read correctly', () => {
    expect(controlOffset(400)).toBeGreaterThan(controlOffset(100))
  })

  it('clamps at both ends — no degenerate corner, no board-crossing bow', () => {
    expect(controlOffset(1)).toBe(24)
    expect(controlOffset(100_000)).toBe(220)
  })

  it('ignores direction, so a leftward link curves like a rightward one', () => {
    expect(controlOffset(-400)).toBe(controlOffset(400))
  })
})

describe('routeDraftConnector', () => {
  it('routes to the bare cursor exactly as it will route to the frame it lands on', () => {
    const target = frame(900, 200)
    const draft = routeDraftConnector(button, { x: target.x, y: target.y })
    expect(draft.fromSide).toBe(routeConnector(button, target).fromSide)
    expect(draft.to).toEqual({ x: 900, y: 200 })
  })
})

describe('handlePoint', () => {
  it('sits on the middle of the element\'s right edge', () => {
    // No board-space gap: the handle's offset from the element is applied in
    // screen space by the stylesheet, so it survives zoom. See `handlePoint`.
    expect(handlePoint(button)).toEqual({ x: 220, y: 220 })
  })
})

describe('frameAtBoardPoint', () => {
  const frames = [frame(0, 0), frame(500, 0)]

  it('finds the frame under a point', () => {
    expect(frameAtBoardPoint(frames, { x: 600, y: 100 })).toBe(frames[1]!)
  })

  it('is null over empty board', () => {
    expect(frameAtBoardPoint(frames, { x: -50, y: 100 })).toBeNull()
  })

  it('takes the LAST frame when they overlap, matching paint order', () => {
    const stacked = [frame(0, 0), frame(10, 10)]
    expect(frameAtBoardPoint(stacked, { x: 100, y: 100 })).toBe(stacked[1]!)
  })
})

describe('routesBounds', () => {
  it('covers the curve, not just its endpoints', () => {
    // A box around the endpoints alone clips exactly the bow that makes a
    // connector readable.
    const route = routeConnector(button, frame(900, 200))
    const bounds = routesBounds([route])!
    const endpointsOnly = Math.min(route.from.x, route.to.x)
    expect(bounds.x).toBeLessThan(endpointsOnly)
  })

  it('is null with nothing to bound', () => {
    expect(routesBounds([])).toBeNull()
  })
})
