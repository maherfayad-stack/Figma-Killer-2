/**
 * hoverSuppression — rewriting a CSS selector so its `:hover` half can never
 * match, for design canvas frames.
 *
 * ## Why a rewrite, and not a stylesheet
 *
 * Every other thing the design canvas neutralises — cursors, text selection,
 * animations, smooth scrolling — is a PROPERTY, so an injected `!important`
 * rule can override it (`iframeBodyReset`, `CanvasAnimationInjector`). Hover
 * is not a property, it is a MATCH: `.btn:hover { background: X }` names an
 * arbitrary declaration block, and no blanket rule can undo an arbitrary
 * declaration without knowing what it set. Nor can `:hover` be prevented at
 * the pointer — the canvas's own selection and hover ring are ordinary
 * `onMouseEnter` handlers on the page's real elements, so `pointer-events:
 * none` would take click-to-select with it.
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
 * never sees it.
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
