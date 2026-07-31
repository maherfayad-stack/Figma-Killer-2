/**
 * Pure classification + stylesheet-text tests for `canvasScrollUnroll.ts`.
 * Split from the DOM-wiring tests (`canvasScrollUnrollInjector.test.tsx`) the
 * same way `resolveFrameFitHeight.test.ts` sits next to
 * `useIframeFrameAutoHeight`'s wiring — geometry decisions are unit-testable
 * without a real layout engine, DOM wiring is not.
 */
import { describe, expect, it } from 'bun:test'
import {
  buildScrollUnrollRules,
  classifyUnrollElement,
  MAX_UNROLL_PASSES,
  SCROLL_UNROLL_ATTR,
  SCROLL_UNROLL_MIN_HEIGHT_VAR,
} from '@site/canvas/canvasScrollUnroll'

describe('classifyUnrollElement', () => {
  it('tags a position:fixed element "fixed", regardless of deficit', () => {
    expect(
      classifyUnrollElement({ position: 'fixed', scrollDeficit: 0, clientHeight: 100 }),
    ).toBe('fixed')
    expect(
      classifyUnrollElement({ position: 'fixed', scrollDeficit: 500, clientHeight: 100 }),
    ).toBe('fixed')
  })

  it('tags a clipping non-fixed element "explicit-height"', () => {
    expect(
      classifyUnrollElement({ position: 'static', scrollDeficit: 400, clientHeight: 812 }),
    ).toBe('explicit-height')
  })

  it('does not tag an element with no meaningful deficit', () => {
    expect(
      classifyUnrollElement({ position: 'static', scrollDeficit: 0, clientHeight: 812 }),
    ).toBeNull()
  })

  it('treats a sub-pixel deficit as rounding noise, not real clipping', () => {
    // Matches resolveFrameFitHeight's own `<= 1` tolerance.
    expect(
      classifyUnrollElement({ position: 'static', scrollDeficit: 1, clientHeight: 812 }),
    ).toBeNull()
    expect(
      classifyUnrollElement({ position: 'static', scrollDeficit: 1.0001, clientHeight: 812 }),
    ).toBe('explicit-height')
  })

  it('"fixed" wins over "explicit-height" for an element that is somehow both', () => {
    expect(
      classifyUnrollElement({ position: 'fixed', scrollDeficit: 400, clientHeight: 100 }),
    ).toBe('fixed')
  })

  it('relative/absolute/sticky positioning is not "fixed"', () => {
    for (const position of ['relative', 'absolute', 'sticky', 'static']) {
      expect(classifyUnrollElement({ position, scrollDeficit: 0, clientHeight: 100 })).toBeNull()
    }
  })
})

describe('buildScrollUnrollRules', () => {
  const css = buildScrollUnrollRules()

  it('forces overflow visible on every element, including pseudo-elements', () => {
    expect(css).toContain('*,')
    expect(css).toContain('*::before')
    expect(css).toContain('*::after')
    expect(css).toContain('overflow: visible !important')
    expect(css).toContain('overflow-x: visible !important')
    expect(css).toContain('overflow-y: visible !important')
  })

  it('kills smooth scrolling', () => {
    expect(css).toContain('scroll-behavior: auto !important')
  })

  it('restores the automatic (content-based) minimum size', () => {
    expect(css).toContain('min-height: auto !important')
  })

  it('never declares a blanket `height` override — that is the pin\'s job', () => {
    // A bare `height:` declaration on the UNIVERSAL `*` rule would fight
    // useIframeFrameAutoHeight's body-height pin. Only the tag-scoped
    // explicit-height selector may declare `height`, so this only inspects
    // the CSS text before the first tagged selector.
    const universalRuleOnly = css.slice(0, css.indexOf(`[${SCROLL_UNROLL_ATTR}`))
    const bareHeightDeclarations = universalRuleOnly
      .split('\n')
      .filter((line) => /^\s*height\s*:/.test(line))
    expect(bareHeightDeclarations).toHaveLength(0)
  })

  it('pins a tagged fixed element with position:absolute, not position:static', () => {
    // The plan's draft text used `position: static`, which would reflow
    // fixed chrome into the document instead of keeping its authored
    // top/left/right/bottom offsets meaningful — absolute is the corrected
    // behaviour (see the WS-8.2 work order).
    expect(css).toContain(`[${SCROLL_UNROLL_ATTR}="fixed"]`)
    expect(css).toContain('position: absolute !important')
    expect(css).not.toContain('position: static')
  })

  it('uses the studio- prefixed attribute, not the stale instatic- name', () => {
    expect(SCROLL_UNROLL_ATTR).toBe('data-studio-unroll')
    expect(css).not.toContain('data-instatic-unroll')
  })

  it('releases an explicit-height element to grow, floored at its measured min-height', () => {
    expect(css).toContain(`[${SCROLL_UNROLL_ATTR}="explicit-height"]`)
    expect(css).toContain('height: auto !important')
    expect(css).toContain(`min-height: var(${SCROLL_UNROLL_MIN_HEIGHT_VAR}) !important`)
  })
})

describe('MAX_UNROLL_PASSES', () => {
  it('is a small, positive, finite bound', () => {
    expect(MAX_UNROLL_PASSES).toBeGreaterThan(0)
    expect(MAX_UNROLL_PASSES).toBeLessThanOrEqual(10)
  })
})
