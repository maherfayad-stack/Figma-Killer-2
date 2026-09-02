/**
 * Where the selection toolbar and the in-place inspector get PUT.
 *
 * Two things are pinned here, both reported as "the panel opens miles away from
 * the thing I clicked":
 *
 *  1. Overlay coordinates are canvas-root-relative with no scroll term. The
 *     canvas root is `overflow: clip`, so it has no scroll offsets to
 *     compensate for — it used to be `overflow: hidden`, which the browser
 *     scrolled on its own whenever an iframe gained focus.
 *  2. The inspector anchors to the element's VISIBLE region. A selected element
 *     taller or wider than the viewport, or panned so its top-left corner is
 *     off-screen, has a raw rect corner far outside the canvas; clamping that
 *     raw corner parked a panel of form controls against the canvas edge with no
 *     visible relationship to the element it edits.
 */
import { describe, it, expect } from 'bun:test'
import {
  positionInspector,
  positionToolbar,
} from '@site/canvas/canvasSelectionOverlayPositioning'

/** A canvas viewport 1000x800 at the origin. */
const CANVAS = { width: 1000, height: 800, left: 0, top: 0 } as DOMRect

/** Minimal stand-in for the portaled overlay div — `style` writes are the output. */
function fakeOverlay(offsetWidth = 280) {
  const style: Record<string, string> = {}
  return {
    element: { style, offsetWidth } as unknown as HTMLDivElement,
    style,
  }
}

describe('positionInspector', () => {
  it('sits just below a fully visible element, aligned to its left edge', () => {
    const { element, style } = fakeOverlay()

    positionInspector(element, { x: 420, y: 200, width: 393, height: 120 }, CANVAS)

    expect(style.left).toBe('420px')
    // 200 + 120 + the 12px gap.
    expect(style.top).toBe('332px')
  })

  it('follows the visible part of an element whose top-left is off-screen', () => {
    const { element, style } = fakeOverlay()

    // A phone frame panned up and left: the element starts above and left of the
    // viewport but its bottom-right quadrant is on screen at (0,0)-(300,240).
    positionInspector(element, { x: -700, y: -560, width: 1000, height: 800 }, CANVAS)

    // Anchored to the visible region, not to (-700, 240).
    expect(style.left).toBe('4px')
    expect(style.top).toBe('252px')
  })

  it('stays inside the canvas when the element ends past the right edge', () => {
    const { element, style } = fakeOverlay(280)

    positionInspector(element, { x: 960, y: 100, width: 400, height: 50 }, CANVAS)

    // Would have overflowed to 960; clamped so the whole panel stays reachable.
    expect(style.left).toBe('716px')
  })

  it('hides when the element is entirely out of view', () => {
    const { element, style } = fakeOverlay()

    positionInspector(element, { x: -500, y: 100, width: 200, height: 50 }, CANVAS)

    expect(style.display).toBe('none')
  })

  it('hides when there is no measurable rect', () => {
    const { element, style } = fakeOverlay()

    positionInspector(element, null, CANVAS)

    expect(style.display).toBe('none')
  })
})

describe('positionToolbar', () => {
  it('sits above the selection', () => {
    const { element, style } = fakeOverlay(120)

    positionToolbar(element, { x: 420, y: 200, width: 393, height: 120 }, CANVAS)

    expect(style.left).toBe('420px')
    // 200 - the 30px offset.
    expect(style.top).toBe('170px')
  })

  it('hides a selection that is entirely out of view', () => {
    const { element, style } = fakeOverlay(120)

    positionToolbar(element, { x: 100, y: 900, width: 200, height: 50 }, CANVAS)

    expect(style.display).toBe('none')
  })

  it('keeps its actions reachable for a selection starting left of the canvas', () => {
    const { element, style } = fakeOverlay(120)

    positionToolbar(element, { x: -300, y: 200, width: 600, height: 50 }, CANVAS)

    expect(style.left).toBe('4px')
  })
})
