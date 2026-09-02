/**
 * CanvasAnimationInjector — every source of motion on the design canvas
 * settles: CSS animations run once and hold, transitions and smooth scroll
 * are killed, media elements are paused, and reduced-motion is forced on.
 *
 * An imported app never settles on the canvas: the eSIM corpus has a radar ping
 * and an orbiting dot on `infinite`, and `@alm-design/design-system` ships an
 * `infinite` shimmer on every skeleton variant. This injector forces
 * `animation-iteration-count: 1` and `animation-fill-mode: forwards` on
 * everything, including pseudo-elements.
 *
 * The `!important` is load-bearing and asserted here on purpose. `!important`
 * declarations always beat non-`!important` ones regardless of cascade layer,
 * which is what lets this beat both `@layer vendor` (`ProjectCssInjector`,
 * WS-2.3) and `@layer user-authored` content, plus a high-specificity vendor
 * selector like `.btn--skeleton` (0,1,0) against this rule's `*` (0,0,0). If a
 * future edit drops `!important` for tidiness, every design-system skeleton
 * starts shimmering forever again — hence a test on the declaration text.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, render, waitFor } from '@testing-library/react'
import { CanvasAnimationInjector } from '@site/canvas/CanvasAnimationInjector'

const STYLE_TAG_ID = 'studio-canvas-animation'

afterEach(() => {
  cleanup()
  document.getElementById(STYLE_TAG_ID)?.remove()
})

function injectedCss(): string {
  return document.getElementById(STYLE_TAG_ID)?.textContent ?? ''
}

describe('CanvasAnimationInjector', () => {
  it('injects a stylesheet into the target document', () => {
    render(<CanvasAnimationInjector targetDocument={document} />)

    const styleEl = document.getElementById(STYLE_TAG_ID)
    expect(styleEl).not.toBeNull()
    expect(styleEl?.tagName).toBe('STYLE')
    expect(styleEl?.getAttribute('data-source')).toBe('CanvasAnimationInjector')
  })

  it('runs a looping animation exactly once', () => {
    render(<CanvasAnimationInjector targetDocument={document} />)

    expect(injectedCss()).toContain('animation-iteration-count: 1 !important')
  })

  it('holds the last keyframe instead of snapping back', () => {
    render(<CanvasAnimationInjector targetDocument={document} />)

    expect(injectedCss()).toContain('animation-fill-mode: forwards !important')
  })

  it('covers pseudo-elements, which `*` alone does not match', () => {
    // The eSIM radar's orbiting dot is a `::before`; a spinner or shimmer
    // overlay on generated content is a common pattern.
    render(<CanvasAnimationInjector targetDocument={document} />)

    const css = injectedCss()
    expect(css).toContain('*::before')
    expect(css).toContain('*::after')
  })

  it('leaves animation duration and delay alone', () => {
    // Each animation should still play through once at its authored speed —
    // this freezes the END state, it does not suppress motion outright.
    render(<CanvasAnimationInjector targetDocument={document} />)

    const css = injectedCss()
    expect(css).not.toContain('animation-duration')
    expect(css).not.toContain('animation-delay')
    // Default freeze point is 'end' (fill-mode: forwards) — 'start'
    // (play-state: paused) is opt-in, covered by its own test below.
    expect(css).not.toContain('animation-play-state')
  })

  it('kills transitions — a transition mid-flight during a layout change reads as canvas jitter', () => {
    render(<CanvasAnimationInjector targetDocument={document} />)

    expect(injectedCss()).toContain('transition: none !important')
  })

  it('disables smooth scrolling', () => {
    render(<CanvasAnimationInjector targetDocument={document} />)

    expect(injectedCss()).toContain('scroll-behavior: auto !important')
  })

  it('freezePoint "start" pauses instead of holding the end keyframe', () => {
    // Correct for motion whose END state should stay hidden (a fade-out
    // ping) — pausing wherever it currently is, mounted before it has had
    // time to run, holds it near its 0% keyframe instead.
    render(<CanvasAnimationInjector targetDocument={document} freezePoint="start" />)

    const css = injectedCss()
    expect(css).toContain('animation-play-state: paused !important')
    expect(css).not.toContain('animation-fill-mode')
    expect(css).not.toContain('animation-iteration-count')
  })

  it('freezePoint "end" (default) is distinct from "start"', () => {
    const end = render(<CanvasAnimationInjector targetDocument={document} freezePoint="end" />)
    const endCss = injectedCss()
    end.unmount()

    const start = render(<CanvasAnimationInjector targetDocument={document} freezePoint="start" />)
    const startCss = injectedCss()
    start.unmount()

    expect(endCss).not.toEqual(startCss)
    expect(endCss).toContain('animation-fill-mode: forwards !important')
    expect(startCss).toContain('animation-play-state: paused !important')
  })

  it('removes the stylesheet on unmount', () => {
    const view = render(<CanvasAnimationInjector targetDocument={document} />)
    expect(document.getElementById(STYLE_TAG_ID)).not.toBeNull()

    view.unmount()

    expect(document.getElementById(STYLE_TAG_ID)).toBeNull()
  })

  it('does not stack duplicate style elements when re-rendered', () => {
    const view = render(<CanvasAnimationInjector targetDocument={document} />)
    view.rerender(<CanvasAnimationInjector targetDocument={document} />)

    expect(document.querySelectorAll(`#${STYLE_TAG_ID}`)).toHaveLength(1)
  })
})

describe('CanvasAnimationInjector — media pause', () => {
  afterEach(() => {
    cleanup()
    document.getElementById(STYLE_TAG_ID)?.remove()
  })

  it('pauses a <video autoplay> present at mount and strips the autoplay attribute', () => {
    const video = document.createElement('video')
    video.setAttribute('autoplay', '')
    document.body.appendChild(video)
    let pauseCalls = 0
    const originalPause = video.pause.bind(video)
    video.pause = () => {
      pauseCalls += 1
      originalPause()
    }
    try {
      render(<CanvasAnimationInjector targetDocument={document} />)
      expect(video.hasAttribute('autoplay')).toBe(false)
      expect(pauseCalls).toBeGreaterThan(0)
    } finally {
      video.remove()
    }
  })

  it('pauses an <audio autoplay> present at mount and strips the autoplay attribute', () => {
    const audio = document.createElement('audio')
    audio.setAttribute('autoplay', '')
    document.body.appendChild(audio)
    try {
      render(<CanvasAnimationInjector targetDocument={document} />)
      expect(audio.hasAttribute('autoplay')).toBe(false)
    } finally {
      audio.remove()
    }
  })

  it('pauses a <video> inserted AFTER mount — the MutationObserver path', async () => {
    render(<CanvasAnimationInjector targetDocument={document} />)

    const video = document.createElement('video')
    video.setAttribute('autoplay', '')
    let pauseCalls = 0
    const originalPause = video.pause.bind(video)
    video.pause = () => {
      pauseCalls += 1
      originalPause()
    }
    document.body.appendChild(video)

    try {
      await waitFor(() => {
        expect(video.hasAttribute('autoplay')).toBe(false)
      })
      expect(pauseCalls).toBeGreaterThan(0)
    } finally {
      video.remove()
    }
  })

  it('pauses a <video> nested inside a subtree inserted after mount', async () => {
    render(<CanvasAnimationInjector targetDocument={document} />)

    const wrapper = document.createElement('div')
    const video = document.createElement('video')
    video.setAttribute('autoplay', '')
    wrapper.appendChild(video)
    document.body.appendChild(wrapper)

    try {
      await waitFor(() => {
        expect(video.hasAttribute('autoplay')).toBe(false)
      })
    } finally {
      wrapper.remove()
    }
  })
})

describe('CanvasAnimationInjector — prefers-reduced-motion', () => {
  afterEach(() => {
    cleanup()
    document.getElementById(STYLE_TAG_ID)?.remove()
  })

  it('patches matchMedia so a JS-driven reduced-motion check reports "reduce"', () => {
    const view = document.defaultView!
    render(<CanvasAnimationInjector targetDocument={document} />)

    expect(view.matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(true)
    expect(view.matchMedia('(prefers-reduced-motion: no-preference)').matches).toBe(false)
  })

  it('leaves unrelated matchMedia queries working', () => {
    const view = document.defaultView!
    render(<CanvasAnimationInjector targetDocument={document} />)

    const result = view.matchMedia('(min-width: 100px)')
    expect(typeof result.matches).toBe('boolean')
    expect(result.media).toBe('(min-width: 100px)')
  })

  it('restores the native matchMedia on unmount', () => {
    const view = document.defaultView!
    const original = view.matchMedia
    const rendered = render(<CanvasAnimationInjector targetDocument={document} />)
    expect(view.matchMedia).not.toBe(original)

    rendered.unmount()

    expect(view.matchMedia).toBe(original)
  })
})
