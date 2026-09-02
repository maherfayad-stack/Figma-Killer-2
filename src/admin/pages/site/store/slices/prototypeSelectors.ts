/**
 * Derived reads over the prototype file. Pure selectors, no HTTP, no writes —
 * the same shape as `commentSelectors`.
 */
import {
  deriveCodeLinks,
  mergeCodeLinks,
  resolveLinkSource,
  type PrototypeLink,
  type ResolvedLinkSource,
} from '@core/studio-prototype'
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

/**
 * Every link the board should DRAW: the authored ones plus the ones derived
 * from the user's real navigation code.
 *
 * Derived links are recomputed here rather than stored, which is what keeps
 * them honest — delete the handler and the connector is simply gone, with no
 * stale row to clean up. Only ever called in prototype mode, because deriving
 * walks every node of every loaded page.
 */
export function selectVisibleLinks(s: EditorStore): PrototypeLink[] {
  const pages = s.site?.pages
  if (!pages || pages.length === 0) return s.prototype.links

  const derived: PrototypeLink[] = []
  for (const page of pages) {
    derived.push(...deriveCodeLinks(page.id, page, pages))
  }
  return mergeCodeLinks(s.prototype.links, derived)
}

/** Every link drawn from `pageId` — what the connector layer renders per frame. */
export function selectLinksFromPage(s: EditorStore, pageId: string): PrototypeLink[] {
  return s.prototype.links.filter((l) => l.source.pageId === pageId)
}

/**
 * The link the inspector is showing, or `null`.
 *
 * Searches the DERIVED set too: a code-derived connector is selectable, so the
 * user can ask what it is and where it came from. The inspector then refuses to
 * edit it, which is a more useful answer than a connector that ignores clicks.
 */
export function selectSelectedLink(s: EditorStore): PrototypeLink | null {
  if (!s.selectedLinkId) return null
  return selectVisibleLinks(s).find((l) => l.id === s.selectedLinkId) ?? null
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
