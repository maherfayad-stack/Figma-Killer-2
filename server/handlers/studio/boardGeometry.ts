/**
 * boardGeometry — small headless READ helpers over `.studio/boards.json`,
 * extracted from `server/ai/mcp/tools/studio/editTools.ts`'s local
 * `readBoardsFile` so a second server tool (`studio_recommend_export_dpr`,
 * `designReferenceTools.ts`) that only needs a frame's AUTHORED width
 * doesn't reimplement the same exists-then-parse-else-empty read. Writing
 * stays local to `editTools.ts` (`studio_set_frames` is the only mutator).
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createBoardsFile, parseBoardsFile, FRAME_WIDTH, FRAME_HEIGHT, type BoardsFile } from '@core/studio-board'

export function readBoardsFileOrEmpty(dir: string): BoardsFile {
  const file = join(dir, '.studio', 'boards.json')
  return existsSync(file) ? parseBoardsFile(readFileSync(file, 'utf8')) : createBoardsFile()
}

/**
 * The AUTHORED width Studio would capture this page's frame at, BEFORE any
 * `dpr` output scaling — `frame.width ?? FRAME_WIDTH`, the exact fallback
 * `studioExportFrames.ts` (client-side capture) itself uses, so a
 * recommendation computed from this number matches what a real
 * `studio_export_frames` call will actually request. `null` when no board
 * has a frame for this `pageId` at all (call `studio_list_pages` first).
 */
export function authoredFrameWidth(dir: string, pageId: string): number | null {
  const boardsFile = readBoardsFileOrEmpty(dir)
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
  const boardsFile = readBoardsFileOrEmpty(dir)
  for (const board of boardsFile.boards) {
    const frame = board.frames.find((f) => f.pageId === pageId)
    if (frame) return frame.height ?? FRAME_HEIGHT
  }
  return null
}
