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
 *
 * W5-3 adds `syncStoryBoardFrames`, which places Storybook stories on a board
 * of their OWN rather than the project's — see its doc for why that is the
 * least-surprising surface for a producer that can outnumber a project's
 * screens ten to one, and why it places each story exactly once instead of
 * reconciling.
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
  FRAME_GAP,
  FRAME_HEIGHT,
  FRAME_WIDTH,
  type Board,
  type BoardsFile,
} from '@core/studio-board'
import { discoverPageFiles, projectPagesDir } from '../studioProjects'
import { pageIdFromRelPath } from '../studioPageIds'
import { mergeStudioMeta, readStudioMeta } from './studioMeta'
import type { StorySummary } from './storyDiscovery'

export function boardsFilePath(dir: string): string {
  return join(dir, '.studio', 'boards.json')
}

/** Read the project's boards, or a fresh empty file when none exists yet. */
export function readBoardsFile(dir: string): BoardsFile {
  const file = boardsFilePath(dir)
  return existsSync(file) ? parseBoardsFile(readFileSync(file, 'utf8')) : createBoardsFile()
}

/**
 * Persist a boards file, creating `.studio/` if this is the project's first
 * board write.
 *
 * Exported alongside {@link readBoardsFile} for the board-mutating MCP tools
 * (`studio_set_frames`, `studio_set_frame_axes`,
 * `studio_duplicate_frame_as_variant`), which had each grown their own copy of
 * these four lines. This module's whole reason to exist is that every
 * server-side write to the board's frame list has one owner — a private write
 * helper here plus two more elsewhere was that ownership in name only.
 */
export function writeBoardsFile(dir: string, next: BoardsFile): void {
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

/** The board a project's Storybook frames live on. Its own board, deliberately — see {@link syncStoryBoardFrames}. */
const STORIES_BOARD_NAME = 'Stories'

/**
 * Places a frame for every Storybook story that has never had one, on a board
 * of their own — W5-3.
 *
 * **Why a separate board, not the project's own.** A design system routinely
 * has more stories than screens, so folding them into `boards[0]` would double
 * (or decuple) the frame count of a board the author curated, on a load they
 * did not ask anything of. A board named "Stories" is already discoverable —
 * it appears in the board switcher next to the ones they made — and costs the
 * default board nothing. That is the "toggle or section" this feature needed,
 * expressed as the section the board model already has.
 *
 * **Why it is one-time, not reconciled.** `.studio/meta.json`'s
 * `stories.placedPageIds` records every story frame ever placed. A frame the
 * user deleted is in that list, so it never comes back; a story written after
 * the last load is not, so it appears. And once `stories.boardId` no longer
 * resolves — they deleted the whole board — nothing is placed again at all.
 * A reconciler that kept restoring what someone removed would be a worse bug
 * than the missing frame it fixes (`syncBoardFramesFromDisk` states the same
 * rule for pages).
 *
 * **Layout.** One ROW per `meta.title`, variants left to right along it, which
 * is how a design system reads: `Components/Button` is a row of buttons. This
 * is deliberately not `defaultFramePosition`'s two-column grid — that grid
 * exists to stack unrelated screens, and stories are related by construction.
 *
 * Writes nothing when there is nothing to place, so `boards.json`'s mtime
 * (which `compareVerdictCache.ts` keys on) is left alone on every load after
 * the first.
 */
export function syncStoryBoardFrames(dir: string, stories: readonly StorySummary[]): void {
  if (stories.length === 0) return
  const meta = readStudioMeta(dir)
  if (meta.stories?.enabled === false) return

  const placed = new Set(meta.stories?.placedPageIds ?? [])
  const pending = stories.filter((story) => !placed.has(story.pageId))
  if (pending.length === 0) return

  const existing = readBoardsFile(dir)
  const recordedBoardId = meta.stories?.boardId
  // A recorded id that no longer resolves means the user deleted the Stories
  // board. Honour that: place nothing, and leave the ledger as it is so a
  // later re-enable starts from a clean slate rather than half a board.
  if (recordedBoardId !== undefined && !existing.boards.some((b) => b.id === recordedBoardId)) return

  const board = recordedBoardId
    ? existing.boards.find((b) => b.id === recordedBoardId)!
    : createBoard(crypto.randomUUID(), STORIES_BOARD_NAME)

  const frameDefaults = readStudioMeta(dir).frameDefaults ?? {}
  const width = frameDefaults.width ?? FRAME_WIDTH
  const height = frameDefaults.height ?? FRAME_HEIGHT
  // Rows are keyed by title across the WHOLE story set, not just the pending
  // slice, so a story added later lands in its component's existing row
  // instead of starting a second one.
  const rowIndex = new Map<string, number>()
  const columnsUsed = new Map<string, number>()
  const pendingPageIds = new Set(pending.map((story) => story.pageId))
  for (const story of stories) {
    if (!rowIndex.has(story.title)) rowIndex.set(story.title, rowIndex.size)
    // Already-placed siblings hold the leading columns of their row, so a
    // newly-written story lands after them rather than on top of one.
    if (!pendingPageIds.has(story.pageId)) {
      columnsUsed.set(story.title, (columnsUsed.get(story.title) ?? 0) + 1)
    }
  }

  let next: Board = board
  for (const story of pending) {
    const column = columnsUsed.get(story.title) ?? 0
    columnsUsed.set(story.title, column + 1)
    next = upsertFrame(next, {
      id: crypto.randomUUID(),
      pageId: story.pageId,
      x: column * (width + FRAME_GAP),
      y: (rowIndex.get(story.title) ?? 0) * (height + FRAME_GAP),
      width,
      height,
    })
  }

  writeBoardsFile(dir, upsertBoard(existing, next))
  mergeStudioMeta(dir, {
    stories: {
      ...meta.stories,
      boardId: next.id,
      placedPageIds: [...placed, ...pending.map((story) => story.pageId)],
    },
  })
}

/** Whether `.studio/boards.json` already carries a frame for `pageId` on any board. */
function boardHasFrameForPage(dir: string, pageId: string): boolean {
  if (!existsSync(boardsFilePath(dir))) return false
  return readBoardsFile(dir).boards.some((board) => board.frames.some((frame) => frame.pageId === pageId))
}
