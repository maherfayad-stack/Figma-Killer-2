/**
 * DownloadCodeButton — Studio's "export" story (Phase 6D — "Download the
 * code"). Studio mode has no Publish button (its source of truth is the
 * on-disk `.tsx`, kept in sync by the idle-commit autosave); this is the
 * closest equivalent action: package the real workspace source into a zip
 * and hand it to the browser's native download flow.
 *
 * Mounted only in Studio mode — see `AdminCanvasLayout`'s `rightSlot`, which
 * gates it alongside (in place of) `PublishButton`.
 */
import { useState } from 'react'
import { ArrowBarDownIcon } from 'pixel-art-icons/icons/arrow-bar-down'
import { Button } from '@ui/components/Button'
import { pushToast } from '@ui/components/Toast'
import { getErrorMessage } from '@core/utils/errorMessage'
import { downloadStudioCode } from '@site/studio/downloadStudioCode'
import { getStudioWorkspaceDir } from '@site/studio/studioWorkspaceDir'

export function DownloadCodeButton() {
  const [busy, setBusy] = useState(false)

  async function handleClick() {
    if (busy) return
    setBusy(true)
    try {
      await downloadStudioCode({ dir: getStudioWorkspaceDir() })
    } catch (err) {
      pushToast({
        kind: 'error',
        title: 'Failed to download code',
        body: getErrorMessage(err, 'Unknown error downloading the workspace source'),
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      data-testid="toolbar-download-code-btn"
      aria-label="Download code"
      tooltip="Download code"
      aria-busy={busy}
      disabled={busy}
      onClick={() => {
        void handleClick()
      }}
    >
      <ArrowBarDownIcon size={14} aria-hidden="true" />
      <span>{busy ? 'Downloading…' : 'Download code'}</span>
    </Button>
  )
}
