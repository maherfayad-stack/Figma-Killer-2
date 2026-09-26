/**
 * AddPagePicker — the ONE "add a page to this board" affordance.
 *
 * Replaces `NewPageButton` + `AddFramePicker`, which were two adjacent pluses
 * asking the author to decide "new file or existing file?" before they had
 * decided what they wanted. This is one trigger, one search box, two sections:
 *
 *   - **New page** — the four `PAGE_KINDS`. Picking one calls
 *     `createStudioPage(undefined, kind, board.id)`: the server writes the
 *     starter files, auto-names the page for its kind, and places the frame on
 *     THIS board (D5 §11.3). The client's only job afterwards is
 *     `requestCmsSiteReload()` — there is no client-side `addFrame` here, so a
 *     page created by a human and one created by an agent land identically.
 *   - **From files** — every page already on disk that is not on this board.
 *     Picking one is `addFrame(pageId)`, a `boards.json` edit; nothing is
 *     written into the user's source. This is the "removed from the board"
 *     case: "Remove from board" never deleted the `.tsx`.
 *
 * Typing filters both sections, Enter takes the first match, Escape closes
 * (the shared `ContextMenu` owns Escape and outside-click dismissal).
 *
 * Self-gates on `selectActiveBoard`, as both predecessors did: renders nothing
 * when there is no board to add to.
 *
 * The menu body (`AddPagePickerMenu`) is also what the board tool opens at the
 * pointer after a draw on the empty board (P5-F, IX-13 —
 * `BoardDrawPagePicker`), with a `placement`: both sections then put the frame
 * where it was drawn, at the drawn size.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import { useEditorStore } from '@site/store/store'
import { selectActiveBoard } from '@site/store/slices/boardSelectors'
import { selectPageDirectory } from '@site/store/slices/pageDirectory'
import type { Board, BoardFramePlacement, PageKind } from '@core/studio-board'
import { Button, type ButtonProps } from '@ui/components/Button'
import { ContextMenu, ContextMenuItem, MenuSearchHeader } from '@ui/components/ContextMenu'
import { pushToast } from '@ui/components/Toast'
import { getErrorMessage } from '@core/utils/errorMessage'
import { requestCmsSiteReload } from '@admin/state/adminEvents'
import { createStudioPage } from '@site/studio/studioPageRequests'
import { AppGridPlusGlyphIcon } from 'pixel-art-icons/icons/app-grid-plus-glyph'
import {
  buildAddPageOptions,
  filterAddPageOptions,
  firstAddPageChoice,
  type AddPageChoice,
} from './addPagePickerModel'
import styles from './AddPagePicker.module.css'

interface AddPagePickerProps {
  label?: string
  variant?: ButtonProps['variant']
  size?: ButtonProps['size']
  /** Compact icon-only trigger (a panel section header's "+", the canvas notch). */
  iconOnly?: boolean
  ariaLabel?: string
  /** Paints the trigger with the accent fill — the canvas notch's primary "+". */
  accentFill?: boolean
  triggerClassName?: string
  triggerTestId?: string
}

export function AddPagePicker({
  label = 'Add page',
  variant = 'secondary',
  size = 'sm',
  iconOnly = false,
  ariaLabel,
  accentFill = false,
  triggerClassName,
  triggerTestId,
}: AddPagePickerProps = {}) {
  const board = useEditorStore(selectActiveBoard)
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)

  if (!board) return null

  const triggerLabel = ariaLabel ?? label

  return (
    <>
      <Button
        ref={triggerRef}
        variant={variant}
        size={size}
        iconOnly={iconOnly}
        accentFill={accentFill}
        className={triggerClassName}
        aria-label={iconOnly ? triggerLabel : undefined}
        tooltip={triggerLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        active={open}
        data-testid={triggerTestId}
        onClick={() => setOpen((current) => !current)}
      >
        <AppGridPlusGlyphIcon size={iconOnly ? 11 : 12} aria-hidden="true" />
        {!iconOnly && <span>{label}</span>}
      </Button>
      {open && (
        <AddPagePickerMenu
          board={board}
          anchorRef={triggerRef}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

/**
 * The popover body. A separate component so it MOUNTS with the menu: the
 * search query resets on every open, and the focus effect runs once, on mount,
 * without the trigger having to own either. Same split `SelectMenu` uses.
 *
 * `placement` (P5-F, IX-13): where the new frame goes — a board-tool draw.
 * Absent, the frame takes the next grid slot, as it always has.
 */
export function AddPagePickerMenu({
  board,
  anchorRef,
  onClose,
  placement,
  getAnchorRect,
}: {
  board: Board
  anchorRef: RefObject<HTMLElement | null>
  onClose: () => void
  placement?: BoardFramePlacement
  /** Position the menu at a point instead of the anchor's box (the board tool's release point). */
  getAnchorRect?: () => DOMRect | null
}) {
  const boards = useEditorStore((s) => s.boards.boards)
  // The page LIST, not `site.pages` (replaced on every edit — P2-I, PERF-12).
  const pages = useEditorStore(selectPageDirectory)
  const addFrame = useEditorStore((s) => s.addFrame)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)

  // rAF, not a bare call: the menu measures and repositions itself on mount,
  // and focusing mid-measure scrolls the panel. Same pattern as `SelectMenu`.
  useEffect(() => {
    const id = requestAnimationFrame(() => searchRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [])

  const options = filterAddPageOptions(
    buildAddPageOptions({ pages, boards, activeBoard: board }),
    query,
  )

  async function createPage(kind: PageKind) {
    if (busy) return
    setBusy(true)
    try {
      await createStudioPage(undefined, kind, board.id, placement)
      // The server already placed the frame — the reload picks up the new page
      // in `site.pages` AND the board frame that now references it.
      requestCmsSiteReload()
    } catch (err) {
      console.error('[AddPagePicker] create page failed:', err)
      pushToast({
        kind: 'error',
        title: 'Could not create page',
        body: getErrorMessage(err, 'Unknown page error'),
      })
    } finally {
      setBusy(false)
    }
  }

  function run(choice: AddPageChoice) {
    onClose()
    if (choice.kind === 'new') void createPage(choice.pageKind)
    else addFrame(choice.pageId, placement)
  }

  function handleSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Enter') return
    const choice = firstAddPageChoice(options)
    if (!choice) return
    event.preventDefault()
    run(choice)
  }

  return (
    <ContextMenu
      ariaLabel="Add page"
      onClose={onClose}
      anchorRef={anchorRef}
      getAnchorRect={getAnchorRect}
      side="bottom"
      align="start"
      width={264}
      maxHeight={360}
      header={
        <MenuSearchHeader
          inputRef={searchRef}
          value={query}
          onValueChange={setQuery}
          onKeyDown={handleSearchKeyDown}
          placeholder="Search pages…"
        />
      }
    >
      <div className={styles.sectionLabel} role="presentation">New page</div>
      {options.newPages.length === 0 ? (
        <p className={styles.empty}>No page kind matches that.</p>
      ) : (
        options.newPages.map((option) => (
          <ContextMenuItem
            key={option.kind}
            disabled={busy}
            onClick={() => run({ kind: 'new', pageKind: option.kind })}
          >
            {option.label}
          </ContextMenuItem>
        ))
      )}

      <div className={styles.sectionLabel} role="presentation">From files</div>
      {options.existingPages.length === 0 ? (
        <p className={styles.empty}>
          {query
            ? 'No page on disk matches that.'
            : 'Every page in this project is on this board.'}
        </p>
      ) : (
        options.existingPages.map((option) => (
          <ContextMenuItem
            key={option.pageId}
            className={styles.pageRow}
            onClick={() => run({ kind: 'existing', pageId: option.pageId })}
          >
            <span className={styles.pageTitle}>{option.title}</span>
            <span className={styles.pageMeta}>
              {option.relPath}
              {option.otherBoardName ? ` · on ${option.otherBoardName}` : ''}
            </span>
          </ContextMenuItem>
        ))
      )}
    </ContextMenu>
  )
}
