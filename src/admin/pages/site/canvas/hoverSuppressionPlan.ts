/**
 * hoverSuppressionPlan — apply `disableHoverInSelector` to a whole parsed
 * stylesheet, once per distinct sheet TEXT rather than once per frame (S1).
 *
 * ## The measurement
 *
 * `CanvasHoverSuppressionInjector` used to walk every rule of all four
 * page-content stylesheets in every mounting frame. On an 18-frame board that
 * was **~100 ms of a single 255 ms animation frame** during a zoom-out — and
 * it is frame-INVARIANT work, since every frame receives byte-identical CSS.
 * `docs/agent-refs/canvas-internals.md` §Perf names exactly this shape: work
 * that does not depend on the frame being paid N times for one answer.
 *
 * ## The plan
 *
 * The `O(rules)` walk now happens once per distinct sheet text and produces a
 * plan: the index path of every rule that needs a rewrite, plus the rewritten
 * selector. Applying that plan to the next frame's copy of the same sheet is
 * indexed access only — `O(rewritten rules × nesting depth)` instead of
 * `O(all rules)`, and a page's `:hover` rules are a small fraction of its
 * rules.
 *
 * **Why an index path is a valid address in another document.** Identical
 * input text through the same parser yields an identical rule tree, so a path
 * built against one document names the same rule in every other one. That is
 * the whole correctness argument, and `hoverSuppressionPlanCache.test.tsx`
 * pins it by planning against one document and resolving every path in a
 * second.
 *
 * The cache is keyed on the sheet's own source text, which is what the
 * injectors wrote and what the parser consumed. It is bounded: a board settles
 * on a handful of distinct texts (`mc-classes` and `mc-user-styles` resolve
 * viewport units per frame WIDTH), but an edit produces a new one on every
 * keystroke, so the map is cleared wholesale once it passes its cap rather
 * than left to grow with a typing session.
 *
 * KNOWN LIMITATION: the WRITE half never runs under `bun test`. happy-dom
 * exposes `CSSStyleRule.selectorText` as a readonly getter, so assigning to it
 * throws. Planning only reads, which is why the tested seam is
 * {@link planHoverRewrites} and not {@link suppressHoverInSheet}.
 */
import { disableHoverInSelector } from './hoverSuppression'

/**
 * One rule that needs rewriting: where it sits in the sheet's rule tree, and
 * what its selector becomes. `path` is a chain of `cssRules` indices — `[3]`
 * is the sheet's fourth rule, `[3, 1]` the second rule inside it.
 */
export interface HoverRewrite {
  path: number[]
  selector: string
}

/** Distinct sheet texts to remember plans for. See this module's header. */
const PLAN_CACHE_LIMIT = 24
const plansBySheetText = new Map<string, HoverRewrite[]>()

/** The full `O(rules)` walk. Runs once per distinct sheet text, not per frame. */
function collectRewrites(rules: CSSRuleList, prefix: number[], out: HoverRewrite[]): void {
  for (let i = 0; i < rules.length; i += 1) {
    const rule = rules[i]
    if (!rule) continue
    const path = [...prefix, i]
    // A `CSSStyleRule` can be BOTH — native CSS nesting gives a style rule its
    // own child rules — so this is two independent checks, not a branch.
    const styleRule = rule as CSSStyleRule
    if (typeof styleRule.selectorText === 'string') {
      const next = disableHoverInSelector(styleRule.selectorText)
      if (next !== styleRule.selectorText) out.push({ path, selector: next })
    }
    // `@media`, `@supports`, `@layer`, `@container` — and nested rules.
    const nested = (rule as CSSGroupingRule).cssRules
    if (nested) collectRewrites(nested, path, out)
  }
}

/**
 * The rewrite plan for `sheet`, built from (and cached against) the exact
 * `text` it was parsed from.
 *
 * Exported as this module's testable seam. Neither the component nor
 * {@link suppressHoverInSheet} can be exercised under `bun test`: happy-dom
 * leaves `CSSStyleSheet.ownerNode` `undefined` (so the content-sheet allowlist
 * matches nothing) AND makes `CSSStyleRule.selectorText` a readonly getter (so
 * the rewrite itself throws). Planning only READS, so the property the whole
 * cache rests on — that an index path built against one document addresses the
 * same rule in every other document parsed from the same text — is pinned
 * here. See `src/__tests__/canvas/hoverSuppressionPlanCache.test.tsx`.
 */
export function planHoverRewrites(sheet: CSSStyleSheet, text: string): HoverRewrite[] {
  const cached = plansBySheetText.get(text)
  if (cached) return cached
  const plan: HoverRewrite[] = []
  collectRewrites(sheet.cssRules, [], plan)
  if (plansBySheetText.size >= PLAN_CACHE_LIMIT) plansBySheetText.clear()
  plansBySheetText.set(text, plan)
  return plan
}

function applyPlan(sheet: CSSStyleSheet, plan: HoverRewrite[]): void {
  for (const { path, selector } of plan) {
    let rules: CSSRuleList | undefined = sheet.cssRules
    let rule: CSSRule | undefined
    for (const index of path) {
      rule = rules?.[index] ?? undefined
      if (!rule) break
      rules = (rule as CSSGroupingRule).cssRules
    }
    if (!rule) continue
    const styleRule = rule as CSSStyleRule
    // An invalid selector makes the setter a silent no-op, so only write when
    // there is a real change to make. A rule already carrying the rewritten
    // selector — this pass re-running over a sheet nothing reparsed — short
    // circuits here too.
    if (styleRule.selectorText !== selector) styleRule.selectorText = selector
  }
}

/** Suppress `:hover` in one parsed sheet, given the source text it came from. */
export function suppressHoverInSheet(sheet: CSSStyleSheet, sourceText: string): void {
  applyPlan(sheet, planHoverRewrites(sheet, sourceText))
}
