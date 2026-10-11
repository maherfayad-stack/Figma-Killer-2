/**
 * gesturePage — the page a pointer-addressed (or selection-addressed) insert
 * names, and the activation that gesture implies.
 *
 * A dropped file lands wherever the pointer happens to be, which can be any
 * frame on the board, and the frame under a drop has never been activated by
 * a pointerdown because there was no pointerdown. So the insert actions that
 * serve those gestures (`imageDropActions.ts`, `subtreeInsertActions.ts`) each
 * name their page — and then ACTIVATE it, the audit's decision (07 §A.7): the
 * gesture is on that frame, the optimistic ghost and any value writes address
 * the active tree, and the result is selected the way Figma selects it.
 */
import type { NodeTree, PageNode } from '@core/page-tree'
import type { SiteSliceHelpers } from './types'

export function findGesturePage(get: SiteSliceHelpers['get'], pageId: string): NodeTree<PageNode> | null {
  // A plain scan, not `store.ts`'s memoised `lookupCanvasPageById`: the
  // modules calling this are imported BY the composed store, so importing
  // that memo back would close a cycle. One O(pages) walk per gesture.
  return get().site?.pages.find((page) => page.id === pageId) ?? null
}

export function activateGesturePage(get: SiteSliceHelpers['get'], pageId: string): void {
  if (get().activePageId !== pageId || get().activeDocument !== null) get().openPageInCanvas(pageId)
}
