/**
 * Derived reads over the authored prototype file.
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
 *
 * DERIVED FLOWS ARE NOT HERE. A `CodeFlowEdge` (`s.codeFlow.edges`) is a
 * different shape from an authored `PrototypeLink` and is deliberately kept so
 * — see `docs/features/studio-prototype.md`. It has no `NodeHint` to resolve,
 * so none of the resolution below would mean anything for it.
 */
import { resolveLinkSource, type PrototypeLink, type ResolvedLinkSource } from '@core/studio-prototype'
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

/** The link the inspector is showing, or `null`. */
export function findLink(links: readonly PrototypeLink[], linkId: string | null): PrototypeLink | null {
  if (!linkId) return null
  return links.find((link) => link.id === linkId) ?? null
}

/** Every link drawn from `pageId` — the outgoing flows. */
export function linksFrom(links: readonly PrototypeLink[], pageId: string): PrototypeLink[] {
  return links.filter((link) => link.source.pageId === pageId)
}

/**
 * Each link's source node id AS IT RESOLVES RIGHT NOW, keyed by link id.
 *
 * A link whose source is `detached` is ABSENT rather than mapped to a stale
 * id — the caller draws it broken, and the player refuses to follow it. Built
 * once per render pass and shared, rather than re-resolved per link by every
 * consumer, because resolution walks the page tree.
 */
export function resolvedLinkSourceIds(
  links: readonly PrototypeLink[],
  pages: readonly Page[] | undefined,
): Map<string, string> {
  const resolved = new Map<string, string>()
  for (const link of links) {
    const nodeId = linkSource(link, pages).nodeId
    if (nodeId) resolved.set(link.id, nodeId)
  }
  return resolved
}
