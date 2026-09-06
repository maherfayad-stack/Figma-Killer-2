/**
 * ShareBoardButton — the toolbar entry point for share links (W5-2).
 *
 * Studio's only way to show work to someone who is not an editor used to be
 * "Download code", which asks a reviewer to unzip a React project. This is the
 * other end of that spectrum: one URL, no account, read-only.
 *
 * The button owns nothing but the dialog's open state; everything else lives
 * in `ShareDialog`, which is where the network calls and the list are. Mounted
 * via `StudioToolbarActions`, so it ships in the editor-only lazy chunk and
 * never reaches a non-editor admin route.
 */
import { useState } from 'react'
import { LinkIcon } from 'pixel-art-icons/icons/link'
import { Button } from '@ui/components/Button'
import { ShareDialog } from './ShareDialog'

export function ShareBoardButton() {
  const [open, setOpen] = useState(false)

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        data-testid="toolbar-share-btn"
        aria-label="Share board"
        tooltip="Share a read-only link to this board"
        onClick={() => setOpen(true)}
      >
        <LinkIcon size={14} aria-hidden="true" />
        <span>Share</span>
      </Button>
      {open && <ShareDialog onClose={() => setOpen(false)} />}
    </>
  )
}
