/**
 * boardFrames — `.studio/boards.json`, kept in step with the page files on
 * disk. One module for every server-side write to the board's frame list, so
 * "which pages are visible on the board" has a single owner.
 *
 * Split out of `pageScaffold.ts`, which had grown two reasons to change:
 * scaffolding the starter FILES a new page is made of, and reconciling the
 * BOARD with whatever pages exist. The second reason is what page deletion
 * needs too — `removeBoardFramesForPage` is `autoPlaceBoardFrame`'s exact
 * mirror — and a removal function living in a module called "pageScaffold"
 * would be a dishonest name for a destructive write.
 *
 * Every function here is safe to call with no `boards.json` present: a
 * project an agent scaffolded into before any human opened it in a browser
 * has none, and that is not an error.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  createBoard,
  createBoardsFile,
  defaultFramePosition,
  parseBoardsFile,
  serializeBoardsFile,
  upsertBoard,
  upsertFrame,
  type BoardsFile,
} from '@core/studio-board'
import { discoverPageFiles, projectPagesDir } from '../studioProjects'
import { pageIdFromRelPath } from '../studioPageIds'
import { readStudioMeta } from './studioMeta'

export function boardsFilePath(dir: string): string {
  return join(dir, '.studio', 'boards.json')
}

/** Read the project's boards, or a fresh empty file when none exists yet. */
function readBoardsFile(dir: string): BoardsFile {
  const file = boardsFilePath(dir)
  return existsSync(file) ? parseBoardsFile(readFileSync(file, 'utf8')) : createBoardsFile()
}

/** Persist a boards file, creating `.studio/` if this is the project's first board write. */
function writeBoardsFile(dir: string, next: BoardsFile): void {
  const file = boardsFilePath(dir)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, serializeBoardsFile(next))
}

/**
 * Places `pageId` on the project's board at the next free grid slot
 * (`defaultFramePosition`, the same layout `boardSlice.ts`'s `addFrame`/
 * `seedFramesForActiveBoard` use client-side) and persists it — D5 §11.3.
 *
 * The FIRST board in the file is the target, matching `loadBoards`' own
 * "first board is the default" precedent (`file.boards[0].id` becomes
 * `activeBoardId` on load). When no `boards.json` exists yet at all (a brand
 * new project an agent scaffolds into before any human has opened it in a
 * browser), a board is created here — `crypto.randomUUID()` + `'Board 1'`,
 * the exact shape `boardSlice.ts`'s `loadBoards` synthesizes for the same
 * case, so a browser opening this project afterward sees no discontinuity.
 *
 * WS-10 Phase 2 keyed every `BoardFrame` by its OWN `id`, not `pageId` (two
 * frames of the same page — "duplicate as variant" — need distinct
 * addresses). `upsertFrame` mints nothing itself ("no `crypto.randomUUID()`
 * inside it", `boardsModel.ts`'s own doc) — the caller does, same as
 * `boardSlice.ts`'s own frame-creating actions, so this generates one here.
 *
 * Idempotent: a PAGE already placed on the board (by `pageId`, regardless of
 * which frame id it landed under) is left untouched rather than duplicated
 * or re-positioned — a scaffolded screen gets exactly one frame, never a
 * second "variant" of itself.
 */
export function autoPlaceBoardFrame(dir: string, pageId: string, boardId?: string): void {
  const existing = readBoardsFile(dir)
  // The board the author had OPEN wins over "the first one". Boards curate
  // subsets of the project's pages on purpose, so a page created while looking
  // at a given board belongs on THAT board; placing it on `boards[0]` instead
  // put the new screen somewhere the author was not looking and left the board
  // they were building on its empty-state card. Falls back to the first board
  // for a caller that named none (the MCP tool, an agent with no browser open)
  // and for an id that no longer resolves (a board deleted in another tab),
  // because a frame on the wrong board still beats a screen on no board at all.
  const requested = boardId ? existing.boards.find((b) => b.id === boardId) : undefined
  const board = requested ?? existing.boards[0] ?? createBoard(crypto.randomUUID(), 'Board 1')
  if (board.frames.some((f) => f.pageId === pageId)) return

  const { x, y } = defaultFramePosition(board.frames.length)
  // WS-7.2 — a page scaffolded after "apply to all pages" inherits the
  // project's own frame default instead of the hardcoded FRAME_WIDTH/HEIGHT,
  // same precedent `boardSlice.ts`'s `addFrame` follows.
  const frameDefaults = readStudioMeta(dir).frameDefaults ?? {}
  const frame: Parameters<typeof upsertFrame>[1] = { id: crypto.randomUUID(), pageId, x, y }
  if (frameDefaults.width) frame.width = frameDefaults.width
  if (frameDefaults.height) frame.height = frameDefaults.height

  writeBoardsFile(dir, upsertBoard(existing, upsertFrame(board, frame)))
}

/**
 * `autoPlaceBoardFrame`'s mirror: drop EVERY frame of `pageId`, on every
 * board, and report how many went. Called when the page's source file is
 * deleted (`pageDelete.ts`) — a frame pointing at a file that no longer
 * exists renders as a permanently-broken screen, so the two writes belong to
 * the same transaction.
 *
 * Every board, not just the active one: boards curate subsets of the same
 * pages, so a deleted page can be on several at once and leaving it on the
 * others would resurrect the broken frame the moment the author switched
 * board. This is the ONE case where that is right — `boardSlice.ts`'s
 * `removeFrameById` stays per-frame, because hiding a page from one board is
 * a different intent from deleting the page itself.
 *
 * Writes nothing when no frame matched, so a page that was never on a board
 * leaves `boards.json`'s mtime alone (`compareVerdictCache.ts` keys on it).
 */
export function removeBoardFramesForPage(dir: string, pageId: string): number {
  if (!existsSync(boardsFilePath(dir))) return 0
  const existing = readBoardsFile(dir)
  let removed = 0
  const boards = existing.boards.map((board) => {
    const frames = board.frames.filter((frame) => frame.pageId !== pageId)
    if (frames.length === board.frames.length) return board
    removed += board.frames.length - frames.length
    return { ...board, frames }
  })
  if (removed === 0) return 0
  writeBoardsFile(dir, { ...existing, boards })
  return removed
}

/**
 * Place a board frame for every page file on disk that does not have one yet,
 * and return the page ids newly placed.
 *
 * `studio_create_page` used to be the only way a page could exist, so frame
 * placement could live inside it. The agent now authors screens by writing
 * `.tsx` files directly (`claudeCliToolSurface.ts`), and nothing watches the
 * filesystem — so a freshly written screen is real, parseable, and completely
 * invisible until something reconciles the board with the directory. That
 * reconciliation is this function, called by `studio_screenshot` right before
 * it captures: "show me what I just wrote" is exactly the moment the board
 * must agree with disk.
 *
 * Idempotent and additive, leaning entirely on {@link autoPlaceBoardFrame}'s
 * own per-`pageId` idempotence: a page already placed keeps its existing
 * frame, position and size untouched, and a frame whose page file was DELETED
 * is deliberately left alone — an unasked-for removal here would silently
 * undo a board the user curated. Deleting a page removes its frames through
 * {@link removeBoardFramesForPage}, where the user actually asked for it.
 */
export function syncBoardFramesFromDisk(dir: string): string[] {
  const pagesDir = projectPagesDir(dir)
  if (!existsSync(pagesDir)) return []
  const placed: string[] = []
  for (const relPath of discoverPageFiles(pagesDir)) {
    const pageId = pageIdFromRelPath(relPath)
    if (boardHasFrameForPage(dir, pageId)) continue
    autoPlaceBoardFrame(dir, pageId)
    placed.push(pageId)
  }
  return placed
}

/** Whether `.studio/boards.json` already carries a frame for `pageId` on any board. */
function boardHasFrameForPage(dir: string, pageId: string): boolean {
  if (!existsSync(boardsFilePath(dir))) return false
  return readBoardsFile(dir).boards.some((board) => board.frames.some((frame) => frame.pageId === pageId))
}
