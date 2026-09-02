/**
 * codeLinks — the connectors Studio DERIVES from the user's real navigation
 * code, rather than the ones a designer drew.
 *
 * This is the part of the board Figma structurally cannot have: a Figma file
 * has no source to read, so every flow in it was drawn by hand and is true only
 * as long as someone maintains it. Here the flows a project already has show up
 * on the board on day one, and they cannot drift, because they are re-derived
 * from the tree on every load and never stored.
 *
 * NOTHING HERE IS PERSISTED. `.studio/prototype.json` holds only
 * `origin: 'design'` links. A derived link is recomputed from the page tree
 * every time — which is exactly what makes it honest: delete the handler and
 * the connector is simply gone, with no stale row to clean up.
 *
 * The destination is matched against a page's SLUG and id, both with and
 * without a leading slash, because a route string in a real project
 * (`'/sign-in'`, `'sign-in'`) and Studio's page identity are two vocabularies
 * for the same screen. A destination that matches no page produces no link
 * rather than a broken one: the project may route somewhere Studio has not
 * imported, and inventing a dangling connector for it would be a claim about
 * the user's app that Studio cannot support.
 */
import type { NodeTree, BaseNode } from '@core/page-tree'
import { captureNodeHint } from '@core/studio-anchor'
import type { PrototypeLink } from './types'

/** The minimum a page has to expose for a route string to be matched to it. */
export interface RoutablePage {
  id: string
  slug?: string
}

/**
 * A stable id for a derived link.
 *
 * Derived from the node and the handler rather than random, so the same code
 * produces the same link id across reloads — which is what lets the inspector
 * keep a derived connector selected while the page re-parses under it.
 */
export function codeLinkId(pageId: string, nodeId: string, propName: string): string {
  return `code:${pageId}:${nodeId}:${propName}`
}

/** Normalise a route string or page identity to one comparable form. */
function routeKey(value: string): string {
  return value.trim().replace(/^\/+/, '').replace(/\/+$/, '').toLowerCase()
}

/** The page a destination string refers to, or `null`. */
export function pageForDestination(pages: readonly RoutablePage[], destination: string): RoutablePage | null {
  const wanted = routeKey(destination)
  if (wanted.length === 0) return null
  return (
    pages.find((page) => page.slug !== undefined && routeKey(page.slug) === wanted) ??
    pages.find((page) => routeKey(page.id) === wanted) ??
    null
  )
}

/**
 * Every derived link on one page.
 *
 * `tree` is the page being read; `pages` is every page a destination could
 * refer to. Both are needed because a link's two ends live in different places:
 * the source element is in this tree, the target is another page entirely.
 */
export function deriveCodeLinks(
  pageId: string,
  tree: NodeTree,
  pages: readonly RoutablePage[],
): PrototypeLink[] {
  const links: PrototypeLink[] = []

  for (const node of Object.values(tree.nodes) as BaseNode[]) {
    const targets = (node as { codeNavigationTargets?: Record<string, string> }).codeNavigationTargets
    if (!targets) continue

    for (const [propName, destination] of Object.entries(targets)) {
      const target = pageForDestination(pages, destination)
      // A route Studio has not imported is not a broken link — it is a screen
      // outside the project's board. Drawing a connector to nothing would be a
      // claim about the user's app that cannot be checked.
      if (!target || target.id === pageId) continue

      const hint = captureNodeHint(tree, node.id)
      if (!hint) continue

      links.push({
        id: codeLinkId(pageId, node.id, propName),
        origin: 'code',
        source: { pageId, node: hint },
        trigger: 'click',
        action: 'navigate',
        targetPageId: target.id,
        // Derived links get the neutral transition on purpose. The code says
        // WHERE it goes and says nothing about how it should look getting
        // there, and picking a slide would be Studio inventing a design
        // decision and attributing it to the user's source.
        transition: 'instant',
      })
    }
  }

  return links
}

/**
 * Derived links across every page, ready to merge with the authored ones.
 *
 * An authored link on the same element WINS: the designer overrode what the
 * code does, and showing both would draw two connectors from one button.
 */
export function mergeCodeLinks(
  authored: readonly PrototypeLink[],
  derived: readonly PrototypeLink[],
): PrototypeLink[] {
  const authoredSources = new Set(
    authored.map((link) => `${link.source.pageId}::${link.source.node.nodeId}`),
  )
  return [
    ...authored,
    ...derived.filter((link) => !authoredSources.has(`${link.source.pageId}::${link.source.node.nodeId}`)),
  ]
}
