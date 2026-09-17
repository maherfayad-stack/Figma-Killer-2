/**
 * `CanvasHoverSuppressionInjector`'s plan cache (S1).
 *
 * Every mounting frame used to walk every rule of all four page-content
 * stylesheets to swap `:hover` out of their selectors. Measured on an 18-frame
 * board, that was ~100 ms of a single 255 ms animation frame during a
 * zoom-out — and it is frame-INVARIANT work, since every frame receives
 * byte-identical CSS. The walk now happens once per distinct sheet text and
 * produces an index-path plan the remaining frames simply apply.
 *
 * The plan is only sound because identical text through the same parser yields
 * an identical rule tree, so a path built against one document addresses the
 * same rule in every other. That is the entire risk of the change, and it is
 * what this file pins.
 *
 * KNOWN LIMITATION — why this tests the PLAN and not the rewrite. Neither the
 * injector component nor the write half runs under `bun test`: happy-dom
 * leaves `CSSStyleSheet.ownerNode` `undefined` (so the four-id content
 * allowlist matches nothing) and exposes `CSSStyleRule.selectorText` as a
 * readonly getter (so assigning to it throws `Attempted to assign to readonly
 * property`). Both halves are browser-only. Planning is read-only, so the
 * cross-document property above is testable here; the rewrite itself is
 * covered by `hoverSuppressionRules`' own selector tests and by the
 * canvas in a real browser.
 *
 * @see src/core/studio-runtime/hoverSuppressionRules.ts
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { HOVER_DISABLED_CLASS, disableHoverInSelector, planHoverRewrites } from '@core/studio-runtime'

const SHEET = [
  '.plain { color: red }',
  '.btn:hover { background: blue }',
  'a:hover, .card:hover .title { color: green }',
  '.only:not(:hover) { opacity: 1 }',
  '@media (min-width: 100px) { .inner:hover { color: teal } }',
].join('\n')

/** A frame document holding one page-content stylesheet, as an injector writes it. */
function makeFrameSheet(text: string): CSSStyleSheet {
  const frame = document.createElement('iframe')
  document.body.appendChild(frame)
  const doc = frame.contentDocument
  if (!doc) throw new Error('iframe has no contentDocument')
  const style = doc.createElement('style')
  style.textContent = text
  doc.head.appendChild(style)
  const sheet = doc.styleSheets[0] as CSSStyleSheet | undefined
  if (!sheet) throw new Error('style element produced no stylesheet')
  return sheet
}

/** Follow an index path to the rule it names, exactly as `applyPlan` does. */
function ruleAt(sheet: CSSStyleSheet, path: readonly number[]): CSSStyleRule | undefined {
  let rules: CSSRuleList | undefined = sheet.cssRules
  let rule: CSSRule | undefined
  for (const index of path) {
    rule = rules?.[index] ?? undefined
    if (!rule) return undefined
    rules = (rule as CSSGroupingRule).cssRules
  }
  return rule as CSSStyleRule | undefined
}

afterEach(() => {
  for (const frame of Array.from(document.querySelectorAll('iframe'))) frame.remove()
})

describe('planHoverRewrites', () => {
  it('names every rule that carries a :hover, and nothing else', () => {
    const plan = planHoverRewrites(makeFrameSheet(SHEET), SHEET)
    const selectors = plan.map((entry) => entry.selector)
    expect(selectors).toContain(`.btn.${HOVER_DISABLED_CLASS}`)
    expect(selectors).toContain(`.only:not(.${HOVER_DISABLED_CLASS})`)
    // `.plain` has no `:hover`, so it must not be in the plan at all.
    expect(selectors.some((selector) => selector.includes('.plain'))).toBe(false)
    expect(selectors.join('\n')).not.toContain(':hover')
  })

  it('reaches rules nested inside an at-rule', () => {
    const plan = planHoverRewrites(makeFrameSheet(SHEET), SHEET)
    const nested = plan.find((entry) => entry.path.length > 1)
    expect(nested).toBeDefined()
    expect(nested?.selector).toBe(`.inner.${HOVER_DISABLED_CLASS}`)
  })

  it('addresses the same rules in a SECOND document parsed from the same text', () => {
    // The load-bearing property: this is why one frame may plan for all of them.
    const plan = planHoverRewrites(makeFrameSheet(SHEET), SHEET)
    const other = makeFrameSheet(SHEET)
    expect(plan.length).toBeGreaterThan(0)
    for (const { path, selector } of plan) {
      const rule = ruleAt(other, path)
      expect(rule).toBeDefined()
      expect(disableHoverInSelector(rule?.selectorText ?? '')).toBe(selector)
    }
  })

  it('returns the very same plan for a repeat of the same text — the cache hit', () => {
    const first = planHoverRewrites(makeFrameSheet(SHEET), SHEET)
    const second = planHoverRewrites(makeFrameSheet(SHEET), SHEET)
    expect(second).toBe(first)
  })

  it('plans nothing for a sheet with no :hover anywhere', () => {
    const plain = '.a { color: red }\n.b { color: blue }'
    expect(planHoverRewrites(makeFrameSheet(plain), plain)).toEqual([])
  })
})
