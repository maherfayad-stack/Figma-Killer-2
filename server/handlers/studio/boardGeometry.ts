/**
 * boardGeometry — the ONE owner of `.studio/boards.json` on the server: the
 * read, the write, and the small headless questions tools ask of it (a
 * frame's AUTHORED width and height).
 *
 * A leaf on purpose: capture, comments, shares, the prototype shell and the
 * board-mutating MCP tools all read the board, and none of them should pull
 * in `boardFrames.ts`'s page discovery to do it. There used to be three copies
 * of the exists-then-parse read (here, `boardFrames.ts`, the shell's
 * registry) plus a fourth inline in the `/boards` route; each followed a link
 * a cloned repository could plant at `.studio/boards.json`. Both halves now go
 * through `studioStore.ts`, which refuses one.
 */
import { createBoardsFile, parseBoardsFile, serializeBoardsFile, FRAME_WIDTH, FRAME_HEIGHT, type BoardsFile } from '@core/studio-board'
import { readStudioStoreDocument, studioStorePath, writeStudioStoreFile } from './studioStore'

/** The board document's store path (`.studio/boards.json`). */
export const BOARDS_FILE = 'boards.json'

/** Absolute path of the board document — for a caller that must NAME it (a cache key), never to read or write it. */
export function boardsFilePath(dir: string): string {
  return studioStorePath(dir, BOARDS_FILE)
}

/** The project's boards, or a fresh empty file when none exists yet (or the name is a link). */
export function readBoardsFile(dir: string): BoardsFile {
  return readStudioStoreDocument(dir, BOARDS_FILE, parseBoardsFile, createBoardsFile)
}

/** Persist a boards file (normalised by `serializeBoardsFile`), creating `.studio/` on the first board write. */
export function writeBoardsFile(dir: string, next: BoardsFile): void {
  writeStudioStoreFile(dir, BOARDS_FILE, serializeBoardsFile(next))
}

/**
 * The AUTHORED width Studio would capture this page's frame at, BEFORE any
 * `dpr` output scaling — `frame.width ?? FRAME_WIDTH`, the exact fallback
 * `studioExportFrames.ts` (client-side capture) itself uses, so a
 * recommendation computed from this number matches what a real
 * `studio_export_frames` call will actually request. `null` when no board
 * has a frame for this `pageId` at all (call `studio_list_pages` first).
export function authoredFrameWidth(dir: string, pageId: string): number | null {
  const boardsFile = readBoardsFile(dir)
  for (const board of boardsFile.boards) {
    const frame = board.frames.find((f) => f.pageId === pageId)
    if (frame) return frame.width ?? FRAME_WIDTH
  }
  return null
}

/**
 * The AUTHORED height Studio would capture this page's frame at, BEFORE any
 * `dpr` scaling — same fallback (`frame.height ?? FRAME_HEIGHT`) and same
 * caveat as `authoredFrameWidth`, PLUS one more: this is a NOMINAL floor, not
 * a prediction of the real captured height. `CanvasScrollUnrollInjector`
 * routinely makes the actual captured content taller than the frame's
 * authored height (see `studio_recommend_export_dpr`'s own doc comment) — so
 * a caller can only ever treat this as "the captured height will be AT LEAST
 * this", never "exactly this". `null` when no board has a frame for this
 * `pageId` at all (call `studio_list_pages` first).
 */
export function authoredFrameHeight(dir: string, pageId: string): number | null {
  const boardsFile = readBoardsFile(dir)
  for (const board of boardsFile.boards) {
    const frame = board.frames.find((f) => f.pageId === pageId)
    if (frame) return frame.height ?? FRAME_HEIGHT
  }
  return null
}
