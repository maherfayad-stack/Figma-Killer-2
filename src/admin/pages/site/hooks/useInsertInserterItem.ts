import { useEditorStore, selectActiveCanvasPage } from '@site/store/store'
import { resolveInsertLocation, type InsertLocation } from '@site/store/insertLocation'
import type { AssetItem } from '@site/panels/AssetsPanel/assetsModel'
import { useInsertModule } from './useInsertModule'

/**
 * Shared handler for the module inserter dialog's `onInsertItem` callback.
 *
 * Inserts the picked module / saved layout / Visual Component into the active
 * canvas document. Every inserter entry point uses it — the Assets panel's
 * cards and the canvas selection toolbar's "Insert module" action — so the
 * flows stay identical.
 *
 * Silent on success (P3-A): the new element appearing on the canvas, selected,
 * IS the feedback. A "Placed Button" card on top of the placed button said the
 * same thing twice, once per gesture.
 *
 * Target resolution: when the dialog passes an explicit drop `target` it is
 * used verbatim; otherwise the shared insert hooks resolve the location from
 * the current selection via `resolveInsertLocation` (container targets nest the
 * new node as a last child, leaf targets get a sibling-after insertion).
 */
export function useInsertInserterItem() {
  const insertModule = useInsertModule()

  // The page and the selection are read when an item is inserted, not
  // subscribed — see `useInsertModule` for why (P6-C).
  const insertVC = (vcId: string, explicitTarget?: InsertLocation): boolean => {
    const state = useEditorStore.getState()
    const canvasPage = selectActiveCanvasPage(state)
    const { selectedNodeId, insertComponentRef } = state
    if (!canvasPage) return false
    // Same target → location resolution as every other insert flow: explicit
    // selection acts as the target, no selection drops at root, leaf targets
    // become a sibling-after under their parent (see resolveInsertLocation).
    const location =
      explicitTarget ??
      resolveInsertLocation(canvasPage, selectedNodeId ?? canvasPage.rootNodeId)
    if (!location) return false
    insertComponentRef(location.parentId, vcId, location.index)
    return true
  }

  return (
    item: AssetItem,
    target: InsertLocation | undefined,
  ): boolean => {
    const inserted =
      item.kind === 'module'
        ? Boolean(insertModule(item.module, target))
        : item.kind === 'savedLayout'
          ? Boolean(useEditorStore.getState().insertLayout(item.id, target))
          : item.kind === 'component'
            ? insertVC(item.id, target)
            : false

    return inserted
  }
}
