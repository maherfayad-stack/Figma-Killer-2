/**
 * playNavigation — the bridge between a gesture in the armed live frame and the
 * player's stack machine.
 *
 * The machine itself is `@core/studio-prototype`'s `playback.ts`: which link a
 * gesture follows, what a screen's `after-delay` timers owe, what letting go of
 * a press undoes and what the stacks look like afterwards are pure, unit-tested
 * rules that never touch a store. This file only supplies the two things those
 * rules need from the editor — the touched element's ancestor chain, and where
 * each link's source hint resolves to right now.
 */
import { getChildren } from '@core/page-tree'
import type { Page } from '@core/page-tree'
import {
  linkForKey,
  linkForTrigger,
  releaseActionFor,
  type PrototypeLink,
  type PrototypeTriggerKind,
} from '@core/studio-prototype'
import { pushToast } from '@ui/components/Toast'
import { useEditorStore } from '@site/store/store'
import { resolvedLinkSourceIds } from '@site/store/slices/prototypeSelectors'

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
 * Apply a link, saying so when it could not move.
 *
 * A `back` with nowhere to go, or a `close` with nothing presented, is a real
 * prototype bug and the player is where it should surface — so it toasts rather
 * than doing nothing and leaving the user to wonder whether the gesture landed.
 *
 * `silent` is for a press's RELEASE. Letting go of a "hold to peek" that has
 * already been dismissed some other way is not a bug anybody authored, and
 * toasting it would blame the user for lifting their finger.
 */
function applyLink(link: PrototypeLink, silent: boolean): boolean {
  if (useEditorStore.getState().followPrototypeLink(link)) return true
  if (silent) return true
  pushToast({
    kind: 'info',
    title: link.action === 'back' ? 'Nowhere to go back to' : 'Nothing to close',
    body:
      link.action === 'back'
        ? 'This is the screen the prototype started on.'
        : 'No overlay is showing on this screen.',
  })
  return true
}

/**
 * Follow whatever link the gesture landed on. Returns the link that was
 * followed, so a caller holding a press can ask it later what letting go
 * undoes — and `null` when the gesture meant nothing here.
 *
 * `candidatePageIds` runs TOPMOST FIRST — the presented overlay, then the
 * screen underneath. Both surfaces are mounted at once and a node id alone does
 * not say which one it came from, so the top of the stack gets first refusal,
 * which is also what the user sees themselves touching.
 */
export function followPrototypeLinkAt(
  nodeId: string,
  candidatePageIds: readonly (string | null)[],
  triggerKind: PrototypeTriggerKind,
): PrototypeLink | null {
  const state = useEditorStore.getState()
  // No site loaded means no page a gesture could have come from, so there is
  // nothing to follow — and a fresh `[]` fallback beside a store read is what
  // `canvas-aware-selectors` bans, for the selector next to this one that would
  // re-render forever on it.
  const pages = state.site?.pages
  if (!pages) return null
  const resolved = resolvedLinkSourceIds(state.prototype.links, pages)

  let link: PrototypeLink | null = null
  for (const pageId of candidatePageIds) {
    if (!pageId) continue
    const page = pages.find((candidate) => candidate.id === pageId)
    if (!page?.nodes[nodeId]) continue
    link = linkForTrigger(state.prototype.links, resolved, ancestorChain(page, nodeId), pageId, triggerKind)
    if (link) break
  }
  if (!link) return null

  applyLink(link, false)
  return link
}

/** Undo a press that asked to be undone on release. No-op for anything else. */
export function releasePrototypePress(link: PrototypeLink): void {
  const reverse = releaseActionFor(link)
  if (!reverse) return
  applyLink(reverse, true)
}

/**
 * Follow the `key`-triggered link for `key` on whichever surface is showing.
 *
 * Unlike the pointer triggers this takes the page ids rather than a node,
 * because a keystroke has no element under it — see `linkForKey`. Topmost
 * first, same rule and same reason: the overlay is what the user is looking at.
 */
export function followPrototypeKey(key: string, candidatePageIds: readonly (string | null)[]): boolean {
  const state = useEditorStore.getState()
  const pages = state.site?.pages
  if (!pages) return false
  const resolved = resolvedLinkSourceIds(state.prototype.links, pages)

  for (const pageId of candidatePageIds) {
    if (!pageId) continue
    const link = linkForKey(state.prototype.links, resolved, pageId, key)
    if (link) return applyLink(link, false)
  }
  return false
}
