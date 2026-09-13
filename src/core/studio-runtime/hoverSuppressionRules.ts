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
      rewriteHoverInRuleList(sheet.cssRules)
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
