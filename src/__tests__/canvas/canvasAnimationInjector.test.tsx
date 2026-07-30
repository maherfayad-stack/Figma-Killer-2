/**
 * CanvasAnimationInjector — animations on the design canvas run once and hold.
 *
 * An imported app never settles on the canvas: the eSIM corpus has a radar ping
 * and an orbiting dot on `infinite`, and `@alm-design/design-system` ships an
 * `infinite` shimmer on every skeleton variant. This injector forces
 * `animation-iteration-count: 1` and `animation-fill-mode: forwards` on
 * everything, including pseudo-elements.
 *
 * The `!important` is load-bearing and asserted here on purpose. Being unlayered
 * is not enough: `AlmDesignSystemCssInjector` is unlayered too, so specificity
 * decides between them, and `*` (0,0,0) loses to `.btn--skeleton` (0,1,0). If a
 * future edit drops `!important` for tidiness, every design-system skeleton
 * starts shimmering forever again — hence a test on the declaration text.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, render } from '@testing-library/react'
import { CanvasAnimationInjector } from '@site/canvas/CanvasAnimationInjector'

const STYLE_TAG_ID = 'instatic-canvas-animation'

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

  it('leaves duration, delay, and transitions alone', () => {
    // Each animation should still play through once at its authored speed —
    // this freezes the END state, it does not suppress motion outright. And
    // transitions are interaction responses, not ambient motion.
    render(<CanvasAnimationInjector targetDocument={document} />)

    const css = injectedCss()
    expect(css).not.toContain('animation-duration')
    expect(css).not.toContain('animation-delay')
    expect(css).not.toContain('animation-play-state')
    expect(css).not.toContain('transition')
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
