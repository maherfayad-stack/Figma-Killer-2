/**
 * LayoutEditChip — the toolbar's reminder that the board is in "Edit layout"
 * mode (G-8): structural gestures on one Next `layout`/`template` file are
 * allowed, and every route that draws it changes.
 *
 * The mode outlives the selection (it is `mainEditTarget`, the same one "Edit
 * main component" uses), so the properties-panel notice alone would let it
 * stay on, unseen, once nothing is selected. Renders nothing otherwise.
 */
import { layoutRouteCount } from '@core/page-tree'
import { Button } from '@ui/components/Button'
import { useEditorStore } from '@site/store/store'
import { editedLayoutOf } from '@site/store/slices/site/mainEditMode'

export function LayoutEditChip() {
  const rel = useEditorStore((state) => editedLayoutOf(state.mainEditTarget))
  const routes = useEditorStore((state) => (rel !== null && state.site ? layoutRouteCount(state.site.pages, rel) : 0))
  const setMainEditTarget = useEditorStore((state) => state.setMainEditTarget)
  if (rel === null) return null
  return (
    <Button
      variant="secondary"
      size="micro"
      onClick={() => setMainEditTarget(null)}
      tooltip={`Done editing ${rel}`}
      data-testid="layout-edit-chip"
    >
      {routes > 1 ? `Editing layout ${rel} · ${routes} routes · Done` : `Editing layout ${rel} · Done`}
    </Button>
  )
}
