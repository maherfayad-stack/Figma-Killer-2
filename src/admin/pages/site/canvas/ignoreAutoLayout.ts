/**
 * ignoreAutoLayout (PA-4) — the gesture behind the inspector's "Ignore auto
 * layout" toggle: measure the live frame, then hand the store one request.
 * Kept apart from the store action because it is the only part that touches
 * the canvas DOM.
 */
import { getParent } from '@core/page-tree'
import { pushToast } from '@ui/components/Toast'
import { selectActiveCanvasPage, useEditorStore } from '@site/store/store'
import { measureIgnoreAutoLayout } from './ignoreAutoLayoutMeasure'

/** `ignore` true takes the layer out of its container's auto layout; false puts it back. */
export function setLayerIgnoresAutoLayout(nodeId: string, ignore: boolean): void {
  const store = useEditorStore.getState()
  const page = selectActiveCanvasPage(store)
  const parent = page ? getParent(page, nodeId) : undefined
  if (!parent) return

  const measured = measureIgnoreAutoLayout(nodeId, parent.id, store.activeBreakpointId)
  if (!measured.ok) {
    pushToast({ kind: 'warning', title: 'Cannot ignore auto layout here', body: measured.reason, location: 'site-editor' })
    return
  }
  store.setIgnoreAutoLayout(
    nodeId,
    ignore
      ? { ignore: true, parentContains: measured.parentContains, offsets: measured.offsets }
      : { ignore: false, releaseParent: measured.releaseParent },
  )
}
