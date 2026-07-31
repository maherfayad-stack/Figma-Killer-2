/**
 * ImportProjectButton — Studio's "Import project" entry point (WS-1.1).
 * Opens `ImportProjectDialog` on click; the dialog owns the three import
 * paths (GitHub / Upload / Local folder) and the request itself. Mounted
 * only in Studio mode — see `AdminCanvasLayout`'s `rightSlot`, alongside
 * `DownloadCodeButton`.
 *
 * Formerly `ImportGithubButton` (GitHub-only). Renamed alongside
 * `ImportGithubDialog` → `ImportProjectDialog`.
 *
 * `ImportProjectDialog` is lazy-loaded: it pulls in the `Dialog`/`Tabs`
 * primitives + both import clients, and is closed 99% of the time. Same
 * pattern as `SettingsModal`/`PreviewOverlay` in `AdminCanvasLayout` — keeps
 * it out of the eager Site route shell (see `bundle-size-budgets.test.ts`'s
 * SitePage budget) until the user actually opens it.
 */
import { lazy, Suspense, useState } from 'react'
import { CodeIcon } from 'pixel-art-icons/icons/code'
import { Button } from '@ui/components/Button'

const ImportProjectDialog = lazy(() =>
  import('@site/studio/ImportProjectDialog').then((m) => ({ default: m.ImportProjectDialog })),
)

export function ImportProjectButton() {
  const [open, setOpen] = useState(false)

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        data-testid="toolbar-import-project-btn"
        aria-label="Import project"
        tooltip="Import project"
        onClick={() => setOpen(true)}
      >
        <CodeIcon size={14} aria-hidden="true" />
        <span>Import project</span>
      </Button>
      {open && (
        <Suspense fallback={null}>
          <ImportProjectDialog onClose={() => setOpen(false)} />
        </Suspense>
      )}
    </>
  )
}
