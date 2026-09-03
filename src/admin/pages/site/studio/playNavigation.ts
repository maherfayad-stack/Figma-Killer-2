/**
 * playNavigation — the bridge between a click in the armed live frame and the
 * player's stack machine.
 *
 * The machine itself is `@core/studio-prototype`'s `playback.ts`: what a click
 * follows and what the stacks look like afterwards are pure, unit-tested rules
 * that never touch a store. This file only supplies the two things the rules
 * need from the editor — the clicked element's ancestor chain, and where each
 * link's source hint resolves to right now.
 */
import { getChildren } from '@core/page-tree'
import type { Page } from '@core/page-tree'
import { linkForClick, resolveLinkSource, type PrototypeLink } from '@core/studio-prototype'
import { pushToast } from '@ui/components/Toast'
import { useEditorStore } from '@site/store/store'

/**
 * Node ids from the clicked element OUTWARD, innermost first.
 *
 * Innermost has to win so that a linked button inside a linked card follows the
 * button — you followed the thing you actually clicked.
 *
 * Walks DOWN from the root on `children` rather than up via `getAncestors`,
 * which reads the denormalized `parentId` cache. `canvasNodeLookup`'s own
 * geometry walk makes the same choice for the same reason: `children` is the
 * structural source of truth, and the parent cache is populated separately by
 * whatever produced the tree.
 */
export function ancestorChain(page: Page, nodeId: string): string[] {
  const path: string[] = []
  let found = false

  const walk = (currentId: string): boolean => {
    path.push(currentId)
    if (currentId === nodeId) {
      found = true
      return true
    }
    for (const child of getChildren(page, currentId)) {
      if (walk(child.id)) return true
    }
    path.pop()
    return false
  }

  walk(page.rootNodeId)
  return found ? path.reverse() : [nodeId]
}

/**
 * Where every link on `page` currently points, keyed by link id.
 *
 * A link whose source is `detached` is ABSENT rather than mapped to a stale id.
 * That is what makes the player refuse it — and why a broken link is drawn
 * broken on the board: a silent refusal here would be indistinguishable from a
 * link nobody ever created.
 */
export function resolveSourceIds(links: readonly PrototypeLink[], pages: readonly Page[]): Map<string, string> {
  const resolved = new Map<string, string>()
  for (const link of links) {
    const page = pages.find((candidate) => candidate.id === link.source.pageId)
    const nodeId = resolveLinkSource(link.source.node, page ?? null).nodeId
    if (nodeId) resolved.set(link.id, nodeId)
  }
  return resolved
}

/**
 * Follow whatever link the click landed on. Returns true when the player
 * handled it.
 *
 * `candidatePageIds` runs TOPMOST FIRST — the presented overlay, then the
 * screen underneath. Both surfaces are mounted at once and a node id alone does
 * not say which one it came from, so the top of the stack gets first refusal,
 * which is also what the user sees themselves clicking.
 *
 * A `back` with nowhere to go, or a `close` with nothing presented, is a real
 * prototype bug and the player is where it should surface — so it toasts rather
 * than doing nothing and leaving the user to wonder whether the click landed.
 */
export function followPrototypeLinkAt(nodeId: string, candidatePageIds: readonly (string | null)[]): boolean {
  const state = useEditorStore.getState()
  // No site loaded means no page a click could have come from, so there is
  // nothing to follow — and a fresh `[]` fallback beside a store read is what
  // `selectorStability` bans, for the selector next to this one that would
  // re-render forever on it.
  const pages = state.site?.pages
  if (!pages) return false
  const resolved = resolveSourceIds(state.prototype.links, pages)

  let link: PrototypeLink | null = null
  for (const pageId of candidatePageIds) {
    if (!pageId) continue
    const page = pages.find((candidate) => candidate.id === pageId)
    if (!page?.nodes[nodeId]) continue
    link = linkForClick(state.prototype.links, resolved, ancestorChain(page, nodeId), pageId)
    if (link) break
  }
  if (!link) return false

  if (!state.followPrototypeLink(link)) {
    pushToast({
      kind: 'info',
      title: link.action === 'back' ? 'Nowhere to go back to' : 'Nothing to close',
      body:
        link.action === 'back'
          ? 'This is the screen the prototype started on.'
          : 'No overlay is showing on this screen.',
    })
  }
  return true
}
