import { describe, expect, it } from 'bun:test'
import { fitFloatingToViewport } from './floatingViewportFit'

/**
 * A 1400x900 viewport with a 12px edge margin — the inspector popover's real
 * geometry. `anchor*` values below describe where the ⚙ trigger sits; the
 * anchored-positioning pass has already turned that into the proposed x/y.
 */
const VIEWPORT = { viewportWidth: 1400, viewportHeight: 900, margin: 12 }

describe('fitFloatingToViewport', () => {
  it('leaves a popover that already fits exactly where it was placed', () => {
    const fit = fitFloatingToViewport({
      x: 900,
      y: 300,
      width: 248,
      height: 400,
      ...VIEWPORT,
    })
    expect(fit.x).toBe(900)
    expect(fit.y).toBe(300)
  })

  it('shifts a popover up when a low trigger would push it off the bottom', () => {
    // Trigger near the bottom of the panel: side pass proposes y = 700, which
    // would put the popover's bottom at 1100 — 200px past the viewport.
    const fit = fitFloatingToViewport({
      x: 900,
      y: 700,
      width: 248,
      height: 400,
      ...VIEWPORT,
    })
    expect(fit.y).toBe(900 - 400 - 12)
    expect(fit.y + 400).toBe(900 - 12)
  })

  it('pins an oversized popover to the top margin and caps its height', () => {
    const fit = fitFloatingToViewport({
      x: 900,
      y: 640,
      width: 248,
      height: 1200,
      ...VIEWPORT,
    })
    expect(fit.y).toBe(12)
    expect(fit.maxHeight).toBe(900 - 24)
    // Bottom edge lands exactly on the opposite margin — nothing is clipped
    // off-screen; the body scrolls the overflow instead.
    expect(fit.y + fit.maxHeight).toBe(900 - 12)
  })

  it('never proposes a negative top for a popover taller than the viewport', () => {
    const fit = fitFloatingToViewport({
      x: 0,
      y: 0,
      width: 248,
      height: 5000,
      ...VIEWPORT,
    })
    expect(fit.y).toBe(12)
  })

  it('always reports a viewport-derived height ceiling, even when the popover is short', () => {
    const fit = fitFloatingToViewport({
      x: 900,
      y: 300,
      width: 248,
      height: 120,
      ...VIEWPORT,
    })
    expect(fit.maxHeight).toBe(876)
  })

  it('clamps a popover that would run off the right edge', () => {
    const fit = fitFloatingToViewport({
      x: 1380,
      y: 300,
      width: 248,
      height: 400,
      ...VIEWPORT,
    })
    expect(fit.x).toBe(1400 - 248 - 12)
  })

  it('clamps a popover that would run off the left edge', () => {
    const fit = fitFloatingToViewport({
      x: -40,
      y: 300,
      width: 248,
      height: 400,
      ...VIEWPORT,
    })
    expect(fit.x).toBe(12)
  })

  it('pins to the left margin when the popover is wider than the viewport', () => {
    const fit = fitFloatingToViewport({
      x: 900,
      y: 300,
      width: 2000,
      height: 400,
      ...VIEWPORT,
    })
    expect(fit.x).toBe(12)
  })

  it('degrades to a zero ceiling rather than a negative one on a tiny viewport', () => {
    const fit = fitFloatingToViewport({
      x: 4,
      y: 4,
      width: 248,
      height: 400,
      viewportWidth: 10,
      viewportHeight: 10,
      margin: 12,
    })
    expect(fit.maxHeight).toBe(0)
    expect(fit.x).toBe(12)
    expect(fit.y).toBe(12)
  })
})
