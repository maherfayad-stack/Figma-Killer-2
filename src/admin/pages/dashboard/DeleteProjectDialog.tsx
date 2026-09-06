/**
 * DeleteProjectDialog — the confirmation `DashboardPage`'s delete control asks
 * for before a project leaves the launcher.
 *
 * A confirmation step exists here and not on "New project" because the two
 * mistakes are not symmetrical: an unwanted project is deleted in one click,
 * while a wrongly deleted project is a repository the user may have spent days
 * in. `tone="danger"` makes the Dialog primitive render as an `alertdialog`,
 * so the prompt interrupts a screen reader rather than waiting to be found.
 *
 * The body states where the files GO, not merely that the action can be
 * undone. "Moved to the workspace trash" plus the path is something the user
 * can act on without Studio's help — the recovery is a `mv` they can perform
 * themselves — and that is a stronger promise than an undo button this
 * dashboard does not have.
 *
 * There is no type-the-name-to-confirm step. That ceremony earns its cost when
 * an action is irreversible; here it would tax every honest deletion to guard
 * against a mistake the trash already catches.
 */
import { Dialog } from '@ui/components/Dialog'
import { Button } from '@ui/components/Button'
import styles from './DeleteProjectDialog.module.css'

interface DeleteProjectDialogProps {
  /** The project awaiting confirmation, or `null` when the dialog is closed. */
  project: { name: string; pageCount: number } | null
  /** True while the delete request is in flight — disables both footer buttons. */
  busy: boolean
  onClose: () => void
  onConfirm: () => void
}

export function DeleteProjectDialog({ project, busy, onClose, onConfirm }: DeleteProjectDialogProps) {
  return (
    <Dialog
      open={project !== null}
      onClose={onClose}
      tone="danger"
      eyebrow="Delete"
      title={project ? `Delete “${project.name}”?` : 'Delete project?'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={busy}>
            {busy ? 'Deleting…' : 'Delete project'}
          </Button>
        </>
      }
    >
      <p className={styles.body}>
        {project?.pageCount === 1
          ? 'This project and its 1 page leave the launcher.'
          : `This project and its ${project?.pageCount ?? 0} pages leave the launcher.`}
      </p>
      <p className={styles.body}>
        Nothing is erased. The folder is moved to <code className={styles.path}>studio-workspace/.trash/</code>,
        where you can move it back at any time.
      </p>
    </Dialog>
  )
}
