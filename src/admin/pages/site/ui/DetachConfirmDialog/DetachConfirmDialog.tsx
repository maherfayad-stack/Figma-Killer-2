/**
 * DetachConfirmDialog — P5-C (DET-5): the one question a detach ever asks,
 * and only when it LOSES something (`instanceActions.ts` decides). A plain
 * detach is instant, as in Figma; this lists what this one gives up — other
 * rendered states, every row of a list, a context hook moved into the page's
 * component — before a byte is written. "Detach" writes it; Cancel, Esc or
 * the backdrop leaves the file as it is.
 */
import { useRef } from 'react'
import { Button } from '@ui/components/Button'
import { Dialog } from '@ui/components/Dialog'
import { useEditorStore } from '@site/store/store'
import styles from './DetachConfirmDialog.module.css'

export function DetachConfirmDialog() {
  const confirm = useEditorStore((state) => state.instanceDetachConfirm)
  const resolve = useEditorStore((state) => state.resolveInstanceDetachConfirm)
  const confirmRef = useRef<HTMLButtonElement>(null)

  if (!confirm) return null

  return (
    <Dialog
      open
      onClose={() => resolve(false)}
      title={confirm.title}
      size="sm"
      initialFocusRef={confirmRef}
      footer={
        <>
          <Button variant="secondary" size="sm" type="button" onClick={() => resolve(false)} data-testid="detach-confirm-cancel">
            Cancel
          </Button>
          <Button ref={confirmRef} variant="primary" size="sm" type="button" onClick={() => resolve(true)} data-testid="detach-confirm-accept">
            Detach
          </Button>
        </>
      }
    >
      <ul className={styles.losses} data-testid="detach-confirm-losses">
        {confirm.losses.map((loss) => (
          <li key={loss} className={styles.loss}>
            {loss}
          </li>
        ))}
      </ul>
      <p className={styles.undo}>Undo puts the component back.</p>
    </Dialog>
  )
}
