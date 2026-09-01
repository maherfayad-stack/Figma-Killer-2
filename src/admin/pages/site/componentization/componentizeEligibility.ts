import type { PageNode } from '@core/page-tree'
import type { ActiveDocument } from '@site/store/slices/uiSlice'

/**
 * "Componentize" mints a Visual Component as a `data_rows` CMS record and
 * writes the reference via `mutateSiteState` — a persistence path Studio's
 * filesystem adapter (`fsCodemodAdapter`) does not implement at all. Studio
 * is the only mode now, so this always refuses: allowing it would silently
 * destroy the selected subtree (the componentized node is replaced with a
 * `base.visual-component-ref` in memory, then the whole edit is dropped on
 * the next save/reload because there is nowhere on disk for it to land).
 * Both the properties-panel button and the layer-tree context menu read this
 * same predicate. Do not flip this to allow Componentize without shipping
 * promote-to-component on the Studio substrate first.
 */
export function canComponentizeNode(
  _activeDocument: ActiveDocument | null,
  _node: PageNode | null | undefined,
): false {
  return false
}
