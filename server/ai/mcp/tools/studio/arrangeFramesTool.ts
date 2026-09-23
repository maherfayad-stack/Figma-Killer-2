/**
 * `studio_arrange_frames` — put board frames where they belong: explicit x/y,
 * or a row, a column or a grid, with an optional note above each frame saying
 * what it is (AI-17).
 *
 * `studio_set_frames` sizes frames and nothing else, and the creative block
 * asks for variants "side by side on the board". Nothing could place a frame,
 * so three variants landed wherever the grid-slot allocator put them —
 * usually stacked two to a row among unrelated screens — and a user comparing
 * A/B/C had to drag them together first. This is the missing half.
 *
 * Board geometry is `.studio/boards.json`, filesystem state the Studio UI
 * reads and writes through the same plain round trip (see `editTools.ts`'s
 * module doc for why a headless write here is not the forbidden headless
 * page-tree mutator). It never changes a frame's size, never creates or
 * removes a frame, and never touches a page file.
 *
 * ## Which frame moves
 *
 * A page may be on the board more than once — a "duplicate as variant" frame
 * under different axes is the same page twice. The FIRST frame of each page on
 * the chosen board is the one placed; the page's other frames on that board
 * move by the same offset, so a variant stays beside its source rather than
 * being left behind or stacked on top of it.
 *
 * ## Notes
 *
 * `notes` puts one sticky note above a frame (the variant's rationale — "B:
 * editorial type, airy, accent-led"). Its id is derived from the page, so
 * arranging again moves and rewrites the SAME note instead of piling up a new
 * one each time. A note is annotation on the board, never a change to a page.
 */
import { Type } from '@core/utils/typeboxHelpers'
import { toolRefusal } from '@core/ai'
import {
  FRAME_GAP,
  FRAME_HEADER_HEIGHT,
  FRAME_HEIGHT,
  FRAME_WIDTH,
  moveFrame,
  upsertNote,
  type Board,
  type BoardFrame,
} from '@core/studio-board'
import type { AiTool, ToolContext } from '../../../runtime/types'
import { resolveToolProjectDir } from './resolveToolProjectDir'
import { pushStudioLiveReload } from './liveReloadPush'
import { readBoardsFile, writeBoardsFile } from '../../../../handlers/studio/boardFrames'

/** Frames one call may place — every screen of a real project, bounded. */
const MAX_FRAMES_PER_CALL = 60
const NOTE_WIDTH_MAX = 360
const NOTE_HEIGHT = 96
/** Space between a note's bottom edge and the frame header it labels. */
const NOTE_MARGIN = 12
const NOTE_BAND = NOTE_HEIGHT + NOTE_MARGIN

const PointSchema = Type.Object(
  {
    x: Type.Number({ description: 'Board x, in board units (CSS px at 100% zoom).' }),
    y: Type.Number({ description: 'Board y, in board units. y is the top of the frame itself; its title bar sits just above it.' }),
  },
  { additionalProperties: false },
)

const ArrangeFramesInputSchema = Type.Object(
  {
    dir: Type.Optional(
      Type.String({ description: 'Absolute project directory. Defaults to the project currently open in Studio — omit it unless you deliberately mean a DIFFERENT project than the one this conversation is about.' }),
    ),
    pageIds: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), {
        minItems: 1,
        maxItems: MAX_FRAMES_PER_CALL,
        description: 'The page ids to lay out, IN ORDER (left to right, then top to bottom). Use with layout. Page ids are in the live digest\'s Board line and in studio_list_pages.',
      }),
    ),
    layout: Type.Optional(
      Type.Union([Type.Literal('row'), Type.Literal('column'), Type.Literal('grid')], {
        description: '"row" (one line, left to right — the way to compare variants), "column", or "grid" (rows of `columns`). Use with pageIds.',
      }),
    ),
    columns: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: 'Grid only: frames per row. Default: the smallest square grid that fits.' })),
    gap: Type.Optional(Type.Number({ minimum: 0, maximum: 2000, description: `Space between frames, in board units. Default ${FRAME_GAP}.` })),
    origin: Type.Optional(Type.Object(PointSchema.properties, { additionalProperties: false, description: 'Where the first frame goes. Default: the top-left of where the chosen frames are now, so the group is tidied in place.' })),
    positions: Type.Optional(
      Type.Array(
        Type.Object({ pageId: Type.String({ minLength: 1 }), ...PointSchema.properties }, { additionalProperties: false }),
        { minItems: 1, maxItems: MAX_FRAMES_PER_CALL, description: 'Explicit placement instead of a layout: each page\'s frame goes to exactly this x/y. Do not combine with pageIds/layout.' },
      ),
    ),
    notes: Type.Optional(
      Type.Array(
        Type.Object(
          {
            pageId: Type.String({ minLength: 1 }),
            text: Type.String({ minLength: 1, maxLength: 400, description: 'One or two lines: what this frame is and why — e.g. "B · editorial type, airy, accent-led. For returning users."' }),
          },
          { additionalProperties: false },
        ),
        { maxItems: MAX_FRAMES_PER_CALL, description: 'A sticky note above a frame, e.g. a variant\'s rationale. Re-arranging moves and rewrites the same note.' },
      ),
    ),
    boardId: Type.Optional(Type.String({ description: 'Which board. Default: the board that holds the most of these pages (the live digest\'s Board line names the active one).' })),
  },
  { additionalProperties: false },
)

interface Placement {
  readonly pageId: string
  readonly x: number
  readonly y: number
}

type ArrangeInput = {
  dir?: string
  pageIds?: string[]
  layout?: 'row' | 'column' | 'grid'
  columns?: number
  gap?: number
  origin?: { x: number; y: number }
  positions?: Placement[]
  notes?: Array<{ pageId: string; text: string }>
  boardId?: string
}

function frameWidth(frame: BoardFrame): number {
  return frame.width ?? FRAME_WIDTH
}

function frameHeight(frame: BoardFrame): number {
  return frame.height ?? FRAME_HEIGHT
}

/**
 * Where each page's first frame goes under a layout. Row pitch is the
 * tallest frame in the row plus its title bar and the gap (plus a note band
 * when notes are being placed), so nothing overlaps; a column is a grid of
 * one column.
 */
export function layoutPlacements(
  frames: ReadonlyArray<{ pageId: string; frame: BoardFrame }>,
  layout: 'row' | 'column' | 'grid',
  options: { columns?: number; gap: number; origin: { x: number; y: number }; noteBand: number },
): Placement[] {
  const columns = layout === 'row' ? frames.length : layout === 'column' ? 1 : (options.columns ?? Math.ceil(Math.sqrt(frames.length)))
  const placements: Placement[] = []
  let y = options.origin.y
  for (let start = 0; start < frames.length; start += columns) {
    const row = frames.slice(start, start + columns)
    let x = options.origin.x
    for (const { pageId, frame } of row) {
      placements.push({ pageId, x, y })
      x += frameWidth(frame) + options.gap
    }
    y += Math.max(...row.map(({ frame }) => frameHeight(frame))) + FRAME_HEADER_HEIGHT + options.gap + options.noteBand
  }
  return placements
}

function chooseBoard(boards: readonly Board[], pageIds: readonly string[], boardId: string | undefined): Board | null {
  if (boardId !== undefined) return boards.find((board) => board.id === boardId) ?? null
  let best: Board | null = null
  let bestCount = 0
  for (const board of boards) {
    const count = pageIds.filter((pageId) => board.frames.some((frame) => frame.pageId === pageId)).length
    if (count > bestCount) {
      best = board
      bestCount = count
    }
  }
  return best
}

const arrangeFramesTool: AiTool = {
  name: 'studio_arrange_frames',
  scope: 'shared',
  execution: 'server',
  sideEffects: 'write',
  requiresWrite: true,
  requiredCapabilities: ['studio.write'],
  description:
    'Place board frames: give pageIds + layout ("row" to compare variants side by side, "column", or "grid" with columns), or positions for explicit x/y. gap and origin are optional; by default the group is tidied in place. notes puts a sticky note above a frame — use it to label each variant with its idea. Never resizes, creates or removes a frame and never touches a page file; a page with two frames on the board (a variant under other axes) moves as a pair. Refuses no-board-frame for a page that has no frame yet (call studio_screenshot first — it places one). Returns { boardId, moved: [{ pageId, x, y }], notes }. Requires studio.write.',
  inputSchema: ArrangeFramesInputSchema,
  handler: async (input, ctx: ToolContext) => {
    const args = input as ArrangeInput
    const dir = resolveToolProjectDir(args.dir, ctx)

    const byLayout = args.pageIds !== undefined || args.layout !== undefined
    if (byLayout === (args.positions !== undefined)) {
      return toolRefusal('invalid-input', 'Pass either pageIds with a layout, or positions — exactly one of the two.', {
        remedy: 'To compare variants: { pageIds: ["HomeA", "HomeB", "HomeC"], layout: "row" }. To place frames exactly: { positions: [{ pageId, x, y }] }.',
      })
    }
    if (byLayout && (args.pageIds === undefined || args.layout === undefined)) {
      return toolRefusal('missing-param', 'A layout needs both pageIds (in order) and layout ("row", "column" or "grid").')
    }
    const pageIds = byLayout ? args.pageIds! : args.positions!.map((p) => p.pageId)
    if (new Set(pageIds).size !== pageIds.length) {
      return toolRefusal('invalid-input', 'A page is listed twice; each page is placed once.')
    }

    const boardsFile = readBoardsFile(dir)
    const board = chooseBoard(boardsFile.boards, pageIds, args.boardId)
    if (!board) {
      return args.boardId !== undefined
        ? toolRefusal('invalid-input', `There is no board "${args.boardId}" in this project.`, { remedy: 'Omit boardId to use the board that holds these pages.' })
        : toolRefusal('no-board-frame', 'None of these pages has a frame on any board yet.', { remedy: 'Call studio_screenshot on them first: it places a frame for every page that has none.' })
    }
    const missing = pageIds.filter((pageId) => !board.frames.some((frame) => frame.pageId === pageId))
    if (missing.length > 0) {
      return toolRefusal('no-board-frame', `No frame on board "${board.name}" for: ${missing.join(', ')}.`, {
        remedy: 'Call studio_screenshot on those pages first (it places their frames), or pass the boardId that holds them.',
        details: { missing },
      })
    }

    const firstFrames = pageIds.map((pageId) => ({ pageId, frame: board.frames.find((frame) => frame.pageId === pageId)! }))
    const noteByPage = new Map((args.notes ?? []).map((note) => [note.pageId, note.text]))
    const strayNotes = [...noteByPage.keys()].filter((pageId) => !pageIds.includes(pageId))
    if (strayNotes.length > 0) {
      return toolRefusal('invalid-input', `notes names pages this call does not place: ${strayNotes.join(', ')}.`)
    }

    const placements = byLayout
      ? layoutPlacements(firstFrames, args.layout!, {
        ...(args.columns === undefined ? {} : { columns: args.columns }),
        gap: args.gap ?? FRAME_GAP,
        origin: args.origin ?? {
          x: Math.min(...firstFrames.map(({ frame }) => frame.x)),
          y: Math.min(...firstFrames.map(({ frame }) => frame.y)),
        },
        noteBand: noteByPage.size > 0 ? NOTE_BAND : 0,
      })
      : args.positions!

    let next = board
    for (const placement of placements) {
      const first = firstFrames.find((entry) => entry.pageId === placement.pageId)!.frame
      const dx = placement.x - first.x
      const dy = placement.y - first.y
      for (const frame of board.frames) {
        if (frame.pageId !== placement.pageId) continue
        next = moveFrame(next, frame.id, frame.x + dx, frame.y + dy)
      }
      const text = noteByPage.get(placement.pageId)
      if (text !== undefined) {
        next = upsertNote(next, {
          id: `agent-note-${placement.pageId}`,
          x: placement.x,
          y: placement.y - FRAME_HEADER_HEIGHT - NOTE_BAND,
          w: Math.min(frameWidth(first), NOTE_WIDTH_MAX),
          h: NOTE_HEIGHT,
          text,
          color: 'yellow',
        })
      }
    }

    writeBoardsFile(dir, { ...boardsFile, boards: boardsFile.boards.map((b) => (b.id === board.id ? next : b)) })
    pushStudioLiveReload(ctx.userId, { dir, boardsChanged: true })

    return {
      ok: true,
      dir,
      boardId: board.id,
      moved: placements.map(({ pageId, x, y }) => ({ pageId, x, y })),
      ...(noteByPage.size > 0 ? { notes: [...noteByPage.keys()] } : {}),
    }
  },
}

export const studioArrangeFramesMcpTools: AiTool[] = [arrangeFramesTool]
