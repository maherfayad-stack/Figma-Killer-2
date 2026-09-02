/**
 * frameVirtualization.ts — pure function unit tests.
 *
 * @see src/admin/pages/site/canvas/BoardFramesLayer/frameVirtualization.ts
 */
import { describe, it, expect } from 'bun:test'
import {
  isFrameOnScreen,
  FRAME_VIEWPORT_MARGIN,
  type FrameRect,
  type ViewportState,
} from '@site/canvas/BoardFramesLayer/frameVirtualization'

const baseFrame: FrameRect = { x: 0, y: 0, width: 1024, height: 848 }
const baseViewport: ViewportState = { panX: 0, panY: 0, zoom: 1, width: 1440, height: 900 }

describe('FRAME_VIEWPORT_MARGIN', () => {
  it('is a sensible ~1-screen default', () => {
    expect(FRAME_VIEWPORT_MARGIN).toBeGreaterThan(0)
    expect(FRAME_VIEWPORT_MARGIN).toBeLessThanOrEqual(1024)
  })
})

describe('isFrameOnScreen', () => {
  it('is true when the frame is fully inside the viewport', () => {
    expect(isFrameOnScreen(baseFrame, baseViewport, 0)).toBe(true)
  })

  it('is false when the frame is far offscreen (well beyond the margin)', () => {
    const frame: FrameRect = { x: 10_000, y: 10_000, width: 1024, height: 848 }
    expect(isFrameOnScreen(frame, baseViewport, FRAME_VIEWPORT_MARGIN)).toBe(false)
  })

  it('is false with zero margin when the frame sits just past the viewport edge', () => {
    // Frame starts 10px to the right of the viewport's right edge.
    const frame: FrameRect = { x: baseViewport.width + 10, y: 0, width: 1024, height: 848 }
    expect(isFrameOnScreen(frame, baseViewport, 0)).toBe(false)
  })

  it('is true when just outside the viewport but within the margin', () => {
    // Frame starts 10px past the right edge — outside the raw viewport, but
    // well within a 600px margin.
    const frame: FrameRect = { x: baseViewport.width + 10, y: 0, width: 1024, height: 848 }
    expect(isFrameOnScreen(frame, baseViewport, FRAME_VIEWPORT_MARGIN)).toBe(true)
  })

  it('is false when outside the viewport by more than the margin', () => {
    const frame: FrameRect = { x: baseViewport.width + FRAME_VIEWPORT_MARGIN + 10, y: 0, width: 1024, height: 848 }
    expect(isFrameOnScreen(frame, baseViewport, FRAME_VIEWPORT_MARGIN)).toBe(false)
  })

  it('respects zoom scaling — a frame board-far-away can be onscreen when zoomed out', () => {
    // At zoom 1, this frame is far offscreen.
    const frame: FrameRect = { x: 5000, y: 0, width: 1024, height: 848 }
    expect(isFrameOnScreen(frame, { ...baseViewport, zoom: 1 }, 0)).toBe(false)
    // Zoomed way out, the same board-space frame lands on screen.
    expect(isFrameOnScreen(frame, { ...baseViewport, zoom: 0.1 }, 0)).toBe(true)
  })

  it('respects zoom scaling — a frame board-near can move offscreen when zoomed in', () => {
    // At zoom 1, this frame (starting at x=1500) is offscreen relative to a
    // 1440-wide viewport already at the edge; zooming in pushes it further out.
    const frame: FrameRect = { x: 1500, y: 0, width: 1024, height: 848 }
    expect(isFrameOnScreen(frame, { ...baseViewport, zoom: 5 }, 0)).toBe(false)
  })

  it('accounts for negative pan (scrolled/panned away from origin)', () => {
    // Panned far left/up — a frame at the board origin is now offscreen.
    const viewport: ViewportState = { ...baseViewport, panX: -5000, panY: -5000 }
    expect(isFrameOnScreen(baseFrame, viewport, 0)).toBe(false)
    // But a frame positioned to compensate for that pan is back on screen.
    const compensatedFrame: FrameRect = { x: 5000, y: 5000, width: 1024, height: 848 }
    expect(isFrameOnScreen(compensatedFrame, viewport, 0)).toBe(true)
  })

  it('treats touching edges (rects that share a boundary, not overlapping) as not intersecting', () => {
    // Frame's left edge is exactly at the viewport's right edge.
    const frame: FrameRect = { x: baseViewport.width, y: 0, width: 1024, height: 848 }
    expect(isFrameOnScreen(frame, baseViewport, 0)).toBe(false)
  })
})
