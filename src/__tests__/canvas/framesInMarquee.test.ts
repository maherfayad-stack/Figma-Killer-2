/**
 * framesInMarquee.ts — pure function unit tests.
 *
 * @see src/admin/pages/site/canvas/BoardFramesLayer/framesInMarquee.ts
 */
import { describe, it, expect } from 'bun:test'
import {
  framesInMarquee,
  marqueeRectFromPoints,
  type MarqueeFrame,
  type MarqueeRect,
} from '@site/canvas/BoardFramesLayer/framesInMarquee'
import type { ViewportState } from '@site/canvas/BoardFramesLayer/frameVirtualization'

const frameA: MarqueeFrame = { pageId: 'a', x: 0, y: 0, width: 400, height: 300 }
const frameB: MarqueeFrame = { pageId: 'b', x: 600, y: 0, width: 400, height: 300 }
const frameC: MarqueeFrame = { pageId: 'c', x: 0, y: 500, width: 400, height: 300 }
const frames = [frameA, frameB, frameC]

const identityViewport: Pick<ViewportState, 'panX' | 'panY' | 'zoom'> = { panX: 0, panY: 0, zoom: 1 }

describe('marqueeRectFromPoints', () => {
  it('normalizes when dragging down-right', () => {
    expect(marqueeRectFromPoints(10, 10, 50, 60)).toEqual({ x: 10, y: 10, width: 40, height: 50 })
  })

  it('normalizes when dragging up-left (start is the larger point)', () => {
    expect(marqueeRectFromPoints(50, 60, 10, 10)).toEqual({ x: 10, y: 10, width: 40, height: 50 })
  })

  it('normalizes a mixed-direction drag', () => {
    // Start bottom-left, drag to top-right.
    expect(marqueeRectFromPoints(10, 60, 50, 10)).toEqual({ x: 10, y: 10, width: 40, height: 50 })
  })
})

describe('framesInMarquee', () => {
  it('selects a frame fully enclosed by the marquee', () => {
    const marquee: MarqueeRect = { x: -10, y: -10, width: 420, height: 320 }
    expect(framesInMarquee(frames, marquee, identityViewport)).toEqual(['a'])
  })

  it('selects a frame the marquee only partially overlaps (intersection, not containment)', () => {
    const marquee: MarqueeRect = { x: 300, y: 0, width: 100, height: 100 }
    expect(framesInMarquee(frames, marquee, identityViewport)).toEqual(['a'])
  })

  it('selects multiple intersecting frames in list order', () => {
    const marquee: MarqueeRect = { x: 0, y: 0, width: 1200, height: 320 }
    expect(framesInMarquee(frames, marquee, identityViewport)).toEqual(['a', 'b'])
  })

  it('selects nothing when the marquee touches no frame', () => {
    const marquee: MarqueeRect = { x: 5000, y: 5000, width: 100, height: 100 }
    expect(framesInMarquee(frames, marquee, identityViewport)).toEqual([])
  })

  it('treats touching edges as not intersecting', () => {
    // Marquee's right edge exactly meets frame A's left edge (x=0).
    const marquee: MarqueeRect = { x: -100, y: 0, width: 100, height: 300 }
    expect(framesInMarquee(frames, marquee, identityViewport)).toEqual([])
  })

  it('respects zoom scaling', () => {
    const marquee: MarqueeRect = { x: 0, y: 0, width: 100, height: 100 }
    // At zoom 1, frame B (board x=600) is nowhere near this small screen-space marquee.
    expect(framesInMarquee([frameB], marquee, { ...identityViewport, zoom: 1 })).toEqual([])
    // Zoomed out, the same board-space frame's screen rect shrinks into range.
    expect(framesInMarquee([frameB], marquee, { ...identityViewport, zoom: 0.1 })).toEqual(['b'])
  })

  it('accounts for pan offset', () => {
    const marquee: MarqueeRect = { x: 0, y: 0, width: 100, height: 100 }
    // Panned so frame A's board origin (0,0) now renders far offscreen to the left.
    expect(framesInMarquee([frameA], marquee, { ...identityViewport, panX: -1000 })).toEqual([])
    // Panned so frame A's board origin now lands inside the marquee.
    expect(framesInMarquee([frameA], marquee, { ...identityViewport, panX: 50, panY: 50 })).toEqual(['a'])
  })

  it('returns an empty array for an empty frame list', () => {
    const marquee: MarqueeRect = { x: 0, y: 0, width: 10_000, height: 10_000 }
    expect(framesInMarquee([], marquee, identityViewport)).toEqual([])
  })
})
