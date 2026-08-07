import type { PageNode } from '@core/page-tree'
import type { ActiveDocument } from '@site/store/slices/uiSlice'
import { isStudioMode } from '@site/studio/studioMode'

/**
 * "Componentize" mints a Visual Component as a `data_rows` CMS record and
 * writes the reference via `mutateSiteState` — a persistence path Studio's
 * filesystem adapter (`fsCodemodAdapter`) does not implement at all. In
 * Studio mode this silently destroys the selected subtree: the componentized
 * node is replaced with a `base.visual-component-ref` in memory, then the
 * whole edit is dropped on the next save/reload because there is nowhere on
 * disk for it to land. Refusing here (both the properties-panel button and
 * the layer-tree context menu read this same predicate) is a stopgap until
 * promote-to-component ships on the Studio substrate — do not remove this
 * guard to "make Componentize work in Studio" without that replacement.
 */
export function canComponentizeNode(
  activeDocument: ActiveDocument | null,
  node: PageNode | null | undefined,
): node is PageNode {
  return (
    !isStudioMode() &&
    activeDocument?.kind !== 'visualComponent' &&
    !!node &&
    node.moduleId !== 'base.body' &&
    node.moduleId !== 'base.visual-component-ref'
  )
}
