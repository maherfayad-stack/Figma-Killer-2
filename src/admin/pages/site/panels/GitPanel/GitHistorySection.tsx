/**
 * GitHistorySection — recent commits, and the one destructive action in v1:
 * restoring a single file from one of them.
 *
 * Restore is deliberately per-FILE, not per-commit. "Roll the project back to
 * this commit" is the operation a designer reaches for and the one that
 * silently destroys the last hour of work in three other files; restoring one
 * file is recoverable (the current content is still in the working tree's
 * history if it was ever committed, and the user chose exactly one file). It
 * sits behind a danger-styled confirmation that names the file and the commit,
 * and the board reloads afterwards, because the canvas is showing a parse of a
 * file that just changed underneath it.
 *
 * `restoreGitFile` takes a raw sha the server re-validates as hex — the shas
 * here came out of `git log`, and nothing in this UI can produce a revision
 * expression.
 */
import { useEffect, useState } from 'react'
import { Button } from '@ui/components/Button'
import { Dialog } from '@ui/components/Dialog'
import { EmptyState } from '@ui/components/EmptyState'
import { pushToast } from '@ui/components/Toast'
import { isAbortError } from '@core/http'
import { getErrorMessage } from '@core/utils/errorMessage'
import { requestCmsSiteReload } from '@admin/state/adminEvents'
import { getGitLog, restoreGitFile, type GitLogEntry } from '@site/studio/gitRequests'
import styles from './GitPanel.module.css'

/** One screenful of history. The server caps this independently. */
const LOG_LIMIT = 30

interface GitHistorySectionProps {
  dir: string | undefined
  /** Bumped by the panel after any operation that creates a commit, so history reloads without its own polling. */
  reloadNonce: number
  /**
   * The file currently open in the diff view, or `null`.
   *
   * Restore acts on THIS file, and is not offered without one. "Restore" with
   * no selected file would have to guess which file the user meant — and a
   * destructive action that guesses is the wrong shape, however convenient.
   */
  selectedFile: string | null
}

export function GitHistorySection({ dir, reloadNonce, selectedFile }: GitHistorySectionProps) {
  const [commits, setCommits] = useState<GitLogEntry[]>([])
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<{ commit: GitLogEntry; file: string } | null>(null)
  const [restoring, setRestoring] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    getGitLog(dir, LOG_LIMIT, controller.signal)
      .then((result) => {
        setCommits(result)
        setError(null)
      })
      .catch((err: unknown) => {
        if (isAbortError(err)) return
        console.error('[GitPanel] failed to read the commit log:', err)
        setError(getErrorMessage(err, 'Could not read the commit log'))
      })
    return () => controller.abort()
  }, [dir, reloadNonce])

  async function confirmRestore() {
    if (!pending) return
    setRestoring(true)
    try {
      await restoreGitFile(dir, pending.commit.sha, pending.file)
      pushToast({
        kind: 'success',
        title: 'File restored',
        body: `${pending.file} is back to its state at ${pending.commit.shortSha}.`,
      })
      setPending(null)
      // The canvas is rendering a parse of a file that just changed on disk.
      requestCmsSiteReload()
    } catch (err) {
      console.error('[GitPanel] restore failed:', err)
      pushToast({ kind: 'error', title: 'Restore failed', body: getErrorMessage(err, 'Could not restore that file') })
    } finally {
      setRestoring(false)
    }
  }

  if (error) return <p className={styles.error} role="alert">{error}</p>
  if (commits.length === 0) {
    return <EmptyState compact plain title="No commits yet." description="Your first commit will show up here." />
  }

  return (
    <>
      {!selectedFile ? (
        <p className={styles.hint}>Open a changed file above to restore it from one of these commits.</p>
      ) : null}
      <ul className={styles.log}>
        {commits.map((commit) => (
          <li key={commit.sha} className={styles.logRow}>
            <div className={styles.logMain}>
              <span className={styles.logSubject}>{commit.subject}</span>
              <span className={styles.logMeta}>
                <code className={styles.sha}>{commit.shortSha}</code>
                {commit.author} · {formatCommitDate(commit.date)}
              </span>
            </div>
            {selectedFile ? (
              <Button
                variant="ghost"
                size="xs"
                onClick={() => setPending({ commit, file: selectedFile })}
                tooltip={`Restore ${selectedFile} from ${commit.shortSha}`}
              >
                Restore…
              </Button>
            ) : null}
          </li>
        ))}
      </ul>

      {pending ? (
        <Dialog
          open
          tone="danger"
          title="Restore this file?"
          onClose={() => setPending(null)}
          footer={
            <>
              <Button variant="secondary" size="sm" type="button" onClick={() => setPending(null)}>
                Cancel
              </Button>
              <Button variant="destructive" size="sm" type="button" disabled={restoring} onClick={confirmRestore}>
                {restoring ? 'Restoring…' : 'Restore file'}
              </Button>
            </>
          }
        >
          <p>
            <code className={styles.sha}>{pending.file}</code> will be replaced with its content from commit{' '}
            <code className={styles.sha}>{pending.commit.shortSha}</code> — “{pending.commit.subject}”.
          </p>
          <p className={styles.dialogWarning}>
            The current content of that file is not committed anywhere. This cannot be undone from Studio.
          </p>
        </Dialog>
      ) : null}
    </>
  )
}

/** The server sends ISO-8601 with an offset; the browser owns the locale. */
function formatCommitDate(iso: string): string {
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return iso
  return parsed.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}
