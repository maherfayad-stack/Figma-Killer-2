/**
 * TrashDialog — every project that has been deleted, with the two verbs that
 * finish the job.
 *
 * `POST /admin/api/studio/delete` has always moved a project into
 * `studio-workspace/.trash/` rather than erasing it, and for as long as this
 * dialog did not exist the recovery instruction was "go and `mv` it back".
 * That is not a recovery story a design tool can offer: the user who most
 * needs it is the one who just deleted the wrong repository, and telling them
 * to open a terminal at that moment is the worst possible time.
 *
 * Restore is the safe verb and reads as one. Delete forever is the only
 * control in the launcher that erases anything, so it is `destructive`, it
 * says "forever", and it asks for a second click on the same row rather than
 * opening a nested confirmation dialog — a confirm-inside-a-dialog is the
 * pattern that trains people to click through both.
 */
import { useState } from 'react'
import { TrashSolidIcon } from 'pixel-art-icons/icons/trash-solid'
import { UndoIcon } from 'pixel-art-icons/icons/undo'
import { Button } from '@ui/components/Button'
import { Dialog } from '@ui/components/Dialog'
import { EmptyState } from '@ui/components/EmptyState'
import { formatEditedAgo } from './editedAgo'
import type { TrashedProject } from './hooks/useProjectTrash'
import styles from './TrashDialog.module.css'

interface TrashDialogProps {
  open: boolean
  /** The trashed projects, or `null` while the listing is in flight. */
  trashed: TrashedProject[] | null
  /** Message from a failed listing, else null. */
  error: string | null
  /** True while a restore or a purge is in flight — disables every row. */
  busy: boolean
  onClose: () => void
  onRestore: (project: TrashedProject) => void
  onPurge: (project: TrashedProject) => void
}

/** "2 days ago" from the launcher card's own formatter, re-voiced for a deletion. */
function deletedAgo(trashedAt: number): string {
  return formatEditedAgo(trashedAt).replace(/^Edited /, 'Deleted ')
}

/** Short size string. `sizeCapped` means the walk stopped early, so the number is a floor and must not be stated as a total. */
function sizeLabel(project: TrashedProject): string {
  const bytes = project.sizeBytes
  const value =
    bytes >= 1024 * 1024 * 1024
      ? `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
      : bytes >= 1024 * 1024
        ? `${Math.round(bytes / (1024 * 1024))} MB`
        : `${Math.max(1, Math.round(bytes / 1024))} KB`
  return project.sizeCapped ? `at least ${value}` : value
}

export function TrashDialog({ open, trashed, error, busy, onClose, onRestore, onPurge }: TrashDialogProps) {
  // Which row has armed its permanent delete. One at a time: arming a second
  // row disarms the first, so a stray click can never land on a primed control
  // the user has stopped looking at.
  const [armed, setArmed] = useState<string | null>(null)

  const listed = trashed ?? []

  return (
    <Dialog
      open={open}
      onClose={() => {
        setArmed(null)
        onClose()
      }}
      eyebrow="Trash"
      title="Deleted projects"
      size="lg"
      loading={trashed === null && error === null}
      footer={
        <Button variant="secondary" size="sm" onClick={onClose}>
          Done
        </Button>
      }
    >
      {error !== null ? (
        <EmptyState variant="centered" role="alert" title="Could not load the trash." description={error} />
      ) : listed.length === 0 ? (
        <EmptyState
          variant="centered"
          icon={<TrashSolidIcon size={20} aria-hidden="true" />}
          title="Nothing has been deleted."
          description="Deleted projects are moved here instead of being erased, and can be restored from this panel."
        />
      ) : (
        <ul className={styles.rows}>
          {listed.map((project) => (
            <li key={project.entry} className={styles.row}>
              <div className={styles.identity}>
                <span className={styles.name}>{project.name}</span>
                <span className={styles.meta}>
                  {deletedAgo(project.trashedAt)} · {sizeLabel(project)}
                </span>
              </div>
              <div className={styles.actions}>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    setArmed(null)
                    onRestore(project)
                  }}
                >
                  <UndoIcon size={12} aria-hidden="true" /> Restore
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    if (armed === project.entry) {
                      setArmed(null)
                      onPurge(project)
                      return
                    }
                    setArmed(project.entry)
                  }}
                >
                  {armed === project.entry ? 'Click again to erase' : 'Delete forever'}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  )
}
