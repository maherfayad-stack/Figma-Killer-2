/**
 * ImportProjectButton — Studio's in-editor "Import project" entry point (WS-1.1).
 * Opens `ImportProjectDialog` on click; the dialog owns the three import
 * paths (GitHub / Upload / Local folder) and the request itself. Mounted
 * only in Studio mode — see `AdminCanvasLayout`'s `rightSlot`, alongside
 * `DownloadCodeButton`.
 *
 * Formerly `ImportGithubButton` (GitHub-only). Renamed alongside
 * `ImportGithubDialog` → `ImportProjectDialog`.
 *
 * This is no longer the only way in: the dashboard launcher offers the same
 * import beside "New project", so a user does not have to create a throwaway
 * project to reach it. Both surfaces render the same dialog through
 * `LazyImportProjectDialog` (`@admin/shared/dialogs/ImportProjectDialog`),
 * which owns the one lazy boundary that keeps the dialog's chunk out of the
 * eager Site route shell (see `bundle-size-budgets.test.ts`'s SitePage budget).
 *
 * No `onImported` here: the toolbar is already showing the editor, so the
 * dialog's own `setStudioWorkspaceDir` + `requestCmsSiteReload` is the whole
 * job. The dashboard is the caller that also has to navigate.
 */
import { useState } from 'react'
import { CodeIcon } from 'pixel-art-icons/icons/code'
import { Button } from '@ui/components/Button'
import { LazyImportProjectDialog } from '@admin/shared/dialogs/ImportProjectDialog'

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
      <LazyImportProjectDialog open={open} onClose={() => setOpen(false)} />
    </>
  )
}
