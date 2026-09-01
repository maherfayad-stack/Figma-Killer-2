/**
 * NewPageButton — creates a brand-new page in the active project (a real
 * `pages/<Component>.tsx` file, auto-named from the kind: `Page`, `Page2`, …
 * for a screen, `Sheet`, `Sheet2`, … for a bottom sheet). Studio users author
 * pages, not just curate already-made ones.
 *
 * The trigger opens a menu of {@link PAGE_KINDS} rather than creating a screen
 * outright. It used to be one click, and the module doc defended that as "no
 * naming step first" — which is still the rule, and this does not break it: a
 * kind menu is not a name prompt, it is the choice that used to be unavailable.
 * A journey is drawn as screens AND the things presented over them, and there
 * was no way to ask for the second kind at all; putting `Screen` first keeps
 * the common case one keystroke away while making the other three findable at
 * the moment someone wants one.
 *
 * Flow: pick a kind → `createStudioPage(undefined, kind, board.id)` writes the
 * starter files (server picks the next free name for that kind) and auto-places
 * the page on the board THIS BUTTON IS RENDERED ON, server-side (WS-13 step 4, D5 §11.3 — the same
 * write path an MCP/agent caller with no browser tab open goes through) →
 * `requestCmsSiteReload()` re-parses the workspace AND re-fetches
 * `.studio/boards.json` (`useStudioBoardsPersistence` in
 * `AdminCanvasLayout.tsx` listens on the same reload event), which is what
 * actually brings the new frame onto THIS board. No client-side `addFrame`
 * call — the server's placement is the one source of truth, so a page created
 * here and one created by the agent land identically instead of two
 * independent grid-slot computations racing to be the last write.
 *
 * `board.id` is passed explicitly because the server cannot infer it: it used
 * to place every scaffolded page on `boards[0]`, so asking for a page while
 * looking at any other board put the screen somewhere the author was not
 * looking and left the board they were building showing its empty-state card.
 *
 * Self-gates on `selectActiveBoard`, like `AddFramePicker`: renders nothing
 * outside studio board mode.
 */
import { useRef, useState } from 'react'
import { useEditorStore } from '@site/store/store'
import { selectActiveBoard } from '@site/store/slices/boardSelectors'
import { PAGE_KINDS, type PageKind } from '@core/studio-board'
import { Button, type ButtonProps } from '@ui/components/Button'
import { ContextMenu, ContextMenuItem } from '@ui/components/ContextMenu'
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
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)

  if (!board) return null

  // Captured after the guard: `create` is a hoisted function declaration, so
  // TypeScript will not carry the null-narrowing on `board` into it.
  const boardId = board.id

  async function create(kind: PageKind) {
    if (busy) return
    setBusy(true)
    try {
      await createStudioPage(undefined, kind, boardId)
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
    <>
      <Button
        ref={triggerRef}
        variant={variant}
        size={size}
        iconOnly={iconOnly}
        disabled={busy}
        aria-label={iconOnly ? (ariaLabel ?? label) : undefined}
        tooltip={iconOnly ? (ariaLabel ?? label) : undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        active={open}
        onClick={() => setOpen((current) => !current)}
      >
        <FilePlusSolidIcon size={iconOnly ? 11 : 12} aria-hidden="true" />
        {!iconOnly && <span>{label}</span>}
      </Button>
      {open && (
        <ContextMenu
          ariaLabel="New page"
          onClose={() => setOpen(false)}
          anchorRef={triggerRef}
          side="bottom"
          align="start"
          minWidth={168}
        >
          {/* Label only, one line per row. `minWidth` rather than a fixed
              `width`: the menu was pinned to 260px to fit a description line
              that no longer exists, and a four-item list of short labels in a
              260px box is mostly empty space. */}
          {PAGE_KINDS.map((preset) => (
            <ContextMenuItem
              key={preset.kind}
              onClick={() => {
                setOpen(false)
                void create(preset.kind)
              }}
            >
              {preset.label}
            </ContextMenuItem>
          ))}
        </ContextMenu>
      )}
    </>
  )
}
