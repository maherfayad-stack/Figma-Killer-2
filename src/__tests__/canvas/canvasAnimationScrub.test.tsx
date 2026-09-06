/**
 * The freeze-point contract, extended to a 0…1 scrub (W5-5).
 *
 * `CanvasAnimationInjector`'s `freezePoint` used to be two keywords. It is now
 * an AXIS — `'start'` and `'end'` are its endpoints and a number is any point
 * between them — plus a scrub store that overrides it board-wide and a
 * two-phase play-once. What each of those emits is not cosmetic: a scrub is
 * a negative delay on a paused animation, and the normalised
 * `animation-duration: 1s` beside it is the ONLY reason one delay means the
 * same fraction for a 200 ms fade and a 4 s orbit. Drop either and the slider
 * silently starts lying about where it is. Hence assertions on the
 * declaration text, in the spirit of the sibling suite's `!important` tests.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { act, cleanup, render } from '@testing-library/react'
import { CanvasAnimationInjector } from '@site/canvas/CanvasAnimationInjector'
import {
  clearCanvasAnimationScrub,
  getCanvasAnimationScrub,
  playCanvasAnimationsOnce,
  setCanvasAnimationScrub,
} from '@site/canvas/animationScrubStore'

const STYLE_TAG_ID = 'studio-canvas-animation'

afterEach(() => {
  cleanup()
  clearCanvasAnimationScrub()
  document.getElementById(STYLE_TAG_ID)?.remove()
})

function injectedCss(): string {
  return document.getElementById(STYLE_TAG_ID)?.textContent ?? ''
}

describe('freezePoint as an axis', () => {
  it('0 shows what `start` shows — a paused animation', () => {
    render(<CanvasAnimationInjector targetDocument={document} freezePoint={0} />)
    const css = injectedCss()
    expect(css).toContain('animation-play-state: paused !important')
    expect(css).toContain('animation-delay: -0s !important')
  })

  it('a fraction becomes a negative delay against a normalised duration', () => {
    render(<CanvasAnimationInjector targetDocument={document} freezePoint={0.4} />)
    const css = injectedCss()
    // Both halves matter: without the forced duration, -0.4s is 40% of a 1s
    // animation and 20% of a 2s one.
    expect(css).toContain('animation-duration: 1s !important')
    expect(css).toContain('animation-delay: -0.4s !important')
    expect(css).toContain('animation-play-state: paused !important')
  })

  it('holds the scrubbed frame rather than filling forwards past it', () => {
    render(<CanvasAnimationInjector targetDocument={document} freezePoint={0.4} />)
    expect(injectedCss()).toContain('animation-fill-mode: both !important')
  })

  it('clamps out-of-range values instead of emitting a positive delay', () => {
    const { rerender } = render(<CanvasAnimationInjector targetDocument={document} freezePoint={5} />)
    expect(injectedCss()).toContain('animation-delay: -1s !important')

    rerender(<CanvasAnimationInjector targetDocument={document} freezePoint={-3} />)
    expect(injectedCss()).toContain('animation-delay: -0s !important')
  })

  it('keeps the two keyword forms exactly as they were', () => {
    const { rerender } = render(<CanvasAnimationInjector targetDocument={document} freezePoint="end" />)
    expect(injectedCss()).toContain('animation-iteration-count: 1 !important')
    expect(injectedCss()).toContain('animation-fill-mode: forwards !important')
    expect(injectedCss()).not.toContain('animation-delay')

    rerender(<CanvasAnimationInjector targetDocument={document} freezePoint="start" />)
    expect(injectedCss()).toContain('animation-play-state: paused !important')
    expect(injectedCss()).not.toContain('animation-duration')
  })
})

describe('the scrub store overrides the frame’s own freeze point', () => {
  it('a scrub wins over `freezePoint`, and releasing it gives the frame back', () => {
    render(<CanvasAnimationInjector targetDocument={document} freezePoint="end" />)
    expect(injectedCss()).toContain('animation-fill-mode: forwards !important')

    act(() => setCanvasAnimationScrub(0.25))
    expect(injectedCss()).toContain('animation-delay: -0.25s !important')

    act(() => clearCanvasAnimationScrub())
    expect(injectedCss()).toContain('animation-fill-mode: forwards !important')
    expect(injectedCss()).not.toContain('animation-delay')
  })

  it('clamps at the store boundary too, so no caller can push it out of range', () => {
    act(() => setCanvasAnimationScrub(2))
    expect(getCanvasAnimationScrub().progress).toBe(1)
    act(() => setCanvasAnimationScrub(-1))
    expect(getCanvasAnimationScrub().progress).toBe(0)
  })
})

describe('play once', () => {
  it('strips animation entirely for the reset phase, so the replay starts from the first keyframe', () => {
    render(<CanvasAnimationInjector targetDocument={document} />)
    act(() => playCanvasAnimationsOnce())

    expect(getCanvasAnimationScrub().phase).toBe('reset')
    expect(injectedCss()).toContain('animation: none !important')
  })

  it('runs each animation once and lets it settle, and does not suppress transitions while it plays', async () => {
    render(<CanvasAnimationInjector targetDocument={document} />)
    act(() => playCanvasAnimationsOnce())
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40))
    })

    expect(getCanvasAnimationScrub().phase).toBe('playing')
    const css = injectedCss()
    expect(css).toContain('animation-play-state: running !important')
    expect(css).toContain('animation-iteration-count: 1 !important')
    expect(css).toContain('animation-fill-mode: forwards !important')
    // A play-once is the one moment the frame is deliberately being watched
    // move; suppressing transitions through it would make the preview lie.
    expect(css).not.toContain('transition: none')
  })

  it('a scrub mid-playback cancels the replay rather than fighting it', async () => {
    render(<CanvasAnimationInjector targetDocument={document} />)
    act(() => playCanvasAnimationsOnce())
    act(() => setCanvasAnimationScrub(0.6))

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40))
    })

    expect(getCanvasAnimationScrub().phase).toBe('idle')
    expect(injectedCss()).toContain('animation-delay: -0.6s !important')
  })

  it('the resting state still suppresses transitions and smooth scroll', () => {
    render(<CanvasAnimationInjector targetDocument={document} />)
    const css = injectedCss()
    expect(css).toContain('transition: none !important')
    expect(css).toContain('scroll-behavior: auto !important')
  })
})
