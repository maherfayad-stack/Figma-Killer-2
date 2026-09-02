/**
 * Derived reads over the prototype file. Pure selectors, no HTTP, no writes —
 * the same shape as `commentSelectors`.
 */
import { resolveLinkSource, type PrototypeLink, type ResolvedLinkSource } from '@core/studio-prototype'
import type { EditorStore } from '@site/store/types'

/**
 * Where a link's source element is NOW, recomputed against the live tree.
 *
 * Never read from disk: a persisted confidence would be a claim about a tree
 * that has since changed. A link whose page is not loaded resolves `detached`
 * and therefore not live — the same deliberate under-claim
 * `selectThreadAnchorConfidence` makes, for the same reason.
 */
export function selectLinkSource(s: EditorStore, link: PrototypeLink): ResolvedLinkSource {
  const page = s.site?.pages.find((candidate) => candidate.id === link.source.pageId)
  return resolveLinkSource(link.source.node, page ?? null)
}

/** Every link drawn from `pageId` — what the connector layer renders per frame. */
export function selectLinksFromPage(s: EditorStore, pageId: string): PrototypeLink[] {
  return s.prototype.links.filter((l) => l.source.pageId === pageId)
}

/** The link the inspector is editing, or `null`. */
export function selectSelectedLink(s: EditorStore): PrototypeLink | null {
  if (!s.selectedLinkId) return null
  return s.prototype.links.find((l) => l.id === s.selectedLinkId) ?? null
}

/**
 * Links whose source element no longer exists.
 *
 * Surfaced rather than hidden: a broken link is the visible cost of an edit,
 * and silently dropping it would let a flow rot without anyone noticing.
 */
export function selectBrokenLinks(s: EditorStore): PrototypeLink[] {
  return s.prototype.links.filter((l) => !selectLinkSource(s, l).live)
}
