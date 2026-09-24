/**
 * RefusalDialog — R2 (`STUDIO-LIVE-CANVAS-PLAN.md` §3, `store-10`). Replaces
 * the plain refusal toast for a committed structural gesture (move / delete /
 * insert / duplicate / wrap) whenever the refusal has at least one runnable
 * remedy, per `presentStructuralRefusal`'s toast-vs-dialog split.
 *
 * Renders the engine's own explanation plus the shared `ConstraintActionButtons`
 * — the SAME dispatch table `ConstraintNotice`/`SourceConstraintNotice`/
 * `CodeValueControl` already use, so a "Detach"/"Duplicate as a new file" here
 * behaves identically to everywhere else those buttons appear.
 *
 * THE RETRY MECHANISM. `detach`/`extract` are the two remedies that change
 * what the refused node's id even IS — both trigger a full, fire-and-forget
 * board reload (`requestCmsSiteReload()`, no promise, no "applied" event; see
 * `store-10`'s recon). Once the codemod itself settles `ok`, this component
 * subscribes to the store (bare `useEditorStore.subscribe`, matching
 * `SitePage.tsx`'s own pending-action idiom) and waits for the reload to
 * actually land — checking, on every fire, whether a DIFFERENT node than the
 * one that was refused now occupies the same call site
 * (`findReplacementNodeId` + `matchesCallSitePosition`). The "different from
 * the refused id" check matters: `requestCmsSiteReload()` fires its event
 * before this component ever sees `onSettled`, but the actual
 * `store.loadSite(site)` that applies it happens later, asynchronously — so
 * the FIRST store update this subscription observes is very often unrelated
 * (a hover, a selection change), and at that moment the refused node's own id
 * still trivially "matches its own call site position". Waiting for the
 * found id to differ from the original is what tells the two apart.
 *
 * Manually closing the dialog (Escape / backdrop / the X) before a hit
 * cancels the subscription and the timeout — retry() must never fire after
 * the user has backed out.
 */
import { useEffect, useRef, useState } from 'react'
import { Dialog } from '@ui/components/Dialog'
import { callSitePosition, type EditConstraintAction } from '@core/page-tree'
import { useEditorStore } from '@site/store/store'
import { ConstraintActionButtons } from '@site/ui/ConstraintNotice'
import { findReplacementNodeId } from './findReplacementNode'
import styles from './RefusalDialog.module.css'

/** How long to wait for a detach/extract's reload before quietly giving up. */
const RETRY_WAIT_TIMEOUT_MS = 8000

export function RefusalDialog() {
  const dialogState = useEditorStore((state) => state.structuralRefusalDialog)
  const dismiss = useEditorStore((state) => state.dismissStructuralRefusalDialog)
  const [retrying, setRetrying] = useState(false)
  const cancelWaitRef = useRef<(() => void) | null>(null)

  // A new refusal (or the dialog closing) cancels whatever retry-wait was
  // still pending for the PREVIOUS one — never let a stale subscription fire
  // retry() against a gesture the user has moved on from.
  useEffect(() => {
    return () => {
      cancelWaitRef.current?.()
      cancelWaitRef.current = null
    }
  }, [dialogState])

  if (!dialogState) return null

  const { title, constraint, nodeId, retry, duplicateIntoFrame } = dialogState

  function waitForReloadThenRetry(originalNodeId: string, retryFn: (mapId: (nodeId: string) => string) => void) {
    const position = callSitePosition(originalNodeId)
    let settled = false
    setRetrying(true)

    const finish = () => {
      settled = true
      clearTimeout(timeoutId)
      unsubscribe()
      setRetrying(false)
    }

    const timeoutId = setTimeout(() => {
      if (settled) return
      // Give up quietly: the detach/extract itself already succeeded, only
      // the automatic re-issue is skipped. No toast — nothing failed.
      finish()
      dismiss()
    }, RETRY_WAIT_TIMEOUT_MS)

    const unsubscribe = useEditorStore.subscribe(() => {
      if (settled) return
      const site = useEditorStore.getState().site
      if (!site) return
      const found = findReplacementNodeId(site, position)
      // A match on the ORIGINAL id means the reload hasn't landed yet (the
      // refused node still occupies its own call site) — keep waiting.
      if (!found || found === originalNodeId) return
      finish()
      retryFn((nodeId) => (nodeId === originalNodeId ? found : nodeId))
      dismiss()
    })

    cancelWaitRef.current = () => {
      if (settled) return
      settled = true
      clearTimeout(timeoutId)
      unsubscribe()
      setRetrying(false)
    }
  }

  function handleActionSettled(action: EditConstraintAction, ok: boolean) {
    // Every other runnable action (edit-component, jump-to-source, edit-array)
    // just opens a file synchronously — nothing to wait for, close the dialog.
    if (action.kind !== 'detach' && action.kind !== 'extract') {
      dismiss()
      return
    }
    // A refusal from the codemod itself already toasted its own reason
    // (`runInstanceCodemod`) — leave the dialog open so the user can try a
    // different remedy (e.g. Detach failed, try Extract next).
    if (!ok) return
    if (!nodeId || !retry) {
      dismiss()
      return
    }
    waitForReloadThenRetry(nodeId, retry)
  }

  function handleClose() {
    cancelWaitRef.current?.()
    cancelWaitRef.current = null
    setRetrying(false)
    dismiss()
  }

  return (
    <Dialog
      open
      onClose={handleClose}
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
      {retrying && (
        <p className={styles.retrying} role="status">
          Applying the change and retrying…
        </p>
      )}
    </Dialog>
  )
}
