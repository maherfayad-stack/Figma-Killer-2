/**
 * prototypeModel — the pure operations over a `PrototypeFile`.
 *
 * Every function here returns a new file rather than mutating, matching
 * `@core/studio-board`'s `boardsModel`. No I/O, no store, no React.
 */
import { resolveNodeAnchor, type AnchorConfidence, type NodeHint } from '@core/studio-anchor'
import type { NodeTree } from '@core/page-tree'
import { DEFAULT_PAGE_KIND, type PageKind } from '@core/studio-board'
import {
  ACTION_TRANSITIONS,
  actionTakesTarget,
  type PrototypeAction,
  type PrototypeFile,
  type PrototypeLink,
  type PrototypeTransition,
} from './types'

/**
 * What a link to a page of this kind should do by default.
 *
 * The kind vocabulary (`@core/studio-board`'s `PageKind`) already encodes the
 * presentation the designer chose when they created the screen, so asking them
 * again at link time would be asking twice. A sheet page is presented as a
 * sheet; a popup page as a popup; anything else replaces the screen.
 *
 * It is a DEFAULT, not a constraint — the inspector can still change it.
 */
export function defaultLinkPresentation(
  targetKind: PageKind = DEFAULT_PAGE_KIND,
): { action: PrototypeAction; transition: PrototypeTransition } {
  switch (targetKind) {
    case 'popup':
      return { action: 'overlay', transition: 'popup' }
    case 'sheet-small':
    case 'sheet-large':
      return { action: 'overlay', transition: 'sheet' }
    case 'screen':
      return { action: 'navigate', transition: 'slide-left' }
  }
}

/**
 * Whether a transition is legal for an action. The inspector uses this to build
 * its options; `serialize.ts` uses `ACTION_TRANSITIONS` directly to repair.
 */
export function transitionsForAction(action: PrototypeAction): readonly PrototypeTransition[] {
  return ACTION_TRANSITIONS[action]
}

export function upsertPrototypeLink(file: PrototypeFile, link: PrototypeLink): PrototypeFile {
  const index = file.links.findIndex((l) => l.id === link.id)
  if (index === -1) return { ...file, links: [...file.links, link] }
  const links = [...file.links]
  links[index] = link
  return { ...file, links }
}

export function removePrototypeLink(file: PrototypeFile, linkId: string): PrototypeFile {
  const links = file.links.filter((l) => l.id !== linkId)
  return links.length === file.links.length ? file : { ...file, links }
}

/** Every link whose SOURCE element lives on `pageId` — the outgoing flows. */
export function linksFromPage(file: PrototypeFile, pageId: string): PrototypeLink[] {
  return file.links.filter((l) => l.source.pageId === pageId)
}

/** Every link that lands ON `pageId` — the incoming flows. */
export function linksToPage(file: PrototypeFile, pageId: string): PrototypeLink[] {
  return file.links.filter((l) => l.targetPageId === pageId)
}

/**
 * Drop links that can no longer mean anything because a page they name is gone.
 *
 * Deleting a page is the one edit that can orphan a link without touching the
 * link's own source, so pruning is the caller's job at page-delete time — not
 * something the serializer can do, since it has never heard of the page list.
 *
 * A `back`/`close` link has no target, so only its source page is checked.
 */
export function prunePrototypeLinks(file: PrototypeFile, pageIds: Iterable<string>): PrototypeFile {
  const live = pageIds instanceof Set ? pageIds : new Set(pageIds)
  const links = file.links.filter((l) => {
    if (!live.has(l.source.pageId)) return false
    if (!actionTakesTarget(l.action)) return true
    return l.targetPageId !== null && live.has(l.targetPageId)
  })
  return links.length === file.links.length ? file : { ...file, links }
}

export interface ResolvedLinkSource {
  confidence: AnchorConfidence
  /** The element to draw the connector from NOW, or `null` when it is gone. */
  nodeId: string | null
  /** Whether the link can still be followed in Play mode. */
  live: boolean
}

/**
 * Re-resolve a link's source element against the live page tree.
 *
 * The POLICY here differs from `@core/studio-comments`' agent gate on purpose,
 * which is why neither lives in `@core/studio-anchor`. A comment refuses on
 * `drifted`, because the comment is ABOUT the text that changed. A link does
 * not: relabelling a button does not change where it goes, so a `drifted`
 * source is still followable. Only `detached` — the element is gone — breaks a
 * link, and a broken link is drawn as broken rather than silently dropped, so
 * the user can see what their edit cost.
 */
export function resolveLinkSource(
  hint: NodeHint,
  tree: NodeTree | null | undefined,
): ResolvedLinkSource {
  const { confidence, nodeId } = resolveNodeAnchor(hint, tree)
  return { confidence, nodeId, live: confidence !== 'detached' && confidence !== 'unanchored' }
}
