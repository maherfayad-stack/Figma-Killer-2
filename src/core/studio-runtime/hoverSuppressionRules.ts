/**
 * hoverSuppressionRules — rewriting a CSS selector so its `:hover` half can
 * never match, plus the document-wide walk that applies the rewrite. Shared
 * by the portal-mode `CanvasHoverSuppressionInjector` (an iframe holding a
 * PORTALED React tree, same-origin, `targetDocument` reachable directly) and
 * the in-frame live runtime (`runtime.ts`, cross-origin — this module ships
 * inside that bundle too, so it must stay free of admin/store imports).
 *
 * ## Why a rewrite, and not a stylesheet
 *
 * Every other thing the design canvas neutralises — cursors, text selection,
 * animations, smooth scrolling — is a PROPERTY, so an injected `!important`
 * rule can override it. Hover is not a property, it is a MATCH:
 * `.btn:hover { background: X }` names an arbitrary declaration block, and no
 * blanket rule can undo an arbitrary declaration without knowing what it set.
 * Nor can `:hover` be prevented at the pointer — the canvas's own selection
 * and hover ring are ordinary `onMouseEnter` handlers (or, in the live
 * runtime, ordinary pointer listeners) on the page's real elements, so
 * `pointer-events: none` would take click-to-select with it.
 *
 * What is left is to stop the selector from matching, which is what this
 * does: `:hover` is swapped for a class token that nothing in the frame
 * wears.
 *
 * ## Why a CLASS, specifically
 *
 * Two reasons, and both matter:
 *
 *   - **Specificity is preserved.** `:hover` is a pseudo-class, weight
 *     (0,1,0); a class is (0,1,0). Every rewritten rule keeps its exact
 *     position in the cascade, so the rules that DO still match are ordered
 *     among themselves exactly as the author wrote them.
 *   - **Negation stays honest.** `.btn:not(:hover)` means "when not hovered",
 *     and with hover disabled it should apply ALWAYS. Rewriting to
 *     `.btn:not(.studio-hover-off)` gives precisely that, for free. Deleting
 *     the rule, or rewriting to something that always matches, would invert
 *     it.
 *
 * The forced-state preview is untouched and is the way you still see a hover
 * state: `ClassStyleInjector`'s `mc-classes-force-state` paints a `:hover`
 * rule's declarations onto the SELECTED node keyed by node id, with no
 * `:hover` in the selector at all — it never needed the pointer, and this
 * never sees it. A live frame has no `ClassStyleInjector` (no class registry
 * to regenerate — it renders the project's own real CSS), so it has no
 * forced-state preview either; that gap is inherent to Tier 2, not a bug in
 * this module.
 */

/**
 * The class token `:hover` becomes. Nothing in a canvas frame wears it, and
 * nothing may be given it — the whole contract is that it never matches.
 */
export const HOVER_DISABLED_CLASS = 'studio-hover-off'

const HOVER_PSEUDO = ':hover'
/** Characters that would make `:hover…` a longer identifier, not the pseudo-class. */
const IDENT_CHAR = /[A-Za-z0-9_-]/

/**
 * Rewrite every `:hover` in one selector so it cannot match. Returns the
 * selector unchanged when there is nothing to do.
 *
 * Operates on a single selector as CSSOM reports it (`CSSStyleRule
 * .selectorText`) — already normalised, with comments stripped — so the only
 * text this has to step around is a quoted string inside an attribute
 * selector, e.g. `[title=":hover"]`.
 */
export function disableHoverInSelector(selector: string): string {
  if (!selector.includes(HOVER_PSEUDO)) return selector

  let out = ''
  let quote: string | null = null

  for (let i = 0; i < selector.length; i += 1) {
    const char = selector[i]!

    if (quote !== null) {
      out += char
      // A quote preceded by a backslash is an escaped quote, not the end.
      if (char === quote && selector[i - 1] !== '\\') quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      out += char
      continue
    }
    if (char !== ':' || !selector.startsWith(HOVER_PSEUDO, i)) {
      out += char
      continue
    }
    // `::hover` is not a real selector, and an escaped `\:hover` is part of an
    // identifier (Tailwind's `.hover\:bg-red`) — in both cases the colon is
    // not ours to touch.
    if (selector[i - 1] === ':' || selector[i - 1] === '\\') {
      out += char
      continue
    }
    // `:hovercard` / `:hover-thing` would be a different pseudo-class.
    const after = selector[i + HOVER_PSEUDO.length]
    if (after !== undefined && (IDENT_CHAR.test(after) || after === '(')) {
      out += char
      continue
    }
    out += `.${HOVER_DISABLED_CLASS}`
    i += HOVER_PSEUDO.length - 1
  }

  return out
}

/**
 * One rule that needs rewriting: where it sits in the sheet's rule tree, and
 * what its selector becomes. `path` is a chain of `cssRules` indices — `[3]`
 * is the sheet's fourth rule, `[3, 1]` the second rule inside it.
 */
export interface HoverRewrite {
  path: number[]
  selector: string
}

/** Distinct sheet texts to remember plans for. See {@link planHoverRewrites}. */
const PLAN_CACHE_LIMIT = 24
const plansBySheetText = new Map<string, HoverRewrite[]>()

/** The full `O(rules)` walk, recorded as a plan. Runs once per distinct sheet text. */
function collectRewrites(rules: CSSRuleList, prefix: number[], out: HoverRewrite[]): void {
  for (let i = 0; i < rules.length; i += 1) {
    const rule = rules[i]
    if (!rule) continue
    const path = [...prefix, i]
    const styleRule = rule as CSSStyleRule
    if (typeof styleRule.selectorText === 'string') {
      const next = disableHoverInSelector(styleRule.selectorText)
      if (next !== styleRule.selectorText) out.push({ path, selector: next })
    }
    const nested = (rule as CSSGroupingRule).cssRules
    if (nested) collectRewrites(nested, path, out)
  }
}

/**
 * The rewrite plan for `sheet`, built from — and cached against — the exact
 * `text` it was parsed from (S1, `perf-07`).
 *
 * `CanvasHoverSuppressionInjector` used to walk every rule of all four
 * page-content stylesheets in every mounting frame. On an 18-frame board that
 * was ~100 ms of a single 255 ms animation frame during a zoom-out — and it is
 * frame-INVARIANT work, since every frame receives byte-identical CSS.
 *
 * **Why an index path is a valid address in another document.** Identical
 * input text through the same parser yields an identical rule tree, so a path
 * built against one document names the same rule in every other one. That is
 * the whole correctness argument, and `hoverSuppressionPlanCache.test.tsx`
 * pins it by planning against one document and resolving every path in a
 * second.
 *
 * The cache is bounded: a board settles on a handful of distinct texts
 * (`mc-classes` and `mc-user-styles` resolve viewport units per frame WIDTH),
 * but an edit produces a new one on every keystroke, so the map is cleared
 * wholesale once it passes its cap rather than left to grow with a typing
 * session.
 *
 * This is also the module's testable seam: happy-dom exposes
 * `CSSStyleRule.selectorText` as a readonly getter, so the WRITE half throws
 * under `bun test`. Planning only reads.
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

/**
 * Applying a plan is indexed access only — `O(rewritten rules × nesting
 * depth)` instead of `O(all rules)`, and a page's `:hover` rules are a small
 * fraction of its rules.
 */
function applyHoverPlan(sheet: CSSStyleSheet, plan: readonly HoverRewrite[]): void {
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

/**
 * Rewrites every rule in `rules`, recursing into grouping rules (`@media`,
 * `@supports`, `@layer`, `@container`) and nested style rules (native CSS
 * nesting gives a `CSSStyleRule` its own `cssRules`, so the two checks below
 * are independent, not a branch).
 */
function rewriteHoverInRuleList(rules: CSSRuleList): void {
  for (const rule of Array.from(rules)) {
    const styleRule = rule as CSSStyleRule
    if (typeof styleRule.selectorText === 'string') {
      const next = disableHoverInSelector(styleRule.selectorText)
      // An invalid selector makes the setter a silent no-op, so only write
      // when there is a real change to make.
      if (next !== styleRule.selectorText) styleRule.selectorText = next
    }
    const nested = (rule as CSSGroupingRule).cssRules
    if (nested) rewriteHoverInRuleList(nested)
  }
}

/**
 * Walks every stylesheet in `doc` whose owner node `shouldRewrite` accepts,
 * rewriting `:hover` out of place in the CSSOM.
 *
 * The predicate is the one thing that legitimately differs between callers:
 *
 *   - the portal injector uses an ALLOWLIST of the four page-content
 *     stylesheet ids it shares a document with (its own editor chrome uses
 *     real `:hover` affordances and must never be touched) — see
 *     `CanvasHoverSuppressionInjector.tsx`.
 *   - the live runtime has no separate "editor chrome" stylesheet id
 *     namespace to allowlist (a live frame IS the project's own document,
 *     with the runtime's own overlay stylesheets mixed in) — it uses a
 *     DENYLIST of its own overlay ids instead.
 *
 * `nodeType` rather than `instanceof Element`: a stylesheet owner may be from
 * a different realm (the iframe's own `Element`, not this module's), and a
 * node-type check is realm-agnostic.
 */
export function suppressHoverInDocument(doc: Document, shouldRewrite: (owner: Element) => boolean): void {
  for (const sheet of Array.from(doc.styleSheets)) {
    const owner = sheet.ownerNode as Element | null
    if (owner?.nodeType !== 1 || !shouldRewrite(owner)) continue
    try {
      // The text the injector wrote IS what the parser consumed, so it keys
      // the plan exactly. A sheet with no text of its own (a `<link>`) has
      // nothing to key on and takes the uncached walk.
      const text = owner.textContent
      if (text) applyHoverPlan(sheet, planHoverRewrites(sheet, text))
      else rewriteHoverInRuleList(sheet.cssRules)
    } catch (_err) {
      // A stylesheet the document cannot read (cross-origin `@import`). There
      // is nothing to rewrite and nothing to report — the browser refusing to
      // expose someone else's rules is not an error in this frame.
    }
  }
}

export interface HoverSuppressionController {
  dispose(): void
}

/**
 * Starts the re-run loop: every one of the content stylesheets rewrites its
 * own `<style>` element's `textContent` whenever ITS input changes, which
 * throws away the whole sheet and reparses it from the author's text —
 * undoing this pass. A `MutationObserver` on `<head>` catches that and
 * re-applies, coalesced to one animation frame so a burst of writes costs one
 * walk.
 *
 * No cleanup pass restores the original selectors on `dispose()` — a
 * document that had hover suppressed never becomes one that should not (both
 * callers tear down the whole document/iframe instead of un-suppressing it
 * in place).
 */
export function startHoverSuppression(
  doc: Document,
  shouldRewrite: (owner: Element) => boolean,
): HoverSuppressionController {
  const head = doc.head
  const view = doc.defaultView
  const raf = view?.requestAnimationFrame?.bind(view) ?? requestAnimationFrame
  const cancelRaf = view?.cancelAnimationFrame?.bind(view) ?? cancelAnimationFrame
  const MutationObserverCtor = view?.MutationObserver ?? MutationObserver

  let pending: number | null = null
  const run = () => {
    pending = null
    suppressHoverInDocument(doc, shouldRewrite)
  }
  const schedule = () => {
    pending ??= raf(run)
  }

  let observer: MutationObserver | null = null
  if (head) {
    run()
    observer = new MutationObserverCtor(schedule)
    observer.observe(head, { childList: true, subtree: true, characterData: true })
  }

  return {
    dispose() {
      observer?.disconnect()
      if (pending !== null) cancelRaf(pending)
    },
  }
}
