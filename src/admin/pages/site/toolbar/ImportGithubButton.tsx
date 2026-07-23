/**
 * ImportGithubButton — Studio's "Import from GitHub" entry point (Phase 7B).
 * Opens `ImportGithubDialog` on click; the dialog owns the form + the
 * request itself. Mounted only in Studio mode — see `AdminCanvasLayout`'s
 * `rightSlot`, alongside `DownloadCodeButton`.
 *
 * `ImportGithubDialog` is lazy-loaded: it pulls in the `Dialog` primitive +
 * the import client, and is closed 99% of the time. Same pattern as
 * `SettingsModal`/`PreviewOverlay` in `AdminCanvasLayout` — keeps it out of
 * the eager Site route shell (see `bundle-size-budgets.test.ts`'s SitePage
 * budget) until the user actually opens it.
 */
import { lazy, Suspense, useState } from 'react'
import { CodeIcon } from 'pixel-art-icons/icons/code'
import { Button } from '@ui/components/Button'

const ImportGithubDialog = lazy(() =>
  import('@site/studio/ImportGithubDialog').then((m) => ({ default: m.ImportGithubDialog })),
)

export function ImportGithubButton() {
  const [open, setOpen] = useState(false)

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        data-testid="toolbar-import-github-btn"
        aria-label="Import from GitHub"
        tooltip="Import from GitHub"
        onClick={() => setOpen(true)}
      >
        <CodeIcon size={14} aria-hidden="true" />
        <span>Import from GitHub</span>
      </Button>
      {open && (
        <Suspense fallback={null}>
          <ImportGithubDialog onClose={() => setOpen(false)} />
        </Suspense>
      )}
    </>
  )
}
