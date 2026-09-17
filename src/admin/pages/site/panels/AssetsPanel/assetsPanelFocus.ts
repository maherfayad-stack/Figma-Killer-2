/**
 * assetsPanelFocus — "open the Assets panel and put the cursor in its search
 * box", for callers that are not the panel.
 *
 * Opening a panel is store state (`setLeftSidebarPanel`). Wanting its search
 * focused is NOT: it is a one-shot intent with no meaningful "current value",
 * and modelling it as a store field would mean inventing a flag somebody has
 * to remember to clear. A tiny notification bus says it once and is done.
 */
import { useEditorStore } from '@site/store/store'

const listeners = new Set<() => void>()

/** The panel subscribes while mounted; returns its unsubscribe. */
export function subscribeAssetsSearchFocus(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Reveals the Assets panel and focuses its search box.
 *
 * The notify is deferred by one animation frame because the panel is mounted
 * but `hidden` while another panel is active: the store write above is what
 * un-hides it, and focus() on an element inside a `hidden` subtree does
 * nothing. One frame later the commit has landed and the input is focusable.
 */
export function openAssetsSearch(): void {
  useEditorStore.getState().setLeftSidebarPanel('assets')
  requestAnimationFrame(() => {
    for (const listener of listeners) listener()
  })
}
