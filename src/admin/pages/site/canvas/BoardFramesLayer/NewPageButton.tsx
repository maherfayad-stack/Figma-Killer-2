/**
 * NewPageButton — one click creates a brand-new page in the active project (a
 * real `pages/<Component>.tsx` file, auto-named `Page`, `Page2`, …) and drops
 * it onto the active board as a frame. Studio users author pages, not just
 * curate already-made ones — no naming step first.
 *
 * Flow: click → `createStudioPage()` writes the starter file (server picks the
 * next free `PageN` name) and returns its derived `pageId` → `addFrame(pageId)`
 * places it on the active board → `requestCmsSiteReload()` re-parses the
 * workspace so the new page renders in its frame. Self-gates on
 * `selectActiveBoard`, like `AddFramePicker`: renders nothing outside studio
 * board mode.
 */
import { useState } from 'react'
import { useEditorStore } from '@site/store/store'
import { selectActiveBoard } from '@site/store/slices/boardSlice'
import { Button, type ButtonProps } from '@ui/components/Button'
import { pushToast } from '@ui/components/Toast'
import { getErrorMessage } from '@core/utils/errorMessage'
import { requestCmsSiteReload } from '@admin/state/adminEvents'
import { createStudioPage } from '@site/studio/fsCodemodAdapter'
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
  const addFrame = useEditorStore((s) => s.addFrame)
  const [busy, setBusy] = useState(false)

  if (!board) return null

  async function create() {
    if (busy) return
    setBusy(true)
    try {
      const page = await createStudioPage()
      // Place the new page on the active board immediately — `addFrame` only
      // references the pageId, so it's safe before the reload brings the page
      // into `site.pages`; the reload then renders it in the frame.
      addFrame(page.pageId)
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
