/**
 * LauncherDropZone — drop a folder or a `.zip` anywhere on the launcher and it
 * becomes a project.
 *
 * ## Why this is the entry path worth building
 *
 * Opening an existing React repository IS the product. Until now the shortest
 * route to it was: click Import project, choose a tab, click Choose a folder,
 * pick it in an OS dialog, click Import — five deliberate acts to do the thing
 * the launcher exists for. Dragging the folder onto the window is one.
 *
 * ## Window listeners, not a wrapper element
 *
 * The zone covers the whole launcher rather than just the grid, because the
 * grid is exactly what is NOT on screen for the user this helps most: someone
 * with no projects yet, looking at an empty state. Listening on `window`
 * (mounted only by `DashboardPage`) means the target is "the launcher", which
 * is what the overlay says.
 *
 * `dragenter`/`dragleave` fire per element as the pointer crosses children, so
 * a naive boolean flickers the overlay on every internal boundary. The depth
 * counter is the standard fix: the overlay is up while more enters than leaves
 * have been seen.
 *
 * ## One drop, one import
 *
 * `classifyDrop` takes the FIRST folder or `.zip` in the drop and ignores the
 * rest. Importing N folders as N projects is a surprising amount of work to
 * trigger by accident, and merging them would invent a directory structure the
 * user never had — so the overlay's copy is singular and the toast says which
 * one was taken when a drop carried several.
 *
 * ## What it refuses, and why loudly
 *
 * `walkDroppedDirectory` prunes `node_modules`/`.git`/`dist`/`.next`/`.turbo`
 * before descending (without which a real installed repo is not droppable at
 * all), skips individual oversized files, and REFUSES the drop whole once a
 * shared cap is exceeded — a project that quietly imported 5,000 of its 40,000
 * files would look successful and be broken. The refusal names the cap and
 * what to do instead.
 *
 * The heavy modules (the walk, the upload client) are pulled in on the first
 * drop rather than at launcher mount: they are useless until a drag actually
 * happens, and the launcher's first paint should not carry them.
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { CloudUploadSolidIcon } from 'pixel-art-icons/icons/cloud-upload-solid'
import { pushToast } from '@ui/components/Toast'
import { getErrorMessage } from '@core/utils/errorMessage'
import type { ImportSummary } from '@site/studio/importSummary'
import styles from './LauncherDropZone.module.css'

interface LauncherDropZoneProps {
  /**
   * Fired with the finished import. The launcher shows the same post-import
   * summary step the Import dialog does — a drop is a shortcut past the FORM,
   * not past the confirmation.
   */
  onImported: (summary: ImportSummary) => void
  /** True while another launcher operation is in flight; a drop is ignored rather than queued. */
  disabled: boolean
}

export function LauncherDropZone({ onImported, disabled }: LauncherDropZoneProps) {
  const [dragging, setDragging] = useState(false)
  const [progress, setProgress] = useState<number | null>(null)
  // Nesting depth of the current drag. `dragenter`/`dragleave` fire per
  // element, so a plain boolean flickers as the pointer crosses children.
  const depthRef = useRef(0)
  // Read inside window listeners registered once; a state value would be
  // captured stale by the effect's closure.
  const importingRef = useRef(false)

  // The listeners are registered once and read their inputs through refs, so
  // the effect's dependencies stay empty and a re-render never re-attaches
  // four window listeners mid-drag. `onImported`/`disabled` therefore travel
  // through refs too.
  const onImportedRef = useRef(onImported)
  const disabledRef = useRef(disabled)
  // Written in an effect rather than during render: a ref write in the render
  // body is a `react-hooks/refs` error, and a drop can only happen after the
  // commit anyway.
  useEffect(() => {
    onImportedRef.current = onImported
    disabledRef.current = disabled
  }, [onImported, disabled])

  useEffect(() => {
    function reset() {
      depthRef.current = 0
      setDragging(false)
    }

    async function handleDrop(event: DragEvent) {
      const { classifyDrop, dragCarriesFiles, walkDroppedDirectory, DropTooLargeError } = await import(
        '@site/studio/droppedFolderWalk'
      )
      if (!dragCarriesFiles(event.dataTransfer)) return
      event.preventDefault()
      reset()
      if (disabledRef.current || importingRef.current || !event.dataTransfer) return

      const dropped = classifyDrop(event.dataTransfer)
      if (dropped.kind === 'none') {
        pushToast({
          kind: 'error',
          title: 'Nothing importable in that drop',
          body: 'Drop a project folder, or a .zip of one.',
        })
        return
      }

      importingRef.current = true
      setProgress(0)
      try {
        const { uploadProjectArchive } = await import('@site/studio/importUploadProject')
        const summary =
          dropped.kind === 'zip'
            ? await uploadProjectArchive({
                kind: 'zip',
                files: [dropped.file],
                rootName: dropped.file.name.replace(/\.zip$/i, ''),
                onProgress: setProgress,
              })
            : await (async () => {
                const walked = await walkDroppedDirectory(dropped.entry)
                if (walked.files.length === 0) {
                  throw new Error('That folder had no importable files in it.')
                }
                return uploadProjectArchive({
                  kind: 'directory',
                  files: walked.files,
                  rootName: walked.rootName,
                  onProgress: setProgress,
                })
              })()

        pushToast({
          kind: 'success',
          title: 'Project imported',
          body:
            summary.skipped > 0
              ? `${summary.files} files imported, ${summary.skipped} skipped.`
              : `${summary.files} files imported.`,
        })
        onImportedRef.current(summary)
      } catch (err) {
        console.error('[LauncherDropZone] drop import failed:', err)
        pushToast({
          kind: 'error',
          // A cap refusal is not a failure of the product — it is the drop
          // being too big — so it gets its own title and keeps its own
          // actionable message as the body.
          title: err instanceof DropTooLargeError ? 'That folder is too large to drop' : 'Could not import that drop',
          body: getErrorMessage(err, 'Unknown import error'),
        })
      } finally {
        importingRef.current = false
        setProgress(null)
      }
    }

    function handleDragEnter(event: DragEvent) {
      if (!event.dataTransfer || !Array.from(event.dataTransfer.types).includes('Files')) return
      depthRef.current += 1
      if (!disabledRef.current && !importingRef.current) setDragging(true)
    }

    function handleDragOver(event: DragEvent) {
      if (!event.dataTransfer || !Array.from(event.dataTransfer.types).includes('Files')) return
      // Without this the browser navigates to the dropped file — the default
      // behaviour that makes an un-handled drop lose the user's page.
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
    }

    function handleDragLeave() {
      depthRef.current = Math.max(0, depthRef.current - 1)
      if (depthRef.current === 0) setDragging(false)
    }

    const onDrop = (event: DragEvent) => void handleDrop(event)
    window.addEventListener('dragenter', handleDragEnter)
    window.addEventListener('dragover', handleDragOver)
    window.addEventListener('dragleave', handleDragLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', handleDragEnter)
      window.removeEventListener('dragover', handleDragOver)
      window.removeEventListener('dragleave', handleDragLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [])

  const importing = progress !== null
  if (!dragging && !importing) return null

  return (
    <div className={styles.overlay} role="status" aria-live="polite">
      <div className={styles.panel}>
        <CloudUploadSolidIcon size={28} aria-hidden="true" />
        {importing ? (
          <>
            <p className={styles.headline}>Importing…</p>
            <div
              className={styles.progressTrack}
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(Math.min(1, Math.max(0, progress)) * 100)}
              style={{ '--drop-progress': `${Math.round(Math.min(1, Math.max(0, progress)) * 100)}%` } as CSSProperties}
            >
              <div className={styles.progressFill} />
            </div>
          </>
        ) : (
          <>
            <p className={styles.headline}>Drop a folder or .zip to import</p>
            <p className={styles.hint}>
              One project per drop. node_modules, .git and build output are left behind.
            </p>
          </>
        )}
      </div>
    </div>
  )
}
