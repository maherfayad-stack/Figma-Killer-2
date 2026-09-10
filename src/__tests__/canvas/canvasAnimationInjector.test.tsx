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
import { CanvasFrameAdapterContext } from '@site/canvas/CanvasContexts'
import { PortalFrameAdapter } from '@site/canvas/frameAdapter/PortalFrameAdapter'

const STYLE_TAG_ID = 'studio-canvas-animation'

let adapters: PortalFrameAdapter[] = []

function makeAdapter(): PortalFrameAdapter {
  const adapter = new PortalFrameAdapter(document)
  adapters.push(adapter)
  return adapter
}

afterEach(() => {
  cleanup()
  for (const adapter of adapters) adapter.dispose()
  adapters = []
  document.getElementById(STYLE_TAG_ID)?.remove()
})

function injectedCss(): string {
  return document.getElementById(STYLE_TAG_ID)?.textContent ?? ''
}

describe('CanvasAnimationInjector', () => {
  it('injects a stylesheet into the target document', () => {
    const adapter = makeAdapter()
    render(<CanvasFrameAdapterContext.Provider value={adapter}><CanvasAnimationInjector /></CanvasFrameAdapterContext.Provider>)

    const styleEl = document.getElementById(STYLE_TAG_ID)
    expect(styleEl).not.toBeNull()
    expect(styleEl?.tagName).toBe('STYLE')
    expect(styleEl?.getAttribute('data-source')).toBe('CanvasAnimationInjector')
  })

  it('runs a looping animation exactly once', () => {
    const adapter = makeAdapter()
    render(<CanvasFrameAdapterContext.Provider value={adapter}><CanvasAnimationInjector /></CanvasFrameAdapterContext.Provider>)

    expect(injectedCss()).toContain('animation-iteration-count: 1 !important')
  })

  it('holds the last keyframe instead of snapping back', () => {
    const adapter = makeAdapter()
    render(<CanvasFrameAdapterContext.Provider value={adapter}><CanvasAnimationInjector /></CanvasFrameAdapterContext.Provider>)

    expect(injectedCss()).toContain('animation-fill-mode: forwards !important')
  })

  it('covers pseudo-elements, which `*` alone does not match', () => {
    const adapter = makeAdapter()
    // The eSIM radar's orbiting dot is a `::before`; a spinner or shimmer
    // overlay on generated content is a common pattern.
    render(<CanvasFrameAdapterContext.Provider value={adapter}><CanvasAnimationInjector /></CanvasFrameAdapterContext.Provider>)

    const css = injectedCss()
    expect(css).toContain('*::before')
    expect(css).toContain('*::after')
  })

  it('leaves animation duration and delay alone', () => {
    const adapter = makeAdapter()
    // Each animation should still play through once at its authored speed —
    // this freezes the END state, it does not suppress motion outright.
    render(<CanvasFrameAdapterContext.Provider value={adapter}><CanvasAnimationInjector /></CanvasFrameAdapterContext.Provider>)

    const css = injectedCss()
    expect(css).not.toContain('animation-duration')
    expect(css).not.toContain('animation-delay')
    // Default freeze point is 'end' (fill-mode: forwards) — 'start'
    // (play-state: paused) is opt-in, covered by its own test below.
    expect(css).not.toContain('animation-play-state')
  })

  it('kills transitions — a transition mid-flight during a layout change reads as canvas jitter', () => {
    const adapter = makeAdapter()
    render(<CanvasFrameAdapterContext.Provider value={adapter}><CanvasAnimationInjector /></CanvasFrameAdapterContext.Provider>)

    expect(injectedCss()).toContain('transition: none !important')
  })

  it('disables smooth scrolling', () => {
    const adapter = makeAdapter()
    render(<CanvasFrameAdapterContext.Provider value={adapter}><CanvasAnimationInjector /></CanvasFrameAdapterContext.Provider>)

    expect(injectedCss()).toContain('scroll-behavior: auto !important')
  })

  it('freezePoint "start" pauses instead of holding the end keyframe', () => {
    const adapter = makeAdapter()
    // Correct for motion whose END state should stay hidden (a fade-out
    // ping) — pausing wherever it currently is, mounted before it has had
    // time to run, holds it near its 0% keyframe instead.
    render(<CanvasFrameAdapterContext.Provider value={adapter}><CanvasAnimationInjector freezePoint="start" /></CanvasFrameAdapterContext.Provider>)

    const css = injectedCss()
    expect(css).toContain('animation-play-state: paused !important')
    expect(css).not.toContain('animation-fill-mode')
    expect(css).not.toContain('animation-iteration-count')
  })

  it('freezePoint "end" (default) is distinct from "start"', () => {
    const adapter = makeAdapter()
    const end = render(<CanvasFrameAdapterContext.Provider value={adapter}><CanvasAnimationInjector freezePoint="end" /></CanvasFrameAdapterContext.Provider>)
    const endCss = injectedCss()
    end.unmount()

    const start = render(<CanvasFrameAdapterContext.Provider value={adapter}><CanvasAnimationInjector freezePoint="start" /></CanvasFrameAdapterContext.Provider>)
    const startCss = injectedCss()
    start.unmount()

    expect(endCss).not.toEqual(startCss)
    expect(endCss).toContain('animation-fill-mode: forwards !important')
    expect(startCss).toContain('animation-play-state: paused !important')
  })

  it('removes the stylesheet on unmount', () => {
    const adapter = makeAdapter()
    const view = render(<CanvasFrameAdapterContext.Provider value={adapter}><CanvasAnimationInjector /></CanvasFrameAdapterContext.Provider>)
    expect(document.getElementById(STYLE_TAG_ID)).not.toBeNull()

    view.unmount()

    expect(document.getElementById(STYLE_TAG_ID)).toBeNull()
  })

  it('does not stack duplicate style elements when re-rendered', () => {
    const adapter = makeAdapter()
    const view = render(<CanvasFrameAdapterContext.Provider value={adapter}><CanvasAnimationInjector /></CanvasFrameAdapterContext.Provider>)
    view.rerender(<CanvasFrameAdapterContext.Provider value={adapter}><CanvasAnimationInjector /></CanvasFrameAdapterContext.Provider>)

    expect(document.querySelectorAll(`#${STYLE_TAG_ID}`)).toHaveLength(1)
  })
})

describe('CanvasAnimationInjector — media pause', () => {
  afterEach(() => {
    cleanup()
    for (const adapter of adapters) adapter.dispose()
    adapters = []
    document.getElementById(STYLE_TAG_ID)?.remove()
  })

  it('pauses a <video autoplay> present at mount and strips the autoplay attribute', () => {
    const adapter = makeAdapter()
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
      render(<CanvasFrameAdapterContext.Provider value={adapter}><CanvasAnimationInjector /></CanvasFrameAdapterContext.Provider>)
      expect(video.hasAttribute('autoplay')).toBe(false)
      expect(pauseCalls).toBeGreaterThan(0)
    } finally {
      video.remove()
    }
  })

  it('pauses an <audio autoplay> present at mount and strips the autoplay attribute', () => {
    const adapter = makeAdapter()
    const audio = document.createElement('audio')
    audio.setAttribute('autoplay', '')
    document.body.appendChild(audio)
    try {
      render(<CanvasFrameAdapterContext.Provider value={adapter}><CanvasAnimationInjector /></CanvasFrameAdapterContext.Provider>)
      expect(audio.hasAttribute('autoplay')).toBe(false)
    } finally {
      audio.remove()
    }
  })

  it('pauses a <video> inserted AFTER mount — the MutationObserver path', async () => {
    const adapter = makeAdapter()
    render(<CanvasFrameAdapterContext.Provider value={adapter}><CanvasAnimationInjector /></CanvasFrameAdapterContext.Provider>)

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
    const adapter = makeAdapter()
    render(<CanvasFrameAdapterContext.Provider value={adapter}><CanvasAnimationInjector /></CanvasFrameAdapterContext.Provider>)

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
    for (const adapter of adapters) adapter.dispose()
    adapters = []
    document.getElementById(STYLE_TAG_ID)?.remove()
  })

  it('patches matchMedia so a JS-driven reduced-motion check reports "reduce"', () => {
    const adapter = makeAdapter()
    const view = document.defaultView!
    render(<CanvasFrameAdapterContext.Provider value={adapter}><CanvasAnimationInjector /></CanvasFrameAdapterContext.Provider>)

    expect(view.matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(true)
    expect(view.matchMedia('(prefers-reduced-motion: no-preference)').matches).toBe(false)
  })

  it('leaves unrelated matchMedia queries working', () => {
    const adapter = makeAdapter()
    const view = document.defaultView!
    render(<CanvasFrameAdapterContext.Provider value={adapter}><CanvasAnimationInjector /></CanvasFrameAdapterContext.Provider>)

    const result = view.matchMedia('(min-width: 100px)')
    expect(typeof result.matches).toBe('boolean')
    expect(result.media).toBe('(min-width: 100px)')
  })

  it('restores the native matchMedia on unmount', () => {
    const adapter = makeAdapter()
    const view = document.defaultView!
    const original = view.matchMedia
    const rendered = render(<CanvasFrameAdapterContext.Provider value={adapter}><CanvasAnimationInjector /></CanvasFrameAdapterContext.Provider>)
    expect(view.matchMedia).not.toBe(original)

    rendered.unmount()

    expect(view.matchMedia).toBe(original)
  })
})
