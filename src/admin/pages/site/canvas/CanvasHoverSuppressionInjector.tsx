/**
 * CanvasHoverSuppressionInjector — stops the page's own `:hover` styles from
 * firing inside a DESIGN canvas frame. Live frames are a visitor preview and
 * keep real hover, exactly as `CanvasAnimationInjector` keeps real motion.
 *
 * ## Why
 *
 * A design frame is a still working surface. Moving the pointer across a
 * board to reach a node should not repaint every button, card and link it
 * crosses — and worse, hover states change LAYOUT often enough (a padding, a
 * border, a scale) that the selection ring and the resize handles measure a
 * box the element only has while the cursor is on it.
 *
 * ## How, and why it is a rewrite rather than a stylesheet
 *
 * See `hoverSuppression.ts` — hover is a match, not a property, so nothing
 * can override it, and the pointer cannot be taken away from content that
 * carries the canvas's own `onMouseEnter` selection handlers. So the
 * selectors themselves are rewritten in the CSSOM, in place.
 *
 * ## What it will and will not touch
 *
 * An ALLOWLIST of the four page-content stylesheets, never a denylist: the
 * editor's own chrome (`studio-editor-chrome`, the selection overlay, the
 * resize handles) lives in this same document and uses `:hover` for real
 * affordances. A denylist would break those the moment anyone adds a fifth
 * chrome stylesheet; an allowlist fails closed, leaving a page rule hovering,
 * which is a visible nuisance rather than a broken editor.
 *
 * `mc-classes-force-state` is deliberately NOT in the list, and needs no
 * exemption anyway: it paints a `:hover` rule's declarations onto the
 * selected node keyed by node id (`generateForcedStateCSS`), with no `:hover`
 * in the selector. That panel-driven preview is how you still see a hover
 * state here, and it is the only way that ever worked — you cannot toggle
 * `:hover` from the DOM.
 *
 * ## Why it re-runs
 *
 * Every one of those four injectors rewrites its `<style>` element's
 * `textContent` whenever its input changes (a class edit, a breakpoint
 * change, a re-parse), which throws away the whole sheet and reparses it from
 * the author's text — undoing this pass. A `MutationObserver` on `<head>`
 * catches that and re-applies, coalesced to one animation frame so a burst of
 * injector writes costs one walk.
 *
 * No cleanup pass restores the original selectors: a live frame is a
 * different iframe in a different component tree (`CanvasLiveSurface` vs the
 * design canvas), so a document that had hover suppressed never becomes one
 * that should not.
 */
import { useEffect } from 'react'
import { disableHoverInSelector } from './hoverSuppression'

/**
 * The page-content stylesheets, by the `id` each injector gives its `<style>`
 * element. Kept here rather than imported from four modules that each keep it
 * as a private `STYLE_TAG_ID` const — the list is this component's own
 * question ("whose CSS belongs to the page?"), not those modules' API.
 */
const CONTENT_STYLE_IDS = new Set(['mc-vendor', 'mc-authored', 'mc-classes', 'mc-user-styles'])

function rewriteRules(rules: CSSRuleList): void {
  for (const rule of Array.from(rules)) {
    // A `CSSStyleRule` can be BOTH — native CSS nesting gives a style rule its
    // own child rules — so this is two independent checks, not a branch.
    const styleRule = rule as CSSStyleRule
    if (typeof styleRule.selectorText === 'string') {
      const next = disableHoverInSelector(styleRule.selectorText)
      // An invalid selector makes the setter a silent no-op, so only write
      // when there is a real change to make.
      if (next !== styleRule.selectorText) styleRule.selectorText = next
    }
    // `@media`, `@supports`, `@layer`, `@container` — and nested rules.
    const nested = (rule as CSSGroupingRule).cssRules
    if (nested) rewriteRules(nested)
  }
}

function suppressHover(doc: Document): void {
  for (const sheet of Array.from(doc.styleSheets)) {
    // `nodeType` rather than `instanceof Element`: this module's `Element` is
    // the PARENT window's, and an element from the iframe's realm is not an
    // instance of it. A node-type check is realm-agnostic.
    const owner = sheet.ownerNode as Element | null
    if (owner?.nodeType !== 1 || !CONTENT_STYLE_IDS.has(owner.id)) continue
    try {
      rewriteRules(sheet.cssRules)
    } catch (_err) {
      // A stylesheet the document cannot read (cross-origin `@import`). There
      // is nothing to rewrite and nothing to report — the browser refusing to
      // expose someone else's rules is not an error in this frame.
    }
  }
}

interface CanvasHoverSuppressionInjectorProps {
  targetDocument: Document | null
}

export function CanvasHoverSuppressionInjector({ targetDocument }: CanvasHoverSuppressionInjectorProps) {
  useEffect(() => {
    const doc = targetDocument
    if (!doc) return

    let pending: number | null = null
    const view = doc.defaultView ?? window
    const run = () => {
      pending = null
      suppressHover(doc)
    }
    const schedule = () => {
      pending ??= view.requestAnimationFrame(run)
    }

    run()
    const observer = new (view.MutationObserver ?? MutationObserver)(schedule)
    observer.observe(doc.head, { childList: true, subtree: true, characterData: true })

    return () => {
      observer.disconnect()
      if (pending !== null) view.cancelAnimationFrame(pending)
    }
  }, [targetDocument])

  return null
}
