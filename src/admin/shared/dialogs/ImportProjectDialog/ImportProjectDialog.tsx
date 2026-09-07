/**
 * ImportProjectDialog — "get a studio workspace from somewhere" (WS-1.1).
 * One dialog, three tabs, one ingest engine on the server
 * (`server/handlers/studio/{studioGithubImport,importUpload}.ts` — see
 * `archiveIngest.ts`'s module doc for how they share it):
 *
 *   - **GitHub** — a repo URL (+ optional branch/subdir/token). Calls
 *     `importGithubProject` (`POST /admin/api/studio/import-github`).
 *   - **Upload** — a single `.zip` file. Calls `uploadProjectArchive` with
 *     `kind: 'zip'`.
 *   - **Local folder** — an `<input webkitdirectory>` folder pick, which
 *     arrives as N files. Calls `uploadProjectArchive` with
 *     `kind: 'directory'`.
 *
 * Upload/folder go through `uploadProjectArchive` (XHR, for progress on a
 * ~100 MB archive — `fetch` has no upload-progress event); GitHub goes
 * through `importGithubProject`, which starts a server-side JOB and polls it,
 * so a clone that takes a minute reports what it is doing instead of showing
 * a button that reads "Importing…".
 *
 * Every path ends the same way: the finished `ImportSummary` replaces this
 * form with `ImportSummaryDialog` — framework, pages dir, page count, and a
 * picker when the probe had to guess — and only THEN does the editor get
 * pointed at the imported `dir`. This dialog never parses anything itself.
 *
 * Formerly `ImportGithubDialog` (GitHub-only). Renamed because the GitHub
 * tab is now one of three, not the whole dialog.
 *
 * It lives under `@admin/shared/dialogs/` rather than `@site/studio/` because
 * importing a repository is how a user *reaches* Studio, not something they do
 * once already inside it: the dashboard launcher mounts it beside "New
 * project", and the Studio toolbar mounts it too. Both go through the one lazy
 * boundary in `LazyImportProjectDialog.tsx`. The import *clients* it calls
 * (`importGithubProject`, `importUploadProject`, `studioWorkspaceDir`) stay in
 * `@site/studio/` — those are the Studio workspace's wire contract, and this
 * dialog is only their first caller.
 */
import { useId, useRef, useState, type FormEvent, type CSSProperties } from 'react'
import { Button } from '@ui/components/Button'
import { Dialog } from '@ui/components/Dialog'
import { FileUpload } from '@ui/components/FileUpload'
import { Input } from '@ui/components/Input'
import { Tab, TabList, TabPanel, Tabs } from '@ui/components/Tabs'
import { pushToast } from '@ui/components/Toast'
import { getErrorMessage } from '@core/utils/errorMessage'
import { requestCmsSiteReload } from '@admin/state/adminEvents'
import { importGithubProject, type ImportProgress } from '@site/studio/importGithubProject'
import { pickedFolderName, uploadProjectArchive } from '@site/studio/importUploadProject'
import type { ImportSummary } from '@site/studio/importSummary'
import { setStudioWorkspaceDir } from '@site/studio/studioWorkspaceDir'
import { ImportSummaryDialog } from './ImportSummaryDialog'
import dialogStyles from '@admin/shared/dialogs/SiteCreateDialog/SiteCreateDialog.module.css'
import styles from './ImportProjectDialog.module.css'

interface ImportProjectDialogProps {
  onClose: () => void
  /**
   * Fired after the imported project has been made the open workspace
   * (`setStudioWorkspaceDir` + `requestCmsSiteReload`), before `onClose`.
   * The Studio toolbar omits it — it is already showing the editor. The
   * dashboard passes a navigation into the editor, so importing from the
   * launcher lands the user in the project it just created.
   */
  onImported?: () => void
}

type ImportTab = 'github' | 'upload' | 'folder'

const FORM_ID = 'studio-import-project-form'

export function ImportProjectDialog({ onClose, onImported }: ImportProjectDialogProps) {
  const [tab, setTab] = useState<ImportTab>('github')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(0)
  const [githubProgress, setGithubProgress] = useState<ImportProgress | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  // The finished import. Set instead of closing, so the summary step replaces
  // this form rather than flashing past it on the way to the board.
  const [summary, setSummary] = useState<ImportSummary | null>(null)

  // GitHub tab fields
  const [url, setUrl] = useState('')
  const [ref, setRef] = useState('')
  const [subdir, setSubdir] = useState('')
  const [token, setToken] = useState('')

  // Upload tab
  const [zipFile, setZipFile] = useState<File | null>(null)
  const [zipRootName, setZipRootName] = useState('')

  // Local-folder tab
  const [folderFiles, setFolderFiles] = useState<File[]>([])
  const [folderRootName, setFolderRootName] = useState('')

  const urlInputRef = useRef<HTMLInputElement>(null)

  const urlId = useId()
  const refId = useId()
  const subdirId = useId()
  const tokenId = useId()
  const zipNameId = useId()
  const folderNameId = useId()

  const trimmedUrl = url.trim()
  const canSubmit =
    !busy &&
    (tab === 'github' ? trimmedUrl.length > 0 : tab === 'upload' ? zipFile !== null : folderFiles.length > 0)

  /**
   * Points the editor at the imported project and hands control back to the
   * host surface. Deliberately NOT called when the import lands — only when
   * the user leaves the summary step by opening the project. Switching the
   * open workspace is what makes the next editor mount reload from disk, and
   * doing it behind a dialog the user has not dismissed yet would swap the
   * project out from under a Studio toolbar import.
   */
  function openImported(imported: ImportSummary) {
    setStudioWorkspaceDir(imported.dir)
    requestCmsSiteReload()
    onImported?.()
    onClose()
  }

  function handleSucceeded(result: ImportSummary) {
    pushToast({
      kind: 'success',
      title: 'Project imported',
      body:
        result.skipped > 0
          ? `${result.files} files imported, ${result.skipped} skipped.`
          : `${result.files} files imported.`,
    })
    setSummary(result)
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (!canSubmit) return

    setBusy(true)
    setProgress(0)
    setGithubProgress(null)
    setSubmitError(null)
    try {
      if (tab === 'github') {
        const result = await importGithubProject({
          url: trimmedUrl,
          ref: ref.trim() || undefined,
          subdir: subdir.trim() || undefined,
          token: token.trim() || undefined,
          onProgress: setGithubProgress,
        })
        handleSucceeded(result)
        return
      }

      if (tab === 'upload' && zipFile) {
        const result = await uploadProjectArchive({
          kind: 'zip',
          files: [zipFile],
          rootName: zipRootName.trim() || undefined,
          onProgress: setProgress,
        })
        handleSucceeded(result)
        return
      }

      if (tab === 'folder' && folderFiles.length > 0) {
        const result = await uploadProjectArchive({
          kind: 'directory',
          files: folderFiles,
          rootName: folderRootName.trim() || undefined,
          onProgress: setProgress,
        })
        handleSucceeded(result)
      }
    } catch (err) {
      setSubmitError(getErrorMessage(err, 'Unknown error importing the project'))
    } finally {
      setBusy(false)
    }
  }

  function handleZipPicked(file: File | undefined) {
    if (!file) return
    setZipFile(file)
    setSubmitError(null)
    if (!zipRootName.trim()) setZipRootName(file.name.replace(/\.zip$/i, ''))
  }

  function handleFolderPicked(files: File[]) {
    if (files.length === 0) return
    setFolderFiles(files)
    setSubmitError(null)
    if (!folderRootName.trim()) setFolderRootName(pickedFolderName(files) ?? '')
  }

  // The summary step REPLACES this form rather than stacking on top of it:
  // the import has already happened, and offering "Import" a second time
  // behind a summary would invite a duplicate.
  if (summary) {
    return <ImportSummaryDialog summary={summary} onClose={onClose} onOpen={openImported} />
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Import project"
      size="md"
      initialFocusRef={urlInputRef}
      footer={
        <>
          <Button variant="secondary" size="sm" type="button" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" type="submit" form={FORM_ID} disabled={!canSubmit} aria-busy={busy}>
            {busy ? 'Importing…' : 'Import'}
          </Button>
        </>
      }
    >
      <Tabs value={tab} onChange={(next) => { setTab(next); setSubmitError(null) }}>
        <TabList ariaLabel="Import source">
          <Tab value="github">GitHub</Tab>
          <Tab value="upload">Upload</Tab>
          <Tab value="folder">Local folder</Tab>
        </TabList>

        <form id={FORM_ID} className={dialogStyles.form} onSubmit={handleSubmit}>
          <TabPanel value="github">
            <div className={dialogStyles.form}>
              <div className={dialogStyles.field}>
                <label htmlFor={urlId} className={dialogStyles.label}>Repository URL</label>
                <Input
                  id={urlId}
                  ref={urlInputRef}
                  fieldSize="sm"
                  value={url}
                  onChange={(event) => {
                    setUrl(event.target.value)
                    setSubmitError(null)
                  }}
                  placeholder="https://github.com/owner/repo"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={busy}
                />
              </div>

              <div className={dialogStyles.field}>
                <label htmlFor={refId} className={dialogStyles.label}>Branch / ref (optional)</label>
                <Input
                  id={refId}
                  fieldSize="sm"
                  value={ref}
                  onChange={(event) => setRef(event.target.value)}
                  placeholder="Defaults to the repo's default branch"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={busy}
                />
              </div>

              <div className={dialogStyles.field}>
                <label htmlFor={subdirId} className={dialogStyles.label}>Subdirectory (optional)</label>
                <Input
                  id={subdirId}
                  fieldSize="sm"
                  value={subdir}
                  onChange={(event) => setSubdir(event.target.value)}
                  placeholder="e.g. apps/web"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={busy}
                />
              </div>

              <div className={dialogStyles.field}>
                <label htmlFor={tokenId} className={dialogStyles.label}>Access token (optional, for private repos)</label>
                <Input
                  id={tokenId}
                  type="password"
                  fieldSize="sm"
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                  placeholder="ghp_…"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={busy}
                />
              </div>

              {busy && tab === 'github' && <GithubImportProgress progress={githubProgress} />}
            </div>
          </TabPanel>

          <TabPanel value="upload">
            <div className={styles.tabPanelBody}>
              <div className={styles.pickRow}>
                <FileUpload
                  buttonProps={{ variant: 'secondary', size: 'sm', disabled: busy }}
                  accept=".zip,application/zip,application/x-zip-compressed"
                  onChange={(event) => {
                    handleZipPicked(event.target.files?.[0])
                    event.target.value = '' // allows re-picking the identical file later
                  }}
                >
                  Choose a .zip file
                </FileUpload>
                {zipFile ? (
                  <span className={styles.pickedSummary}>{zipFile.name}</span>
                ) : (
                  <span className={styles.pickedSummaryEmpty}>No file chosen</span>
                )}
              </div>

              <div className={dialogStyles.field}>
                <label htmlFor={zipNameId} className={dialogStyles.label}>Project name (optional)</label>
                <Input
                  id={zipNameId}
                  fieldSize="sm"
                  value={zipRootName}
                  onChange={(event) => setZipRootName(event.target.value)}
                  placeholder="Defaults to the archive's own name"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={busy}
                />
              </div>

              {busy && tab === 'upload' && <UploadProgress fraction={progress} />}
            </div>
          </TabPanel>

          <TabPanel value="folder">
            <div className={styles.tabPanelBody}>
              <div className={styles.pickRow}>
                <FolderPickButton disabled={busy} onFilesPicked={handleFolderPicked} />
                {folderFiles.length > 0 ? (
                  <span className={styles.pickedSummary}>
                    {folderRootName || 'Selected folder'} — {folderFiles.length} file
                    {folderFiles.length === 1 ? '' : 's'}
                  </span>
                ) : (
                  <span className={styles.pickedSummaryEmpty}>No folder chosen</span>
                )}
              </div>

              <div className={dialogStyles.field}>
                <label htmlFor={folderNameId} className={dialogStyles.label}>Project name (optional)</label>
                <Input
                  id={folderNameId}
                  fieldSize="sm"
                  value={folderRootName}
                  onChange={(event) => setFolderRootName(event.target.value)}
                  placeholder="Defaults to the picked folder's name"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={busy}
                />
              </div>

              {busy && tab === 'folder' && <UploadProgress fraction={progress} />}
            </div>
          </TabPanel>

          {submitError && (
            <p role="alert" className={dialogStyles.errorText}>
              {submitError}
            </p>
          )}
        </form>
      </Tabs>
    </Dialog>
  )
}

/**
 * What a GitHub import is doing right now. A phase line plus — only while the
 * archive is streaming AND GitHub declared a length — a real bar. A zipball is
 * generated on the fly and usually carries no `content-length`, so the honest
 * fallback is the byte counter alone rather than a bar wired to a made-up
 * total.
 */
function GithubImportProgress({ progress }: { progress: ImportProgress | null }) {
  const phase = progress?.phase ?? 'downloading'
  const label =
    phase === 'downloading'
      ? 'Downloading the repository…'
      : phase === 'unpacking'
        ? 'Unpacking files…'
        : 'Looking for pages…'
  const received = progress?.receivedBytes ?? 0
  const total = progress?.totalBytes ?? null

  return (
    <div className={styles.githubProgress}>
      <p className={styles.progressLabel} role="status">
        {label}
        {phase === 'downloading' && received > 0 && (
          <span className={styles.progressCount}>
            {' '}
            {formatMegabytes(received)}
            {total !== null ? ` of ${formatMegabytes(total)}` : ''}
          </span>
        )}
      </p>
      {phase === 'downloading' && total !== null && total > 0 && <UploadProgress fraction={received / total} />}
    </div>
  )
}

/** One decimal place of MB — the unit a repository download is read in. */
function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function UploadProgress({ fraction }: { fraction: number }) {
  const percent = `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`
  return (
    <div
      className={styles.progressTrack}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(Math.min(1, Math.max(0, fraction)) * 100)}
      style={{ '--import-progress': percent } as CSSProperties}
    >
      <div className={styles.progressFill} />
    </div>
  )
}

/**
 * Folder picker as its own small component — `webkitdirectory` isn't part of
 * `HTMLInputElement`'s TS typings (non-standard but universally supported;
 * same `@ts-expect-error` pattern `DropStep.tsx` already uses for the CMS
 * Super Import wizard's folder picker).
 */
function FolderPickButton({
  disabled,
  onFilesPicked,
}: {
  disabled: boolean
  onFilesPicked: (files: File[]) => void
}) {
  return (
    <FileUpload
      buttonProps={{ variant: 'secondary', size: 'sm', disabled }}
      multiple
      onChange={(event) => {
        onFilesPicked(Array.from(event.target.files ?? []))
        event.target.value = '' // allows re-picking the identical folder later
      }}
      // @ts-expect-error webkitdirectory is not in HTMLInputElement typedefs
      webkitdirectory=""
    >
      Choose a folder
    </FileUpload>
  )
}
