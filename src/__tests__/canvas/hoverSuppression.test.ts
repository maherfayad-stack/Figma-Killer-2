/**
 * Rewriting `:hover` out of a selector without changing what the rest of it
 * means.
 *
 * Every case here is one where the obvious implementation (a global
 * `replace(':hover', '')`, or deleting the rule) gets the cascade wrong.
 */
import { describe, it, expect } from 'bun:test'
import { HOVER_DISABLED_CLASS, disableHoverInSelector } from '@site/canvas/hoverSuppression'

const off = `.${HOVER_DISABLED_CLASS}`

describe('disableHoverInSelector', () => {
  it('leaves a selector with no hover exactly as it was', () => {
    expect(disableHoverInSelector('.btn')).toBe('.btn')
    expect(disableHoverInSelector('a > .card .title')).toBe('a > .card .title')
  })

  it('swaps the pseudo-class for a class, so specificity is unchanged', () => {
    // Both are (0,1,0). A rewritten rule keeps its exact cascade position
    // relative to the rules that still match.
    expect(disableHoverInSelector('.btn:hover')).toBe(`.btn${off}`)
    expect(disableHoverInSelector('a:hover .icon')).toBe(`a${off} .icon`)
  })

  it('rewrites every occurrence, including inside a functional pseudo', () => {
    expect(disableHoverInSelector('.a:hover, .b:hover')).toBe(`.a${off}, .b${off}`)
    expect(disableHoverInSelector(':is(a:hover, button:hover)')).toBe(`:is(a${off}, button${off})`)
  })

  it('keeps :not(:hover) meaning "not hovered" — which is now ALWAYS', () => {
    // The rule this protects: `.btn:not(:hover)` is the author's resting
    // state. Dropping the rule would lose it; anything that always fails
    // would invert it. A never-matched class inside `:not()` always matches.
    expect(disableHoverInSelector('.btn:not(:hover)')).toBe(`.btn:not(${off})`)
  })

  it('does not touch a longer pseudo-class that merely starts with hover', () => {
    expect(disableHoverInSelector('.x:hover-thing')).toBe('.x:hover-thing')
    expect(disableHoverInSelector('.x:hovercard')).toBe('.x:hovercard')
  })

  it('does not touch an escaped colon inside an identifier', () => {
    // Tailwind writes the class `hover:bg-red` as `.hover\:bg-red`; only the
    // trailing real pseudo-class is ours.
    expect(disableHoverInSelector('.hover\\:bg-red:hover')).toBe(`.hover\\:bg-red${off}`)
  })

  it('does not touch a double colon', () => {
    expect(disableHoverInSelector('.x::hover')).toBe('.x::hover')
  })

  it('leaves a quoted attribute value alone', () => {
    expect(disableHoverInSelector('[data-state=":hover"]')).toBe('[data-state=":hover"]')
    expect(disableHoverInSelector('[title=":hover"]:hover')).toBe(`[title=":hover"]${off}`)
  })
})
