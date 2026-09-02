/**
 * The fit rule has to satisfy two things at once: show the whole screen (no
 * inner scroll region hiding content), and never close the pin ⇄ relayout loop
 * that makes sections flicker in and out.
 */
import { describe, expect, it } from 'bun:test'
import { MAX_FRAME_FIT_HEIGHT, MAX_FRAME_FIT_PASSES, resolveFrameFitHeight } from '../resolveFrameFitHeight'

describe('resolveFrameFitHeight', () => {
  it('returns null when the frame already fits', () => {
    expect(
      resolveFrameFitHeight({ pinnedHeight: 800, scrollDeficits: [], passesUsed: 0 }),
    ).toBeNull()
  })

  it('grows by an inner scroll region\'s hidden content', () => {
    // The eSIM confirmation screen: 800px shell, a 673px scroll region holding
    // 1439px. Growing body by the 766px deficit grows the `flex: 1` region by
    // the same amount, so the next pass fits.
    expect(
      resolveFrameFitHeight({ pinnedHeight: 800, scrollDeficits: [766], passesUsed: 0 }),
    ).toBe(1566)
  })

  it('does not grow for content overflowing body itself', () => {
    // Body overflows visibly and the iframe element grows to it, so that is not
    // a scrolling problem. Feeding it in here made one inflated first-layout
    // measurement pin a frame to the ceiling permanently.
    expect(
      resolveFrameFitHeight({ pinnedHeight: 800, scrollDeficits: [], passesUsed: 0 }),
    ).toBeNull()
  })

  it('takes the worst of several scroll regions', () => {
    expect(
      resolveFrameFitHeight({ pinnedHeight: 800, scrollDeficits: [120, 900, 30], passesUsed: 0 }),
    ).toBe(1700)
  })

  it('ignores a sub-pixel deficit', () => {
    // Rounding noise in a fractional layout, not hidden content. Chasing it
    // would resize the frame every frame forever.
    expect(
      resolveFrameFitHeight({ pinnedHeight: 800, scrollDeficits: [0.6], passesUsed: 0 }),
    ).toBeNull()
  })

  it('never shrinks the pin, even when content is far smaller', () => {
    // Shrinking is what closes the feedback loop. A frame that is too tall is a
    // cosmetic problem; a frame that oscillates is unusable.
    expect(
      resolveFrameFitHeight({ pinnedHeight: 4000, scrollDeficits: [], passesUsed: 0 }),
    ).toBeNull()
  })

  it('stops at the ceiling instead of growing without bound', () => {
    expect(
      resolveFrameFitHeight({
        pinnedHeight: MAX_FRAME_FIT_HEIGHT - 10,
        scrollDeficits: [999999],
        passesUsed: 0,
      }),
    ).toBe(MAX_FRAME_FIT_HEIGHT)
    // Already at the ceiling — no further growth, and no infinite rescheduling.
    expect(
      resolveFrameFitHeight({
        pinnedHeight: MAX_FRAME_FIT_HEIGHT,
        scrollDeficits: [999999],
        passesUsed: 0,
      }),
    ).toBeNull()
  })

  it('gives up after the pass budget instead of chasing a deficit that never closes', () => {
    // Content sized as a percentage of the scroll region grows with every pass,
    // so the deficit is permanent. On the eSIM corpus this rode to the 20000px
    // ceiling and dragged its frame to 100342px.
    expect(
      resolveFrameFitHeight({
        pinnedHeight: 4000,
        scrollDeficits: [900],
        passesUsed: MAX_FRAME_FIT_PASSES,
      }),
    ).toBeNull()
  })

  it('bounds total growth: a self-feeding deficit cannot outrun the budget', () => {
    // The runaway shape — the region's content is always 40% taller than the
    // region, so growing never helps. It has to stop, and well short of the
    // ceiling.
    let pinned = 800
    let passes = 0
    for (;;) {
      const next = resolveFrameFitHeight({
        pinnedHeight: pinned,
        scrollDeficits: [pinned * 0.4],
        passesUsed: passes,
      })
      if (next === null) break
      pinned = next
      passes += 1
    }
    expect(passes).toBe(MAX_FRAME_FIT_PASSES)
    expect(pinned).toBeLessThan(MAX_FRAME_FIT_HEIGHT)
  })

  it('converges: feeding each result back in terminates with no deficit left', () => {
    // The property that matters. Model a shell whose scroll region holds 1439px
    // of content: growing body grows the region 1:1.
    const CONTENT = 1439
    const CHROME = 127
    let pinned = 800
    let passes = 0
    for (;;) {
      const regionHeight = Math.max(pinned - CHROME, 0)
      const deficit = Math.max(CONTENT - regionHeight, 0)
      const next = resolveFrameFitHeight({
        pinnedHeight: pinned,
        scrollDeficits: deficit > 0 ? [deficit] : [],
        passesUsed: passes,
      })
      if (next === null) break
      expect(next).toBeGreaterThan(pinned)
      pinned = next
      expect((passes += 1)).toBeLessThan(10)
    }
    expect(pinned - CHROME).toBeGreaterThanOrEqual(CONTENT)
  })
})
