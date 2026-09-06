/**
 * DomTreeContext — provides the single ExpansionStore instance to the DOM tree.
 *
 * The context value is the stable store object itself (created once in
 * DomTreeProvider via useState lazy init). It never changes reference →
 * zero context-driven re-renders.
 *
 * Expansion state is subscribed ONCE per tree, by `LayerRowList`, via
 * `useSyncExternalStore(store.subscribe, store.getExpandedIds)`. It used to be
 * one subscription per row (`useIsNodeExpanded`); with the tree flattened up
 * front the list already knows every row's expanded flag, so the per-row
 * subscriptions were pure cost. This is UI-only state — it is NOT part of the
 * Zustand site store. (Constraint #182: no document-model state outside the
 * store.)
 */
import { createContext, use } from 'react'
import type { ExpansionStore } from './expansionStore'

export const ExpansionStoreContext = createContext<ExpansionStore | null>(null)

/**
 * DomTreePageContext — the page id whose tree a nested `TreeNode`/
 * `ChildrenGroup` resolves against. `null` (the default — used by every
 * DomPanel mount) means "resolve the active canvas document", reproducing
 * the single-page behavior every panel had before the Studio Pages/Layers
 * tree existed. Mirrors `CanvasPageContext` (canvas/CanvasContexts.ts) and
 * is read the same way through `selectCanvasPageFor(s, pageId)`.
 *
 * The Studio Pages/Layers tree (`StudioPagesTree`/`PageLayerSubtree`) renders
 * a subtree per page and provides each page's own id here so a page's rows
 * display correctly even BEFORE that page becomes the active one. Node
 * interactions (select/rename/delete/etc.) still act on `activePageId` —
 * callers must switch the active page on first interaction (pointerdown
 * capture), same as `BoardFramesLayer`'s frame activation.
 */
export const DomTreePageContext = createContext<string | null>(null)

export function useDomTreePageId(): string | null {
  return use(DomTreePageContext)
}

export function useExpansionStore(): ExpansionStore {
  const store = use(ExpansionStoreContext)
  if (!store) throw new Error('useExpansionStore must be used inside DomTreeProvider')
  return store
}
