/**
 * SaveStatusChip — the toolbar's answer to "is my work on disk?".
 *
 * Why it exists
 * ─────────────
 * `usePersistence`'s save path is deliberately silent on failure: it restores
 * the dirty snapshot it took before the request (so nothing is lost, and the
 * next save ships the same marks again) and sets `saveStatus.state = 'error'`.
 * Nothing rendered that state, so a failed save looked exactly like a
 * successful one — the user kept editing a canvas whose source had stopped
 * following it. Z6's fix is not a toast (a save can fail a dozen times in a
 * row while a dev server restarts; a dozen red cards is the disease, not the
 * cure) — it is a single chip that always tells the truth.
 *
 * States
 * ──────
 *   loading                  → nothing (the board isn't editable yet)
 *   saved                    → "Saved", muted, static
 *   saving                   → "Saving…", muted, static
 *   unsaved                  → "Unsaved", clickable: save now rather than
 *                              waiting out the autosave debounce
 *   error + `retrying`       → "Saving…" — the automatic ladder is mid-flight
 *   error, ladder exhausted  → "Unsaved — retry", danger tone, clickable
 *
 * The ladder itself (3 tries, 2s/4s/8s) lives in `usePersistence` —
 * `SAVE_RETRY_BACKOFF_MS` — because retrying a save is the persistence
 * layer's job, not the chrome's. This component only renders what it is told
 * and offers the manual retry. A manual click does not restart the ladder: an
 * exhausted ladder means the failure is not transient, and silently looping
 * again would hide that.
 *
 * A structural commit (`insert` / `duplicate` / `wrap` writing your source)
 * bypasses the autosave path entirely, so the chip subscribes to
 * `isStructuralCommitInFlight()` as well — otherwise it would read "Saved"
 * during the one write most likely to be slow.
 */
import { useSyncExternalStore } from 'react'
import { Button } from '@ui/components/Button'
import { cn } from '@ui/cn'
import type { PersistenceSaveStatus } from '@site/hooks/usePersistence'
import {
  isStructuralCommitInFlight,
  subscribeStructuralCommitInFlight,
} from '@site/studio/structuralCommitQueue'
import styles from './SaveStatusChip.module.css'

interface SaveStatusChipProps {
  status: PersistenceSaveStatus
  /** The persistence controller's `saveSite`. Rejects when the save failed. */
  onRetry: () => Promise<void>
}

function readStructuralInFlight(): boolean {
  return isStructuralCommitInFlight()
}

/** Server snapshot: nothing is ever in flight during SSR / a prerender. */
function structuralInFlightServerSnapshot(): boolean {
  return false
}

export function SaveStatusChip({ status, onRetry }: SaveStatusChipProps) {
  const structuralInFlight = useSyncExternalStore(
    subscribeStructuralCommitInFlight,
    readStructuralInFlight,
    structuralInFlightServerSnapshot,
  )

  if (status.state === 'loading') return null

  const failed = status.state === 'error'
  const busy = status.state === 'saving' || structuralInFlight || (failed && status.retrying === true)
  const stuck = failed && !busy
  const dirty = status.state === 'unsaved'

  if (busy) {
    return (
      <span className={cn(styles.chip, styles.text, styles.busy)} role="status" data-save-status="saving">
        Saving…
      </span>
    )
  }

  if (stuck || dirty) {
    return (
      <Button
        variant="ghost"
        size="micro"
        tone={stuck ? 'danger' : 'default'}
        className={styles.chip}
        data-save-status={stuck ? 'error' : 'unsaved'}
        tooltip={stuck ? (status.message ?? 'The last save did not reach your project.') : 'Save now'}
        onClick={() => {
          void onRetry().catch((err) => {
            // The chip IS the report — this log is for devtools only. A toast
            // here would reintroduce exactly what Z6 removes.
            console.error('[SaveStatusChip] manual save retry failed:', err)
          })
        }}
      >
        <span>{stuck ? 'Unsaved — retry' : 'Unsaved'}</span>
      </Button>
    )
  }

  return (
    <span className={cn(styles.chip, styles.text, styles.saved)} role="status" data-save-status="saved">
      Saved
    </span>
  )
}
