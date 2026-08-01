/**
 * NewPageButton — one click creates a brand-new page in the active project (a
 * real `pages/<Component>.tsx` file, auto-named `Page`, `Page2`, …). Studio
 * users author pages, not just curate already-made ones — no naming step
 * first.
 *
 * Flow: click → `createStudioPage()` writes the starter file (server picks
 * the next free `PageN` name) and auto-places it on the project's board
 * SERVER-SIDE (WS-13 step 4, D5 §11.3 — the same write path an MCP/agent
 * caller with no browser tab open goes through) → `requestCmsSiteReload()`
 * re-parses the workspace AND re-fetches `.studio/boards.json`
 * (`useStudioBoardsPersistence` in `AdminCanvasLayout.tsx` listens on the same
 * reload event), which is what actually brings the new frame onto THIS
 * board. No client-side `addFrame` call — the server's placement is the one
 * source of truth, so a page created here and one created by the agent land
 * identically instead of two independent grid-slot computations racing to be
 * the last write. Self-gates on `selectActiveBoard`, like `AddFramePicker`:
 * renders nothing outside studio board mode.
 */
import { useState } from 'react'
import { useEditorStore } from '@site/store/store'
import { selectActiveBoard } from '@site/store/slices/boardSlice'
import { Button, type ButtonProps } from '@ui/components/Button'
import { pushToast } from '@ui/components/Toast'
import { getErrorMessage } from '@core/utils/errorMessage'
import { requestCmsSiteReload } from '@admin/state/adminEvents'
import { createStudioPage } from '@site/studio/studioSaveRequests'
import { FilePlusSolidIcon } from 'pixel-art-icons/icons/file-plus-solid'

interface NewPageButtonProps {
  label?: string
  variant?: ButtonProps['variant']
  size?: ButtonProps['size']
  /** Compact icon-only trigger (e.g. a panel section header's "+"). */
  iconOnly?: boolean
  ariaLabel?: string
}

export function NewPageButton({
  label = 'New page',
  variant = 'secondary',
  size = 'sm',
  iconOnly = false,
  ariaLabel,
}: NewPageButtonProps = {}) {
  const board = useEditorStore(selectActiveBoard)
  const [busy, setBusy] = useState(false)

  if (!board) return null

  async function create() {
    if (busy) return
    setBusy(true)
    try {
      await createStudioPage()
      // The server already placed the frame (see module doc) — reload picks
      // up the page in `site.pages` AND the board frame that now references it.
      requestCmsSiteReload()
    } catch (err) {
      console.error('[NewPageButton] create page failed:', err)
      pushToast({
        kind: 'error',
        title: 'Could not create page',
        body: getErrorMessage(err, 'Unknown page error'),
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Button
      variant={variant}
      size={size}
      iconOnly={iconOnly}
      disabled={busy}
      aria-label={iconOnly ? (ariaLabel ?? label) : undefined}
      tooltip={iconOnly ? (ariaLabel ?? label) : undefined}
      onClick={() => void create()}
    >
      <FilePlusSolidIcon size={iconOnly ? 11 : 12} aria-hidden="true" />
      {!iconOnly && <span>{label}</span>}
    </Button>
  )
}
