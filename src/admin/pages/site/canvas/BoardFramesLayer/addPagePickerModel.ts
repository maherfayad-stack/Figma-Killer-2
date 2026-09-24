/**
 * addPagePickerModel — the pure half of {@link AddPagePicker}: what the one
 * "Add page" popover offers, and how typing narrows it.
 *
 * Two sections, because there are exactly two ways a page joins the board a
 * user is looking at:
 *
 *   - **New page** — scaffold a real `pages/<Component>.tsx` in one of the
 *     four {@link PAGE_KINDS} shapes. The server writes the file AND places
 *     the frame.
 *   - **From files** — a page that already exists on disk but is not on this
 *     board (never added, or removed from it — "Remove from board" only edits
 *     `board.frames`, the `.tsx` stays). Picking one is a `boards.json` edit,
 *     nothing more.
 *
 * Both used to be separate triggers sitting next to each other (`NewPageButton`
 * and `AddFramePicker`), which asked the user to know which of two pluses they
 * wanted before knowing what they wanted. One picker, one search box: type
 * "popup" and get the kind; type a page's name or its path and get the file.
 */
import { decodeSourceNodeId, type Page } from '@core/page-tree'
import { PAGE_KINDS, type Board, type PageKind } from '@core/studio-board'

export interface NewPageOption {
  kind: PageKind
  label: string
}

export interface ExistingPageOption {
  pageId: string
  title: string
  /**
   * The file this page IS — `pages/Home.tsx`. Read back out of the root node's
   * id, which the studio parser mints as `<rel>:<line>:<col>`; empty for a page
   * whose id is not source-derived (a CMS-shaped fixture), in which case the
   * row simply shows no path rather than inventing one.
   */
  relPath: string
  /** Name of another board already showing this page, or `null` when it is on none. */
  otherBoardName: string | null
}

export interface AddPageOptions {
  newPages: NewPageOption[]
  existingPages: ExistingPageOption[]
}

/** The pick Enter runs — the first row of the first non-empty section. */
export type AddPageChoice =
  | { kind: 'new'; pageKind: PageKind }
  | { kind: 'existing'; pageId: string }

/** Project-relative source file for a page, or `''` when its id is not source-derived. */
export function pageRelPath(page: Pick<Page, 'rootNodeId'>): string {
  return decodeSourceNodeId(page.rootNodeId)?.rel ?? ''
}

/**
 * Every offer the picker can make on `activeBoard`.
 *
 * The "From files" filter is the one `AddFramePicker` has always used — every
 * page NOT already framed on this board — extended with the board that DOES
 * show it, so "Checkout" appearing twice in the list is explained rather than
 * confusing. A page on two other boards names the first; the point is "this
 * lives somewhere else too", not a full inventory.
 */
export function buildAddPageOptions({
  pages,
  boards,
  activeBoard,
}: {
  pages: readonly Pick<Page, 'id' | 'title' | 'rootNodeId'>[]
  boards: readonly Board[]
  activeBoard: Board | null
}): AddPageOptions {
  const newPages = PAGE_KINDS.map((preset) => ({ kind: preset.kind, label: preset.label }))
  if (!activeBoard) return { newPages, existingPages: [] }

  const onThisBoard = new Set(activeBoard.frames.map((frame) => frame.pageId))
  const existingPages: ExistingPageOption[] = []
  for (const page of pages) {
    if (onThisBoard.has(page.id)) continue
    const otherBoard = boards.find(
      (board) => board.id !== activeBoard.id && board.frames.some((frame) => frame.pageId === page.id),
    )
    existingPages.push({
      pageId: page.id,
      title: page.title,
      relPath: pageRelPath(page),
      otherBoardName: otherBoard?.name ?? null,
    })
  }
  return { newPages, existingPages }
}

/**
 * Narrows BOTH sections with one query — a substring match over the kind label
 * for a new page, and over the title plus the source path for an existing one.
 * Searching by path matters: two boards' worth of pages routinely share a
 * title, and the file is the thing that is actually unique.
 */
export function filterAddPageOptions(options: AddPageOptions, query: string): AddPageOptions {
  const needle = query.trim().toLowerCase()
  if (!needle) return options
  return {
    newPages: options.newPages.filter((option) => option.label.toLowerCase().includes(needle)),
    existingPages: options.existingPages.filter(
      (option) =>
        option.title.toLowerCase().includes(needle) ||
        option.relPath.toLowerCase().includes(needle),
    ),
  }
}

/**
 * What Enter picks: the first New-page row, else the first From-files row.
 * Sections keep their order, so the answer is stable and matches what the
 * popover draws top to bottom.
 */
export function firstAddPageChoice(options: AddPageOptions): AddPageChoice | null {
  const [newPage] = options.newPages
  if (newPage) return { kind: 'new', pageKind: newPage.kind }
  const [existing] = options.existingPages
  if (existing) return { kind: 'existing', pageId: existing.pageId }
  return null
}
