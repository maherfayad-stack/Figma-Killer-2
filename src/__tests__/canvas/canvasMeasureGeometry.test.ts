/**
 * K5 — the Alt-hover measurement math.
 *
 * This is the only layer of the feature that CAN be tested: the drawing half
 * lives inside a canvas iframe, and happy-dom has no layout engine, so every
 * rect it would produce is zero. The geometry is therefore a pure function
 * over numbers, and these cases are the ones that actually break a
 * measurement overlay — containment, partial overlap, disjoint boxes, exact
 * touching, and a selection that sticks out past the box it is measured
 * against.
 */
import { describe, expect, it } from 'bun:test'
import {
  formatMeasureDistance,
  measureBandMidpoint,
  measureContentBox,
  measurePaddingBands,
  measureRectDistances,
  measureSegmentMidpoint,
  measureSegmentRect,
  measurementWinsOverTreeLadder,
  parseMeasurePadding,
  type MeasureRect,
  type MeasureSegment,
  type MeasureSide,
} from '@site/canvas/canvasMeasureGeometry'

function rect(x: number, y: number, width: number, height: number): MeasureRect {
  return { x, y, width, height }
}

function bySide(segments: readonly MeasureSegment[]): Record<string, MeasureSegment> {
  return Object.fromEntries(segments.map((segment) => [segment.side, segment]))
}

function sides(segments: readonly MeasureSegment[]): MeasureSide[] {
  return segments.map((segment) => segment.side)
}

describe('measureRectDistances — containment (the common Figma case)', () => {
  // A 100×40 selection sitting inside a 300×200 container at (50, 30).
  const selection = rect(50, 30, 100, 40)
  const hovered = rect(0, 0, 300, 200)

  it('produces all four insets, each measured from the selection edge to the same-side container edge', () => {
    const segments = measureRectDistances(selection, hovered)
    expect(sides(segments).sort()).toEqual(['bottom', 'left', 'right', 'top'])
    const map = bySide(segments)
    expect(map.left!.distance).toBe(50)
    expect(map.right!.distance).toBe(150)
    expect(map.top!.distance).toBe(30)
    expect(map.bottom!.distance).toBe(130)
    for (const segment of segments) expect(segment.gap).toBe(false)
  })

  it('draws the horizontal pair through the vertical overlap centre and vice versa', () => {
    const map = bySide(measureRectDistances(selection, hovered))
    // Vertical overlap is the selection's own band (30 → 70): centre 50.
    expect(map.left!.y1).toBe(50)
    expect(map.left!.y2).toBe(50)
    expect(map.right!.y1).toBe(50)
    // Horizontal overlap is 50 → 150: centre 100.
    expect(map.top!.x1).toBe(100)
    expect(map.bottom!.x1).toBe(100)
  })

  it('anchors each segment on the selection edge and ends it on the container edge', () => {
    const map = bySide(measureRectDistances(selection, hovered))
    expect([map.left!.x1, map.left!.x2]).toEqual([50, 0])
    expect([map.right!.x1, map.right!.x2]).toEqual([150, 300])
    expect([map.top!.y1, map.top!.y2]).toEqual([30, 0])
    expect([map.bottom!.y1, map.bottom!.y2]).toEqual([70, 200])
  })
})

describe('measureRectDistances — disjoint boxes', () => {
  it('measures the GAP between facing edges when the hovered box is to the right', () => {
    const segments = measureRectDistances(rect(0, 0, 100, 50), rect(160, 0, 100, 50))
    const map = bySide(segments)
    expect(sides(segments).sort()).toEqual(['bottom', 'right', 'top'])
    expect(map.right!.gap).toBe(true)
    expect(map.right!.distance).toBe(60)
    expect([map.right!.x1, map.right!.x2]).toEqual([100, 160])
    // Same Y band, so the vertical pair is a pair of zeros, not a gap.
    expect(map.top!.distance).toBe(0)
    expect(map.bottom!.distance).toBe(0)
  })

  it('measures the GAP when the hovered box is above, and drops the unused side', () => {
    const segments = measureRectDistances(rect(0, 200, 100, 50), rect(0, 0, 100, 50))
    const map = bySide(segments)
    expect(map.top!.gap).toBe(true)
    expect(map.top!.distance).toBe(150)
    expect([map.top!.y1, map.top!.y2]).toEqual([200, 50])
    expect(map.bottom).toBeUndefined()
  })

  it('is fully disjoint on both axes — two segments, both gaps', () => {
    const segments = measureRectDistances(rect(0, 0, 50, 50), rect(200, 300, 50, 50))
    expect(sides(segments).sort()).toEqual(['bottom', 'right'])
    expect(segments.every((segment) => segment.gap)).toBe(true)
    expect(bySide(segments).right!.distance).toBe(150)
    expect(bySide(segments).bottom!.distance).toBe(250)
  })

  it('treats exactly-touching edges as a zero gap, not as an overlap', () => {
    const segments = measureRectDistances(rect(0, 0, 100, 50), rect(100, 0, 100, 50))
    const map = bySide(segments)
    expect(map.right!.gap).toBe(true)
    expect(map.right!.distance).toBe(0)
    expect(map.left).toBeUndefined()
  })
})

describe('measureRectDistances — partial overlap and overhang', () => {
  it('reports insets (not gaps) when the boxes overlap on an axis', () => {
    const segments = measureRectDistances(rect(0, 0, 100, 100), rect(60, 60, 100, 100))
    const map = bySide(segments)
    expect(map.left!.gap).toBe(false)
    expect(map.left!.distance).toBe(60)
    expect(map.right!.distance).toBe(60)
  })

  it('never reports a negative distance when the selection sticks out past the hovered box', () => {
    // Selection is WIDER than the hovered box on both sides.
    const segments = measureRectDistances(rect(0, 0, 200, 100), rect(50, 20, 100, 60))
    for (const segment of segments) expect(segment.distance).toBeGreaterThanOrEqual(0)
    const map = bySide(segments)
    expect(map.left!.distance).toBe(50)
    // Endpoints still carry the direction: the selection's right edge is at
    // 200 and the hovered box's is at 150, so the segment runs backwards.
    expect([map.right!.x1, map.right!.x2]).toEqual([200, 150])
  })

  it('rounds sub-pixel layout reads to two decimals', () => {
    const segments = measureRectDistances(rect(0, 0, 10, 10), rect(0.3333333, 0, 20, 10))
    expect(bySide(segments).left!.distance).toBe(0.33)
  })

  it('falls back to the selection centre for the cross axis when there is no overlap there', () => {
    const map = bySide(measureRectDistances(rect(0, 0, 100, 40), rect(300, 500, 100, 40)))
    // No vertical overlap: the horizontal segment rides the selection's own
    // centre (y = 20) rather than clipping a corner of either box.
    expect(map.right!.y1).toBe(20)
  })
})

describe('measureSegmentRect / measureSegmentMidpoint', () => {
  it('paints a horizontal segment as a thin band centred on its line', () => {
    const [segment] = measureRectDistances(rect(0, 0, 100, 50), rect(160, 0, 100, 50))
    const painted = measureSegmentRect(segment!, 1)
    expect(painted).toEqual({ x: 100, y: 24.5, width: 60, height: 1 })
  })

  it('paints a backwards segment left-to-right', () => {
    const map = bySide(measureRectDistances(rect(0, 200, 100, 50), rect(0, 0, 100, 50)))
    const painted = measureSegmentRect(map.top!, 2)
    expect(painted).toEqual({ x: 49, y: 50, width: 2, height: 150 })
  })

  it('midpoint is the centre of the two endpoints', () => {
    const map = bySide(measureRectDistances(rect(0, 0, 100, 50), rect(160, 0, 100, 50)))
    expect(measureSegmentMidpoint(map.right!)).toEqual({ x: 130, y: 25 })
  })
})

describe('padding', () => {
  it('parses computed-style strings, treating unparseable and negative values as zero', () => {
    expect(
      parseMeasurePadding({
        'padding-top': '16px',
        'padding-right': '24.5px',
        'padding-bottom': 'auto',
        'padding-left': '',
      }),
    ).toEqual({ top: 16, right: 24.5, bottom: 0, left: 0 })
  })

  it('computes the content box and never inverts it', () => {
    expect(measureContentBox(rect(10, 10, 100, 60), { top: 8, right: 12, bottom: 8, left: 12 }))
      .toEqual({ x: 22, y: 18, width: 76, height: 44 })
    expect(measureContentBox(rect(0, 0, 10, 10), { top: 40, right: 40, bottom: 40, left: 40 }))
      .toEqual({ x: 10, y: 10, width: 0, height: 0 })
  })

  it('emits only the sides that have padding, with top/bottom spanning the full width', () => {
    const bands = measurePaddingBands(rect(0, 0, 200, 100), { top: 10, right: 0, bottom: 20, left: 30 })
    expect(bands.map((band) => band.side)).toEqual(['top', 'bottom', 'left'])
    const top = bands.find((band) => band.side === 'top')!
    expect(top.rect).toEqual({ x: 0, y: 0, width: 200, height: 10 })
    const bottom = bands.find((band) => band.side === 'bottom')!
    expect(bottom.rect).toEqual({ x: 0, y: 80, width: 200, height: 20 })
    // Left fills only the band between top and bottom padding.
    const left = bands.find((band) => band.side === 'left')!
    expect(left.rect).toEqual({ x: 0, y: 10, width: 30, height: 70 })
    expect(measureBandMidpoint(left)).toEqual({ x: 15, y: 45 })
  })

  it('draws nothing for an element with no padding', () => {
    expect(measurePaddingBands(rect(0, 0, 50, 50), { top: 0, right: 0, bottom: 0, left: 0 })).toEqual([])
  })
})

describe('formatMeasureDistance', () => {
  it('keeps integers integral and sub-pixel values to one decimal', () => {
    expect(formatMeasureDistance(24)).toBe('24')
    expect(formatMeasureDistance(0)).toBe('0')
    expect(formatMeasureDistance(23.96)).toBe('24')
    expect(formatMeasureDistance(23.44)).toBe('23.4')
  })
})

describe('measurementWinsOverTreeLadder — the Alt coordination rule', () => {
  it('measurement wins over a node that is not in the selection', () => {
    expect(measurementWinsOverTreeLadder(['a'], 'b')).toBe(true)
  })

  it('the ladder wins over the selection itself', () => {
    expect(measurementWinsOverTreeLadder(['a'], 'a')).toBe(false)
    expect(measurementWinsOverTreeLadder(['a', 'b'], 'b')).toBe(false)
  })

  it('the ladder wins with nothing selected or nothing hovered', () => {
    expect(measurementWinsOverTreeLadder([], 'b')).toBe(false)
    expect(measurementWinsOverTreeLadder(['a'], null)).toBe(false)
  })
})
