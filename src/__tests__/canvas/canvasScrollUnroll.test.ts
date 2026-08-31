/**
 * Pure classification + stylesheet-text tests for `canvasScrollUnroll.ts`.
 * Split from the DOM-wiring tests (`canvasScrollUnrollInjector.test.tsx`) the
 * same way `resolveFrameFitHeight.test.ts` sits next to
 * `useIframeFrameAutoHeight`'s wiring — geometry decisions are unit-testable
 * without a real layout engine, DOM wiring is not.
 */
import { describe, expect, it } from 'bun:test'
import {
  authoredMinHeightFloor,
  buildScrollUnrollRules,
  SCROLL_UNROLL_AUTHORED_MIN_HEIGHT_VAR,
  SCROLL_UNROLL_FLOOR_ATTR,
  SCROLL_UNROLL_ORIGINAL_OVERFLOW_ATTR,
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

  /**
   * The regression this whole block guards: an earlier version forced
   * `overflow: visible` on the UNIVERSAL `*` selector — every element,
   * unconditionally. Measured live against a real project: elements that
   * selector touched authored `overflow-y: hidden` ~30x more often than
   * `auto`/`scroll`, and every `hidden` one was a rounded-corner clip mask or
   * a `text-overflow: ellipsis` container, not a scroll region — forcing
   * those visible broke the clip/ellipsis on a real project's Home screen.
   * `overflow`/`min-height` must therefore only ever apply through the
   * `[SCROLL_UNROLL_ORIGINAL_OVERFLOW_ATTR="auto"|"scroll"]` selector, never
   * on `*`.
   */
  it('does NOT force overflow/min-height on the universal `*` rule', () => {
    const universalRuleOnly = css.slice(0, css.indexOf('}') + 1)
    expect(universalRuleOnly).toContain('*,')
    expect(universalRuleOnly).toContain('*::before')
    expect(universalRuleOnly).toContain('*::after')
    expect(universalRuleOnly).not.toContain('overflow')
    expect(universalRuleOnly).not.toContain('min-height')
    // scroll-behavior has no clipping/rendering downside for a hidden/clip
    // element, so it alone stays on the universal rule.
    expect(universalRuleOnly).toContain('scroll-behavior: auto !important')
  })

  it('scopes overflow-visible + min-height-auto to a CONFIRMED scroll region only', () => {
    expect(css).toContain(`[${SCROLL_UNROLL_ORIGINAL_OVERFLOW_ATTR}="auto"]`)
    expect(css).toContain(`[${SCROLL_UNROLL_ORIGINAL_OVERFLOW_ATTR}="scroll"]`)
    const scopedRule = css.slice(
      css.indexOf(`[${SCROLL_UNROLL_ORIGINAL_OVERFLOW_ATTR}="auto"]`),
      // The RULE itself, not the comment text mentioning it (the doc comment
      // inside this very rule references the floor selector by name).
      css.indexOf(`[${SCROLL_UNROLL_FLOOR_ATTR}] {`),
    )
    expect(scopedRule).toContain('overflow: visible !important')
    expect(scopedRule).toContain('overflow-x: visible !important')
    expect(scopedRule).toContain('overflow-y: visible !important')
    expect(scopedRule).toContain('min-height: auto !important')
  })

  it('kills smooth scrolling everywhere, not just scroll regions', () => {
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

/**
 * The regression: the blanket `min-height: auto !important` rule exists to
 * neutralise an authored `min-height: 0` on a `flex: 1` scroll region, but
 * written on `*` it also flattened designed floors. The design system's
 * `.bottom-sheet--small .bottom-sheet__panel { min-height: 200px }` rendered
 * as a 64px sliver hugging its own text — measured live on a real board —
 * which made every bottom sheet in every project the wrong size.
 */
describe('authoredMinHeightFloor', () => {
  it('keeps a positive floor, whatever unit it is written in', () => {
    expect(authoredMinHeightFloor('200px')).toBe('200px')
    expect(authoredMinHeightFloor('400px')).toBe('400px')
    expect(authoredMinHeightFloor('50%')).toBe('50%')
    expect(authoredMinHeightFloor('12.5rem')).toBe('12.5rem')
  })

  it('ignores the two values the blanket reset actually exists for', () => {
    // `min-height: 0` on a `flex: 1` region is the standard shrinkable-region
    // idiom — resetting it to the content-based minimum is the whole point of
    // the rule, so it must keep happening.
    expect(authoredMinHeightFloor('0px')).toBeNull()
    expect(authoredMinHeightFloor('0')).toBeNull()
    expect(authoredMinHeightFloor('auto')).toBeNull()
  })

  it('ignores anything it cannot read as a length', () => {
    expect(authoredMinHeightFloor('')).toBeNull()
    expect(authoredMinHeightFloor('   ')).toBeNull()
    expect(authoredMinHeightFloor('inherit')).toBeNull()
    expect(authoredMinHeightFloor('-10px')).toBeNull()
  })

  it('trims, so a stray whitespace read does not become a broken var() value', () => {
    expect(authoredMinHeightFloor(' 200px ')).toBe('200px')
  })
})

describe('buildScrollUnrollRules — the floor rule', () => {
  const css = buildScrollUnrollRules()

  it('hands a marked element its authored floor back', () => {
    expect(css).toContain(`[${SCROLL_UNROLL_FLOOR_ATTR}]`)
    expect(css).toContain(`min-height: var(${SCROLL_UNROLL_AUTHORED_MIN_HEIGHT_VAR}) !important`)
  })

  it('still resets min-height blanket — the floor rule undoes it per element, it does not replace it', () => {
    expect(css).toContain('min-height: auto !important')
  })

  it('puts the floor rule BEFORE explicit-height, so the content-extent floor still wins on an element carrying both', () => {
    // Equal specificity (one attribute selector each) and both `!important`,
    // so source order is the whole tie-break.
    expect(css.indexOf(`[${SCROLL_UNROLL_FLOOR_ATTR}]`)).toBeLessThan(css.indexOf(`[${SCROLL_UNROLL_ATTR}="explicit-height"]`))
  })
})

describe('MAX_UNROLL_PASSES', () => {
  it('is a small, positive, finite bound', () => {
    expect(MAX_UNROLL_PASSES).toBeGreaterThan(0)
    expect(MAX_UNROLL_PASSES).toBeLessThanOrEqual(10)
  })
})
