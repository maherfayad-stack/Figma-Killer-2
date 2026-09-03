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
 * through `apiRequest` via `importGithubProject`, same as before. Every path
 * ends the same way: point the editor at the returned `dir` and reload
 * through the normal multi-file loader — this dialog never parses anything
 * itself.
 *
 * Formerly `ImportGithubDialog` (GitHub-only). Renamed because the GitHub
 * tab is now one of three, not the whole dialog.
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
import { importGithubProject } from './importGithubProject'
import { pickedFolderName, uploadProjectArchive, type UploadProjectResult } from './importUploadProject'
import { setStudioWorkspaceDir } from './studioWorkspaceDir'
import { requestImportSetupPass } from './importSetupPass'
import dialogStyles from '@admin/shared/dialogs/SiteCreateDialog/SiteCreateDialog.module.css'
import styles from './ImportProjectDialog.module.css'

interface ImportProjectDialogProps {
  onClose: () => void
}

type ImportTab = 'github' | 'upload' | 'folder'

const FORM_ID = 'studio-import-project-form'

export function ImportProjectDialog({ onClose }: ImportProjectDialogProps) {
  const [tab, setTab] = useState<ImportTab>('github')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(0)
  const [submitError, setSubmitError] = useState<string | null>(null)

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

  function handleSucceeded(result: UploadProjectResult) {
    setStudioWorkspaceDir(result.dir)
    // Queued BEFORE the reload: the editor's own listener consumes it once the
    // switch to this directory has landed, so the setup turn can never run
    // against the project that was open a moment ago.
    requestImportSetupPass(result.dir)
    requestCmsSiteReload()
    pushToast({
      kind: 'success',
      title: 'Project imported',
      body:
        (result.skipped > 0
          ? `${result.files} files imported, ${result.skipped} skipped.`
          : `${result.files} files imported.`) + ' Setting it up with the agent…',
    })
    onClose()
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (!canSubmit) return

    setBusy(true)
    setProgress(0)
    setSubmitError(null)
    try {
      if (tab === 'github') {
        const result = await importGithubProject({
          url: trimmedUrl,
          ref: ref.trim() || undefined,
          subdir: subdir.trim() || undefined,
          token: token.trim() || undefined,
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
