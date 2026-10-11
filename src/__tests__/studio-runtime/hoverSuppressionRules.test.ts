/**
 * Rewriting `:hover` out of a selector without changing what the rest of it
 * means.
 *
 * Every case here is one where the obvious implementation (a global
 * `replace(':hover', '')`, or deleting the rule) gets the cascade wrong.
 */
import { afterEach, describe, it, expect } from 'bun:test'
import {
  ACTIVE_DISABLED_CLASS,
  HOVER_DISABLED_CLASS,
  disablePointerStatesInSelector,
  suppressHoverInDocument,
  startHoverSuppression,
} from '@core/studio-runtime'

const off = `.${HOVER_DISABLED_CLASS}`

describe('disablePointerStatesInSelector', () => {
  it('leaves a selector with no hover exactly as it was', () => {
    expect(disablePointerStatesInSelector('.btn')).toBe('.btn')
    expect(disablePointerStatesInSelector('a > .card .title')).toBe('a > .card .title')
  })

  it('swaps the pseudo-class for a class, so specificity is unchanged', () => {
    // Both are (0,1,0). A rewritten rule keeps its exact cascade position
    // relative to the rules that still match.
    expect(disablePointerStatesInSelector('.btn:hover')).toBe(`.btn${off}`)
    expect(disablePointerStatesInSelector('a:hover .icon')).toBe(`a${off} .icon`)
  })

  it('rewrites every occurrence, including inside a functional pseudo', () => {
    expect(disablePointerStatesInSelector('.a:hover, .b:hover')).toBe(`.a${off}, .b${off}`)
    expect(disablePointerStatesInSelector(':is(a:hover, button:hover)')).toBe(`:is(a${off}, button${off})`)
  })

  it('keeps :not(:hover) meaning "not hovered" — which is now ALWAYS', () => {
    // The rule this protects: `.btn:not(:hover)` is the author's resting
    // state. Dropping the rule would lose it; anything that always fails
    // would invert it. A never-matched class inside `:not()` always matches.
    expect(disablePointerStatesInSelector('.btn:not(:hover)')).toBe(`.btn:not(${off})`)
  })

  it('does not touch a longer pseudo-class that merely starts with hover', () => {
    expect(disablePointerStatesInSelector('.x:hover-thing')).toBe('.x:hover-thing')
    expect(disablePointerStatesInSelector('.x:hovercard')).toBe('.x:hovercard')
  })

  it('does not touch an escaped colon inside an identifier', () => {
    // Tailwind writes the class `hover:bg-red` as `.hover\:bg-red`; only the
    // trailing real pseudo-class is ours.
    expect(disablePointerStatesInSelector('.hover\\:bg-red:hover')).toBe(`.hover\\:bg-red${off}`)
  })

  it('does not touch a double colon', () => {
    expect(disablePointerStatesInSelector('.x::hover')).toBe('.x::hover')
  })

  it('leaves a quoted attribute value alone', () => {
    expect(disablePointerStatesInSelector('[data-state=":hover"]')).toBe('[data-state=":hover"]')
    expect(disablePointerStatesInSelector('[title=":hover"]:hover')).toBe(`[title=":hover"]${off}`)
  })
})

/**
 * The PRESSED state. A design frame's press belongs to the editor (select or
 * drag), and `.btn:active { padding: … }` used to shrink the button under the
 * pointer for the whole drag — the owner's "the click state triggers first".
 */
describe('disablePointerStatesInSelector — :active', () => {
  const pressedOff = `.${ACTIVE_DISABLED_CLASS}`

  it('swaps :active for its own dead class, keeping specificity', () => {
    expect(disablePointerStatesInSelector('.btn:active')).toBe(`.btn${pressedOff}`)
    expect(disablePointerStatesInSelector('.btn--primary:active:not(:disabled)')).toBe(
      `.btn--primary${pressedOff}:not(:disabled)`,
    )
  })

  it('rewrites :hover and :active in one selector independently', () => {
    expect(disablePointerStatesInSelector('.a:hover, .a:active')).toBe(`.a${off}, .a${pressedOff}`)
    expect(disablePointerStatesInSelector('.a:hover:active')).toBe(`.a${off}${pressedOff}`)
  })

  it('keeps :not(:active) meaning "not pressed" — which is now ALWAYS', () => {
    expect(disablePointerStatesInSelector('.btn:not(:active)')).toBe(`.btn:not(${pressedOff})`)
  })

  it('does not touch a longer pseudo-class or an escaped identifier', () => {
    expect(disablePointerStatesInSelector('.x:active-descendant')).toBe('.x:active-descendant')
    expect(disablePointerStatesInSelector('.pressed\\:active')).toBe('.pressed\\:active')
    expect(disablePointerStatesInSelector('.x::active')).toBe('.x::active')
  })
})

function styleSheetFor(id: string, css: string): HTMLStyleElement {
  const el = document.createElement('style')
  el.id = id
  el.textContent = css
  document.head.appendChild(el)
  return el
}

/**
 * `suppressHoverInDocument`/`startHoverSuppression`'s actual CSSOM rewrite
 * cannot be observed in this test environment, for TWO independent
 * happy-dom gaps in the version this repo pins: `CSSStyleSheet.ownerNode` is
 * always `undefined` (so the per-sheet predicate this module calls with the
 * owning `<style>` element is never even reached — `owner?.nodeType !== 1`
 * is true for `undefined`, so every sheet is skipped before the predicate
 * runs), and separately `CSSStyleRule.selectorText`'s setter throws
 * (`Attempted to assign to readonly property`), which the module's own
 * `try/catch` (there for a genuinely different reason — a cross-origin
 * stylesheet the document cannot read) would silently swallow anyway. A DOM
 * test asserting either the predicate ran or the rewrite happened would pass
 * for the wrong reason — worse than no test, same posture
 * `canvasScrollUnrollInjector.test.tsx` documents for its own happy-dom gap.
 * `disablePointerStatesInSelector` above is the exhaustive, real coverage of the
 * rewrite LOGIC. What's left, honestly testable here, is that the DOM walk
 * and the lifecycle controller never throw against a real document — the
 * end-to-end rewrite was verified against a real board, the unchanged
 * mechanism `CanvasHoverSuppressionInjector` already ran in production
 * before this refactor.
 */
describe('suppressHoverInDocument / startHoverSuppression — DOM lifecycle', () => {
  afterEach(() => {
    for (const el of document.querySelectorAll('style[id^="test-hover-"]')) el.remove()
  })

  it('does not throw against a document with stylesheets present', () => {
    styleSheetFor('test-hover-a', '.a:hover {}')
    styleSheetFor('test-hover-b', '.b:hover {}')

    expect(() => suppressHoverInDocument(document, () => true)).not.toThrow()
  })

  it('does not throw against a document with no stylesheets at all', () => {
    expect(() => suppressHoverInDocument(document, () => true)).not.toThrow()
  })

  it('start()/dispose() do not throw, and dispose() is safe to call twice', () => {
    styleSheetFor('test-hover-start', '.btn:hover { color: red; }')

    const controller = startHoverSuppression(document, () => true)
    expect(() => controller.dispose()).not.toThrow()
    expect(() => controller.dispose()).not.toThrow()
  })

  it('survives a later head mutation while started (the MutationObserver path does not throw)', async () => {
    styleSheetFor('test-hover-remutate', '.btn:hover { color: red; }')
    const controller = startHoverSuppression(document, () => true)

    styleSheetFor('test-hover-second', '.card:hover { color: green; }')
    await new Promise((resolve) => requestAnimationFrame(resolve))
    await new Promise((resolve) => requestAnimationFrame(resolve))

    controller.dispose()
  })
})
