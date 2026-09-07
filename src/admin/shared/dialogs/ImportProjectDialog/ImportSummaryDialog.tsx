/**
 * ImportSummaryDialog — the step between "the files landed" and "here is your
 * board".
 *
 * ## Why an import stops here
 *
 * An import used to navigate straight into the editor, which meant the first
 * thing a user learned about a repo Studio had misread was an empty canvas —
 * with nothing on screen naming the reason. The two ways that happens are both
 * knowable the moment the probe finishes: a framework nobody recognised, and a
 * pages directory that was a guess. So the import reports what it found, and
 * the user confirms before the board opens.
 *
 * ## The picker is the whole point
 *
 * `pagesDirCandidates` is populated by the probe exactly when it had to rank
 * directories instead of following a framework convention. When it is
 * non-empty this dialog renders the ranked list and writes the answer through
 * `chooseProjectPagesDir`, then re-states the page count that choice yields —
 * the number is the feedback, not a toast. When it IS empty the probe followed
 * a convention, there is no question to ask, and the dialog is a two-line
 * confirmation.
 *
 * Shared by both import paths: the dialog's own GitHub/upload/folder tabs hand
 * off to it, and so does a folder dropped on the launcher grid. One summary
 * step, whichever way the project arrived.
 */
import { useState } from 'react'
import { Button } from '@ui/components/Button'
import { Dialog } from '@ui/components/Dialog'
import { Select } from '@ui/components/Select'
import { pushToast } from '@ui/components/Toast'
import { getErrorMessage } from '@core/utils/errorMessage'
import { chooseProjectPagesDir, frameworkLabel, type ImportSummary } from '@site/studio/importSummary'
import styles from './ImportSummaryDialog.module.css'

interface ImportSummaryDialogProps {
  /** The finished import, or `null` when the dialog is closed. */
  summary: ImportSummary | null
  /** Dismiss without opening — the project stays in the launcher. */
  onClose: () => void
  /** Open the imported project's board. */
  onOpen: (summary: ImportSummary) => void
}

function pagesSentence(pageCount: number, pagesDir: string): string {
  const pages = pageCount === 1 ? '1 page' : `${pageCount} pages`
  return `${pages} in ${pagesDir}/`
}

export function ImportSummaryDialog({ summary, onClose, onOpen }: ImportSummaryDialogProps) {
  // The chosen directory and the count it yields are local to this step: the
  // server is the source of truth for both, and each pick refetches the count
  // rather than the dialog predicting it.
  const [chosenDir, setChosenDir] = useState<string | null>(null)
  const [pageCount, setPageCount] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)

  if (!summary) return null

  const pagesDir = chosenDir ?? summary.pagesDir
  const pages = pageCount ?? summary.pageCount
  const candidates = summary.pagesDirCandidates

  async function handlePickPagesDir(next: string) {
    if (!summary || next === pagesDir) return
    setSaving(true)
    try {
      const count = await chooseProjectPagesDir(summary.dir, next)
      setChosenDir(next)
      setPageCount(count)
    } catch (err) {
      console.error('[ImportSummaryDialog] could not set the pages directory:', err)
      pushToast({
        kind: 'error',
        title: 'Could not change the pages directory',
        body: getErrorMessage(err, 'Unknown project error'),
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      eyebrow="Imported"
      title={summary.name}
      size="md"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose} disabled={saving}>
            Not now
          </Button>
          <Button variant="primary" size="sm" onClick={() => onOpen(summary)} disabled={saving}>
            Open project
          </Button>
        </>
      }
    >
      <dl className={styles.facts}>
        <div className={styles.fact}>
          <dt className={styles.term}>Framework</dt>
          <dd className={styles.value}>{frameworkLabel(summary.framework)}</dd>
        </div>
        <div className={styles.fact}>
          <dt className={styles.term}>Pages</dt>
          {/* `aria-live` because this number is the picker's only feedback. */}
          <dd className={styles.value} aria-live="polite">
            {pagesSentence(pages, pagesDir)}
          </dd>
        </div>
        <div className={styles.fact}>
          <dt className={styles.term}>Files</dt>
          <dd className={styles.value}>
            {summary.skipped > 0
              ? `${summary.files} imported, ${summary.skipped} skipped`
              : `${summary.files} imported`}
          </dd>
        </div>
      </dl>

      {candidates.length > 0 && (
        <div className={styles.picker}>
          <label className={styles.pickerLabel} htmlFor="import-summary-pages-dir">
            Studio had to guess where the screens live.
          </label>
          <Select
            id="import-summary-pages-dir"
            fieldSize="sm"
            value={pagesDir}
            disabled={saving}
            onChange={(event) => void handlePickPagesDir(event.target.value)}
          >
            {/* The current answer is always offered, even when the probe left
                it out of its own ranking — otherwise picking and changing your
                mind would have no way back. */}
            {(candidates.some((candidate) => candidate.dir === pagesDir)
              ? candidates
              : [{ dir: pagesDir, score: 0 }, ...candidates]
            ).map((candidate) => (
              <option key={candidate.dir} value={candidate.dir}>
                {candidate.dir}
              </option>
            ))}
          </Select>
          <p className={styles.pickerHint}>
            Pick the directory holding this project&rsquo;s screens. You can change it later from the
            project&rsquo;s settings.
          </p>
        </div>
      )}

      {pages === 0 && (
        <p className={styles.warning} role="status">
          No pages were found, so the board will open empty. {candidates.length > 0
            ? 'Try another directory above.'
            : 'The repository may keep its screens somewhere Studio does not recognise yet.'}
        </p>
      )}
    </Dialog>
  )
}
