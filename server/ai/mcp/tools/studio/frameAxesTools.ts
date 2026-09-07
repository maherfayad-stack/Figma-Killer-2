/**
 * `studio_set_frame_axes` and `studio_duplicate_frame_as_variant` — per-frame
 * preview axes and side-by-side variants, written straight to
 * `.studio/boards.json`.
 *
 * ## Why these are server tools now (W9-6)
 *
 * Both shipped as `execution: 'browser'` wrappers over `EditorStore`'s own
 * `setFrameAxes`/`duplicateFrameAsVariant`, because that is where the toolbar
 * calls them from. That reasoning does not survive one question: where does the
 * result LIVE? Not in the store. A frame's axes override and a variant frame
 * are `.studio/boards.json` — the store is holding a copy that it POSTs back
 * through `/admin/api/studio/boards` when `boardsDirty` next flushes. So the
 * browser path was a round trip through a mutable copy in order to write a
 * file the server already owns, and it cost ~8s of bridge timeout and then a
 * refusal whenever no tab was open.
 *
 * These write the file directly, through `boardFrames.ts` — the module whose
 * whole reason to exist is "every server-side write to the board's frame list
 * has one owner" — and then push a live-reload so a tab that IS open re-reads
 * `boards.json` and shows the change. Same result, no browser required, and
 * the open editor still flips in front of the user exactly as it did.
 *
 * ## Addressing
 *
 * By `pageId`, the id every other Studio tool already returns; `frameId` (from
 * a previous duplicate) addresses a specific frame when a page has several.
 * The client resolves against the ACTIVE board, which the server has no notion
 * of, so the rule here is "the first board carrying a frame for this page,
 * else the first board" — the same fallback `autoPlaceBoardFrame` documents,
 * and the same answer in every single-board project, which is nearly all of
 * them.
 */
import {
  StudioSetFrameAxesInputSchema,
  StudioDuplicateFrameAsVariantInputSchema,
} from '@core/ai'
import {
  duplicateFrame,
  setFrameAxes as setFrameAxesOnBoard,
  upsertBoard,
  FRAME_WIDTH,
  VARIANT_GAP,
  type Board,
  type BoardFrame,
  type PreviewAxes,
} from '@core/studio-board'
import type { AiTool, ToolContext } from '../../../runtime/types'
import { readBoardsFile, writeBoardsFile } from '../../../../handlers/studio/boardFrames'
import { pushStudioLiveReload } from './liveReloadPush'
import { resolveToolProjectDir } from './resolveToolProjectDir'

interface FrameLocation {
  board: Board
  frame: BoardFrame
}

/**
 * The board + frame a `pageId`/`frameId` pair names, or `null`.
 *
 * `frameId` wins when given and is matched across every board — a variant id
 * the agent is holding came from a previous call on this project, and refusing
 * it because it landed on board 2 would be a distinction the agent has no way
 * to see. Otherwise the first frame of `pageId`, scanning boards in order.
 */
function findFrame(boards: readonly Board[], pageId: string, frameId: string | undefined): FrameLocation | null {
  for (const board of boards) {
    const frame = frameId
      ? board.frames.find((f) => f.id === frameId)
      : board.frames.find((f) => f.pageId === pageId)
    if (frame) return { board, frame }
  }
  return null
}

function notFoundError(dir: string, pageId: string, frameId: string | undefined): { ok: false; error: string } {
  return {
    ok: false,
    error: frameId
      ? `No frame with id "${frameId}" on any board in ${dir}.`
      : `No frame for page "${pageId}" on any board in ${dir}. Place it on the board first — studio_screenshot places a frame for every page file that does not have one.`,
  }
}

const setFrameAxesTool: AiTool = {
  name: 'studio_set_frame_axes',
  scope: 'shared',
  execution: 'server',
  mutates: true,
  requiredCapabilities: ['studio.write'],
  description:
    'Override a board frame\'s preview direction/colorScheme/locale — the same "show this screen in RTL/dark/a specific locale" control the toolbar\'s own preview-axes UI drives. Addressed by pageId (from studio_list_pages); when a page has more than one frame, the first one found is targeted unless frameId is given explicitly. A design-review turn should call this BEFORE studio_screenshot/studio_compare to check the RTL/dark rendering, not just the default one. Writes .studio/boards.json directly, so it needs NO Studio browser tab open — and a user who does have one open sees the same frame flip, because the board is nudged to re-read from disk. Requires studio.write.',
  inputSchema: StudioSetFrameAxesInputSchema,
  handler: async (input, ctx: ToolContext) => {
    const args = input as { dir?: string; pageId: string; frameId?: string; axes: Partial<PreviewAxes> }
    const dir = resolveToolProjectDir(args.dir, ctx)
    const boardsFile = readBoardsFile(dir)
    const found = findFrame(boardsFile.boards, args.pageId, args.frameId)
    if (!found) return notFoundError(dir, args.pageId, args.frameId)

    writeBoardsFile(dir, upsertBoard(boardsFile, setFrameAxesOnBoard(found.board, found.frame.id, args.axes)))
    // No page CONTENT changed — only frame state — so the push carries no
    // pageIds, just `boardsChanged`, exactly as `studio_set_frames` does.
    pushStudioLiveReload(ctx.userId, { dir, boardsChanged: true })

    return { ok: true, data: { dir, pageId: found.frame.pageId, frameId: found.frame.id, axes: args.axes } }
  },
}

const duplicateFrameAsVariantTool: AiTool = {
  name: 'studio_duplicate_frame_as_variant',
  scope: 'shared',
  execution: 'server',
  mutates: true,
  requiredCapabilities: ['studio.write'],
  description:
    'Duplicate a board frame as a new, independently-addressable variant with its own axes override — the side-by-side comparison verb: the SAME page rendered twice on the board (e.g. LTR next to RTL) rather than one frame flipping back and forth. Addressed by pageId, same first-match rule as studio_set_frame_axes. Returns { frameId } for the new frame — pass it as frameId to a LATER studio_set_frame_axes call if you need to adjust it again. The new frame lands beside the source on the board. Writes .studio/boards.json directly, so it needs NO Studio browser tab open; an open board is nudged to re-read from disk. Requires studio.write.',
  inputSchema: StudioDuplicateFrameAsVariantInputSchema,
  handler: async (input, ctx: ToolContext) => {
    const args = input as { dir?: string; pageId: string; frameId?: string; axes: Partial<PreviewAxes> }
    const dir = resolveToolProjectDir(args.dir, ctx)
    const boardsFile = readBoardsFile(dir)
    const found = findFrame(boardsFile.boards, args.pageId, args.frameId)
    if (!found) return notFoundError(dir, args.pageId, args.frameId)

    // Beside the source, same row — `boardSlice.ts`'s own placement, sharing
    // `VARIANT_GAP` so the toolbar and this tool cannot drift apart.
    const nextBoard = duplicateFrame(found.board, found.frame.id, {
      id: crypto.randomUUID(),
      x: found.frame.x + (found.frame.width ?? FRAME_WIDTH) + VARIANT_GAP,
      y: found.frame.y,
      axes: args.axes,
    })
    if (!nextBoard) return notFoundError(dir, args.pageId, args.frameId)
    const created = nextBoard.frames[nextBoard.frames.length - 1]!

    writeBoardsFile(dir, upsertBoard(boardsFile, nextBoard))
    pushStudioLiveReload(ctx.userId, { dir, boardsChanged: true })

    return {
      ok: true,
      data: {
        dir,
        pageId: created.pageId,
        frameId: created.id,
        sourceFrameId: found.frame.id,
        x: created.x,
        y: created.y,
        axes: args.axes,
      },
    }
  },
}

export const studioFrameAxesMcpTools: AiTool[] = [setFrameAxesTool, duplicateFrameAsVariantTool]
