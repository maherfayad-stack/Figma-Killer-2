/**
 * framesInMarquee.ts — pure function unit tests.
 *
 * `board-03`: both sides are now screen-space (canvas-root-relative) rects.
 * The caller measures each frame's RENDERED box at pointerdown instead of
 * deriving one from `board.frames[].height` + the pan/zoom transform, so the
 * pan/zoom cases that used to live here belong to `frameVirtualization.ts`
 * (which still owns that transform) and the intersection rule is all that is
 * left to assert. See the module doc for why the derived rect was wrong.
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

const frameA: MarqueeFrame = { pageId: 'a', x: 0, y: 0, width: 400, height: 300 }
const frameB: MarqueeFrame = { pageId: 'b', x: 600, y: 0, width: 400, height: 300 }
const frameC: MarqueeFrame = { pageId: 'c', x: 0, y: 500, width: 400, height: 300 }
const frames = [frameA, frameB, frameC]

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
    expect(framesInMarquee(frames, marquee)).toEqual(['a'])
  })

  it('selects a frame the marquee only partially overlaps (intersection, not containment)', () => {
    const marquee: MarqueeRect = { x: 300, y: 0, width: 100, height: 100 }
    expect(framesInMarquee(frames, marquee)).toEqual(['a'])
  })

  it('selects multiple intersecting frames in list order', () => {
    const marquee: MarqueeRect = { x: 0, y: 0, width: 1200, height: 320 }
    expect(framesInMarquee(frames, marquee)).toEqual(['a', 'b'])
  })

  it('selects nothing when the marquee touches no frame', () => {
    const marquee: MarqueeRect = { x: 5000, y: 5000, width: 100, height: 100 }
    expect(framesInMarquee(frames, marquee)).toEqual([])
  })

  it('treats touching edges as not intersecting', () => {
    // Marquee's right edge exactly meets frame A's left edge (x=0).
    const marquee: MarqueeRect = { x: -100, y: 0, width: 100, height: 300 }
    expect(framesInMarquee(frames, marquee)).toEqual([])
  })

  it('selects a frame whose rendered box is far taller than its nominal one', () => {
    // The auto-height case (`canvas-04`): a frame the author never resized
    // renders `height: auto`, so its real box runs thousands of pixels past
    // the nominal `FRAME_HEIGHT` the old board-space rect used. A marquee
    // across the part the user can SEE must select it.
    const tall: MarqueeFrame = { pageId: 'tall', x: 0, y: 0, width: 400, height: 6000 }
    const marquee: MarqueeRect = { x: 100, y: 5000, width: 50, height: 50 }
    expect(framesInMarquee([tall], marquee)).toEqual(['tall'])
  })

  it('returns an empty array for an empty frame list', () => {
    const marquee: MarqueeRect = { x: 0, y: 0, width: 10_000, height: 10_000 }
    expect(framesInMarquee([], marquee)).toEqual([])
  })
})
