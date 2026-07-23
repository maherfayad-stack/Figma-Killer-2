/**
 * ImportGithubButton — Studio's "Import from GitHub" entry point (Phase 7B).
 * Opens `ImportGithubDialog` on click; the dialog owns the form + the
 * request itself. Mounted only in Studio mode — see `AdminCanvasLayout`'s
 * `rightSlot`, alongside `DownloadCodeButton`.
 */
import { useState } from 'react'
import { CodeIcon } from 'pixel-art-icons/icons/code'
import { Button } from '@ui/components/Button'
import { ImportGithubDialog } from '@site/studio/ImportGithubDialog'

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
      {open && <ImportGithubDialog onClose={() => setOpen(false)} />}
    </>
  )
}
