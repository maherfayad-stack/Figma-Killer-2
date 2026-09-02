/**
 * ImportDesignTokensButton — "Import design tokens" entry point in
 * `FrameworkPanel`'s header. Opens `DesignImportDialog` on click; the dialog
 * owns the fetch/preview/apply flow, including copying fetched CSS into the
 * project's on-disk workspace directory.
 *
 * Lazy-loaded — same pattern as `ImportProjectButton`/`SettingsModal`: pulls in
 * the `Dialog` primitive + the import client, closed 99% of the time, kept
 * out of the eager Site route shell.
 */
import { lazy, Suspense, useState } from 'react'
import { CloudUploadSolidIcon } from 'pixel-art-icons/icons/cloud-upload-solid'
import { Button } from '@ui/components/Button'

const DesignImportDialog = lazy(() =>
  import('./DesignImportDialog').then((m) => ({ default: m.DesignImportDialog })),
)

export function ImportDesignTokensButton() {
  const [open, setOpen] = useState(false)

  return (
    <>
      <Button
        variant="ghost"
        size="xs"
        iconOnly
        aria-label="Import design tokens"
        tooltip="Import design tokens from GitHub/npm"
        onClick={() => setOpen(true)}
      >
        <CloudUploadSolidIcon size={13} aria-hidden="true" />
      </Button>
      {open && (
        <Suspense fallback={null}>
          <DesignImportDialog onClose={() => setOpen(false)} />
        </Suspense>
      )}
    </>
  )
}
