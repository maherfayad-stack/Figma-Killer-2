/**
 * LayoutNotice — says what an edit to the selected element does, because the
 * element is written in a Next `layout`/`template` file that every route below
 * it renders (G-8).
 *
 * It is `SharedComponentNotice`'s counterpart and shares its mode
 * (`mainEditTarget`, `mainEditMode.ts`): by default the layout's markup is
 * protected from structural gestures — its values (text, attributes, styles)
 * are ordinary edits that reach every route — and "Edit layout (N routes)" is
 * the explicit opt-in that unlocks moving, deleting, wrapping and adding
 * elements in THIS layout file. The notice becomes a banner until "Done".
 */
import { WarningDiamondSolidIcon } from 'pixel-art-icons/icons/warning-diamond-solid'
import { layoutFileOf, layoutRouteCount } from '@core/page-tree'
import { useEditorStore } from '@site/store/store'
import { editedLayoutOf } from '@site/store/slices/site/mainEditMode'
import { Button } from '@ui/components/Button'
import { cn } from '@ui/cn'
import styles from './SharedComponentNotice.module.css'

interface LayoutNoticeProps {
  /** The selected node's id; the notice renders nothing unless it is written in a layout file. */
  nodeId: string
}

export function LayoutNotice({ nodeId }: LayoutNoticeProps) {
  const rel = layoutFileOf(nodeId)
  const routes = useEditorStore((state) => (rel !== null && state.site ? layoutRouteCount(state.site.pages, rel) : 0))
  const editing = useEditorStore((state) => rel !== null && editedLayoutOf(state.mainEditTarget) === rel)
  const setMainEditTarget = useEditorStore((state) => state.setMainEditTarget)
  if (rel === null) return null

  const places = routes > 1 ? <strong>{routes}</strong> : null
  return (
    <div className={cn(styles.notice, !editing && styles.noticeInfo)} role="note" data-testid="layout-notice">
      <WarningDiamondSolidIcon size={14} className={styles.icon} />
      <div className={styles.body}>
        {editing ? (
          <p className={styles.text}>
            Editing the layout <strong>{rel}</strong>. Every change is written to that file
            {places ? <> and applies to all {places} routes that draw it</> : null}.
          </p>
        ) : (
          <p className={styles.text}>
            Part of the layout <strong>{rel}</strong>
            {places ? <>, drawn by {places} routes</> : null}. Text, attribute and style values change every route; moving, deleting and adding elements is locked until you edit the layout.
          </p>
        )}
        <div className={styles.actions}>
          {editing ? (
            <Button variant="secondary" size="xs" onClick={() => setMainEditTarget(null)} data-testid="layout-edit-done">
              Done
            </Button>
          ) : (
            <Button
              variant="secondary"
              size="xs"
              onClick={() => setMainEditTarget({ kind: 'layout', rel })}
              tooltip={`Allow structural changes to ${rel}: every route that draws it changes.`}
              data-testid="layout-edit-start"
            >
              {routes > 1 ? `Edit layout (${routes} routes)` : 'Edit layout'}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
