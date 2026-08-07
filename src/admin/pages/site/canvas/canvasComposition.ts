/**
 * Canvas template composition — resolve which templates WRAP the document
 * currently being edited, so the design canvas can render it exactly as it
 * publishes: inside its matching template chain.
 *
 * This is the editor-side mirror of the publisher's `resolveTemplateChain` +
 * `composeTemplateChain`. The difference: the publisher composes a brand-new
 * tree (rekeying every node) to emit static HTML, whereas the canvas keeps the
 * active document's nodes untouched and editable, rendering only the wrapping
 * templates read-only around it (see `CanvasComposedTree`).
 *
 * Breadth levels (outer → inner): `everywhere` (0) → `postTypes` / `notFound`
 * (1) → a non-template page (2, the innermost terminal). A document is wrapped
 * by every matching template strictly broader than its own level:
 *   - editing a page          → wrapped by the `everywhere` layout;
 *   - editing a postTypes tpl  → wrapped by the `everywhere` layout;
 *   - editing a notFound tpl   → wrapped by the `everywhere` layout (matching
 *     how the public router composes the 404 render);
 *   - editing the everywhere tpl → nothing wraps it (it is the broadest).
 *
 * Perf (Track C3 / audit 06 E9): `resolveEditorWrapperTemplates` takes the
 * TEMPLATE-marked pages directly (`templatePages`) rather than the whole
 * `SiteDocument`, so `CanvasComposedTree` can subscribe with a `useShallow`
 * selector over `site.pages.filter(isTemplatePage)` instead of `s.site`. That
 * keeps its reference stable across an edit to any ordinary (non-template)
 * page — which is the overwhelming majority of pages on a real board — so a
 * keystroke on page B no longer re-renders the `CanvasComposedTree` mounted
 * for page A.
 */

import type { Page } from '@core/page-tree'
import {
  resolveTemplateChainFromPages,
  treeHasOutlet,
  type RouteResolutionContext,
} from '@core/templates'

/** Breadth rank: lower wraps higher. Non-template pages are the innermost. */
function levelRank(page: Page): number {
  const target = page.template?.target
  if (!target) return 2
  return target.kind === 'everywhere' ? 0 : 1
}

/**
 * The templates that wrap `activeDoc` at publish time, ordered outermost-first.
 * Empty when nothing wraps it (the active doc is an `everywhere` layout, or no
 * matching wrapper template has an outlet to host it).
 *
 * `templatePages` is the site's template-marked pages ONLY (every page where
 * `isTemplatePage(page)` is true) — see this module's perf doc above for why
 * the caller passes this narrower list rather than the whole `SiteDocument`.
 */
export function resolveEditorWrapperTemplates(templatePages: Page[], activeDoc: Page): Page[] {
  const myRank = levelRank(activeDoc)
  // An `everywhere` template (rank 0) is the broadest — never wrapped.
  if (myRank <= 0) return []

  const target = activeDoc.template?.target
  let ctx: RouteResolutionContext
  if (target?.kind === 'postTypes') {
    const tableSlug = target.tableSlugs[0]
    if (!tableSlug) return []
    ctx = { kind: 'entry', tableSlug }
  } else {
    ctx = { kind: 'page' }
  }

  // Keep only templates strictly broader than the active doc (so a sibling
  // postTypes winner for the same route never wraps another postTypes template)
  // that actually have an outlet to host the wrapped content.
  return resolveTemplateChainFromPages(templatePages, ctx).filter(
    (page) => page.id !== activeDoc.id && levelRank(page) < myRank && treeHasOutlet(page),
  )
}
