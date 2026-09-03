/**
 * Derived reads over the prototype file.
 *
 * EVERY FUNCTION HERE TAKES PLAIN VALUES, NOT THE STORE, AND THAT IS
 * DELIBERATE. Each one builds a fresh array or object, so passing one to
 * `useEditorStore(...)` as a selector is an infinite render loop: zustand
 * compares the result with `Object.is`, a new reference is never equal to the
 * last one, so every render schedules another. That is not hypothetical — it
 * shipped, and it took the whole editor down with "Maximum update depth
 * exceeded" before the canvas could mount.
 *
 * The rule: **a zustand selector must return something already in the store.**
 * Read `s.prototype.links` and `s.site?.pages` — both stable references that
 * only change when they really change — and call these helpers in the render
 * body, where the React Compiler memoizes them for free.
 *
 * They are named without the `select` prefix for exactly that reason: nothing
 * here is a selector.
 */
import {
  deriveCodeLinks,
  mergeCodeLinks,
  resolveLinkSource,
  type PrototypeLink,
  type ResolvedLinkSource,
} from '@core/studio-prototype'
import type { Page } from '@core/page-tree'

/**
 * Where a link's source element is NOW, recomputed against the live tree.
 *
 * Never read from disk: a persisted confidence would be a claim about a tree
 * that has since changed. A link whose page is not loaded resolves `detached`
 * and therefore not live — the same deliberate under-claim comments make.
 */
export function linkSource(link: PrototypeLink, pages: readonly Page[] | undefined): ResolvedLinkSource {
  const page = pages?.find((candidate) => candidate.id === link.source.pageId)
  return resolveLinkSource(link.source.node, page ?? null)
}

/**
 * Every link the board should DRAW: the authored ones plus the ones derived
 * from the user's real navigation code.
 *
 * Derived links are recomputed rather than stored, which is what keeps them
 * honest — delete the handler and the connector is gone, with no stale row to
 * clean up. Call it only in prototype mode: deriving walks every node of every
 * loaded page.
 */
export function visibleLinks(
  authored: readonly PrototypeLink[],
  pages: readonly Page[] | undefined,
): PrototypeLink[] {
  if (!pages || pages.length === 0) return [...authored]

  const derived: PrototypeLink[] = []
  for (const page of pages) {
    derived.push(...deriveCodeLinks(page.id, page, pages))
  }
  return mergeCodeLinks(authored, derived)
}

/** The link the inspector is showing, or `null`. Searches the derived set too. */
export function findLink(links: readonly PrototypeLink[], linkId: string | null): PrototypeLink | null {
  if (!linkId) return null
  return links.find((link) => link.id === linkId) ?? null
}

/** Every link drawn from `pageId` — the outgoing flows. */
export function linksFrom(links: readonly PrototypeLink[], pageId: string): PrototypeLink[] {
  return links.filter((link) => link.source.pageId === pageId)
}

/**
 * Links whose source element no longer exists.
 *
 * Surfaced rather than hidden: a broken link is the visible cost of an edit,
 * and silently dropping it would let a flow rot without anyone noticing.
 */
export function brokenLinks(
  links: readonly PrototypeLink[],
  pages: readonly Page[] | undefined,
): PrototypeLink[] {
  return links.filter((link) => !linkSource(link, pages).live)
}
