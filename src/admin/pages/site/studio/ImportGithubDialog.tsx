/**
 * ImportGithubDialog — Phase 7B's "Import from GitHub" entry point.
 *
 * Collects a repo URL (required) plus optional branch/ref, subdir, and a
 * token for private repos, then calls `importGithubProject`
 * (`POST /admin/api/studio/import-github`). On success, the returned `dir`
 * becomes the active studio workspace (`setStudioWorkspaceDir`) and a
 * `requestCmsSiteReload()` makes the editor load it through the SAME
 * multi-file loader every other studio workspace uses (Phase 7A) — this
 * dialog only fetches source, it does not parse or render anything itself.
 *
 * Studio-only: mounted by `ImportGithubButton`, itself only rendered
 * alongside `DownloadCodeButton` in `AdminCanvasLayout`'s studio-mode
 * branch — the Site editor's canvas layout, gated on `studioMode`.
 */
import { useId, useRef, useState, type FormEvent } from 'react'
import { Button } from '@ui/components/Button'
import { Dialog } from '@ui/components/Dialog'
import { Input } from '@ui/components/Input'
import { pushToast } from '@ui/components/Toast'
import { getErrorMessage } from '@core/utils/errorMessage'
import { requestCmsSiteReload } from '@admin/state/adminEvents'
import { importGithubProject } from './importGithubProject'
import { setStudioWorkspaceDir } from './studioWorkspaceDir'
import dialogStyles from '@admin/shared/dialogs/SiteCreateDialog/SiteCreateDialog.module.css'

interface ImportGithubDialogProps {
  onClose: () => void
}

const FORM_ID = 'studio-import-github-form'

export function ImportGithubDialog({ onClose }: ImportGithubDialogProps) {
  const [url, setUrl] = useState('')
  const [ref, setRef] = useState('')
  const [subdir, setSubdir] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const urlId = useId()
  const refId = useId()
  const subdirId = useId()
  const tokenId = useId()

  const trimmedUrl = url.trim()
  const canSubmit = trimmedUrl.length > 0 && !busy

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (!canSubmit) return

    setBusy(true)
    setSubmitError(null)
    try {
      const result = await importGithubProject({
        url: trimmedUrl,
        ref: ref.trim() || undefined,
        subdir: subdir.trim() || undefined,
        token: token.trim() || undefined,
      })

      setStudioWorkspaceDir(result.dir)
      requestCmsSiteReload()

      pushToast({
        kind: 'success',
        title: 'Imported from GitHub',
        body:
          result.skipped > 0
            ? `${result.files} files imported, ${result.skipped} skipped.`
            : `${result.files} files imported.`,
      })
      onClose()
    } catch (err) {
      setSubmitError(getErrorMessage(err, 'Unknown error importing the repository'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Import from GitHub"
      size="sm"
      initialFocusRef={inputRef}
      footer={
        <>
          <Button variant="secondary" size="sm" type="button" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            type="submit"
            form={FORM_ID}
            disabled={!canSubmit}
            aria-busy={busy}
          >
            {busy ? 'Importing…' : 'Import'}
          </Button>
        </>
      }
    >
      <form id={FORM_ID} className={dialogStyles.form} onSubmit={handleSubmit}>
        <div className={dialogStyles.field}>
          <label htmlFor={urlId} className={dialogStyles.label}>Repository URL</label>
          <Input
            id={urlId}
            ref={inputRef}
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

        {submitError && (
          <p role="alert" className={dialogStyles.errorText}>
            {submitError}
          </p>
        )}
      </form>
    </Dialog>
  )
}
