import { describe, expect, it } from 'bun:test'
import { computeZoomToFitTransform } from '@site/canvas/canvasZoomFit'
import { MAX_ZOOM, MIN_ZOOM } from '@site/canvas/math'

const IDENTITY = { zoom: 1, panX: 0, panY: 0 }

describe('computeZoomToFitTransform', () => {
  it('returns null for an empty rect list', () => {
    expect(computeZoomToFitTransform({ width: 1000, height: 800 }, [], IDENTITY)).toBeNull()
  })

  it('returns null for a single degenerate (0x0) rect', () => {
    const rects = [{ left: 100, top: 100, width: 0, height: 0 }]
    expect(computeZoomToFitTransform({ width: 1000, height: 800 }, rects, IDENTITY)).toBeNull()
  })

  it('fits a single rect smaller than the viewport by growing zoom, centered', () => {
    // Board-space rect at (0,0) 200x100 (screen == board at zoom 1).
    const rects = [{ left: 0, top: 0, width: 200, height: 100 }]
    const result = computeZoomToFitTransform({ width: 1000, height: 800 }, rects, IDENTITY, 0)
    expect(result).not.toBeNull()
    // width ratio 1000/200=5, height ratio 800/100=8 -> min is 5, clamped to MAX_ZOOM.
    expect(result!.zoom).toBe(Math.min(5, MAX_ZOOM))
    // Board center (100,50) must land on viewport center (500,400).
    expect(result!.panX).toBeCloseTo(500 - 100 * result!.zoom, 5)
    expect(result!.panY).toBeCloseTo(400 - 50 * result!.zoom, 5)
  })

  it('fits a rect larger than the viewport by shrinking zoom', () => {
    const rects = [{ left: 0, top: 0, width: 4000, height: 2000 }]
    const result = computeZoomToFitTransform({ width: 1000, height: 800 }, rects, IDENTITY, 0)
    expect(result).not.toBeNull()
    // width ratio 1000/4000=0.25, height ratio 800/2000=0.4 -> min is 0.25.
    expect(result!.zoom).toBeCloseTo(0.25, 5)
  })

  it('unions multiple rects before fitting', () => {
    const rects = [
      { left: 0, top: 0, width: 100, height: 100 },
      { left: 900, top: 700, width: 100, height: 100 },
    ]
    // Union board-space bbox: (0,0) to (1000,800) -> 1000x800.
    const result = computeZoomToFitTransform({ width: 1000, height: 800 }, rects, IDENTITY, 0)
    expect(result).not.toBeNull()
    expect(result!.zoom).toBeCloseTo(1, 5)
  })

  it('un-scales screen-space rects by the CURRENT zoom before fitting (idempotent regardless of starting zoom)', () => {
    // At zoom 2, a board-space 200x100 rect at board origin renders on screen
    // as 400x200 at (0,0) with panX=panY=0.
    const current = { zoom: 2, panX: 0, panY: 0 }
    const rects = [{ left: 0, top: 0, width: 400, height: 200 }]
    const result = computeZoomToFitTransform({ width: 1000, height: 800 }, rects, current, 0)
    // Same board-space answer as the zoom=1 case above.
    expect(result!.zoom).toBe(Math.min(5, MAX_ZOOM))
  })

  it('clamps to MIN_ZOOM for a very large rect', () => {
    const rects = [{ left: 0, top: 0, width: 1_000_000, height: 1_000_000 }]
    const result = computeZoomToFitTransform({ width: 1000, height: 800 }, rects, IDENTITY, 0)
    expect(result!.zoom).toBe(MIN_ZOOM)
  })

  it('respects padding by shrinking the available viewport', () => {
    // Large enough that neither the padded nor unpadded ratio clamps to
    // MAX_ZOOM, so the padding difference is actually observable.
    const rects = [{ left: 0, top: 0, width: 2000, height: 1600 }]
    const withoutPadding = computeZoomToFitTransform({ width: 1000, height: 800 }, rects, IDENTITY, 0)
    const withPadding = computeZoomToFitTransform({ width: 1000, height: 800 }, rects, IDENTITY, 100)
    expect(withPadding!.zoom).toBeLessThan(withoutPadding!.zoom)
  })
})
