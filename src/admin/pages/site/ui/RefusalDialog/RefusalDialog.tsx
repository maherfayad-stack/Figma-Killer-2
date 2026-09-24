/**
 * RefusalDialog — R2 (`STUDIO-LIVE-CANVAS-PLAN.md` §3, `store-10`). Replaces
 * the plain refusal toast for a committed structural gesture whenever the
 * refusal has at least one runnable remedy, per `presentStructuralRefusal`'s
 * toast-vs-dialog split. Renders the engine's own explanation plus the shared
 * `ConstraintActionButtons`.
 *
 * P3-D — it no longer re-issues the refused gesture after a Detach/Extract.
 * That retry found "whatever node now sits at the call site", and a detach
 * that adds an import above the call site moves it down a line, so the retry
 * could land on the wrong element. A gesture inside a shared component is now
 * made on this instance by `instanceOnlyGesture.ts`, which follows every id
 * through what the write REPORTED (the detach's created id, the copy's own
 * file), and never reaches this dialog. A Detach/Extract pressed here does
 * exactly what its label says and closes the dialog when it lands; a refusal
 * leaves it open for the other remedy.
 */
import { Dialog } from '@ui/components/Dialog'
import type { EditConstraintAction } from '@core/page-tree'
import { useEditorStore } from '@site/store/store'
import { ConstraintActionButtons } from '@site/ui/ConstraintNotice'
import styles from './RefusalDialog.module.css'


export function RefusalDialog() {
  const dialogState = useEditorStore((state) => state.structuralRefusalDialog)
  const dismiss = useEditorStore((state) => state.dismissStructuralRefusalDialog)

  if (!dialogState) return null

  const { title, constraint, nodeId, duplicateIntoFrame } = dialogState

  function handleActionSettled(action: EditConstraintAction, ok: boolean) {
    // A Detach/Extract the codemod refused already toasted its reason
    // (`runInstanceCodemod`) — stay open so the user can try the other one.
    if (!ok && (action.kind === 'detach' || action.kind === 'extract')) return
    dismiss()
  }

  return (
    <Dialog
      open
      onClose={dismiss}
      title={title}
      tone="danger"
      footer={
        <ConstraintActionButtons
          constraint={constraint}
          nodeId={nodeId}
          onActionSettled={handleActionSettled}
          duplicateIntoFrame={duplicateIntoFrame}
        />
      }
    >
      <p className={styles.explanation}>{constraint.explanation}</p>
    </Dialog>
  )
}
