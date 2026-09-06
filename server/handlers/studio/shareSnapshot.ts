/**
 * shareSnapshot — photographing a board into a shareable directory.
 *
 * ## Why a snapshot and not a live view
 *
 * A live share would have to keep rendering the project on every visit, which
 * means keeping a browser (or the parser, or both) on the request path for an
 * anonymous visitor, and it means the link silently changes under a reviewer
 * mid-review. v1 is therefore explicitly a snapshot: the frames are
 * photographed once, written to `.studio/shares/<token>/`, and served as
 * static bytes behind a live revocation check. The UI says so ("Shared <time>
 * — update to re-capture") rather than letting a viewer assume freshness.
 *
 * ## Why it reuses the agent capture machinery verbatim
 *
 * `captureFrames` (W4-2A) already answers "give me PNGs of these pages"
 * headless-first, with the live editor tab as its fallback, with the DPR caps
 * and the failure taxonomy worked out. A second rasteriser here would be a
 * second thing to keep in step with the canvas, and the first time the two
 * disagreed a share would stop looking like the board it claims to show. So
 * this module contributes exactly what capture does not know about: which
 * frames a BOARD holds, where they sit, and how to write the result down.
 *
 * ## What is written, and what is deliberately not
 *
 * `board.json` carries a project name, a board name, a timestamp, and per
 * frame a display title and a rectangle. Not the page id. Not the file the
 * page was parsed from. Not a node id, a style rule, a class name, or the
 * workspace directory. The frame images are named `<snapshotId>-<index>.png`,
 * an opaque pair, so even the FILENAMES say nothing about the repository.
 *
 * The snapshot id also makes the images safely cacheable: re-capturing a
 * share mints a fresh id, so the new `board.json` points at filenames no
 * browser has ever seen and an `immutable` cache header can never serve a
 * stale frame.
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FRAME_HEIGHT, FRAME_WIDTH, type Board } from '@core/studio-board'
import { Type, safeParseValue } from '@core/utils/typeboxHelpers'
import type { SharedBoard, SharedFrame } from '@core/studio-share'
import { captureFrames } from '../../ai/mcp/capture/captureFrames'
import { readBoardsFileOrEmpty } from './boardGeometry'
import { loadStudioPages } from '../studioPageLoad'
import { projectDisplayName } from '../studioProjects'
import { deleteShareSnapshot, shareSnapshotDir } from './shareStore'

/**
 * The per-frame entries `studio_export_frames` returns, whichever capture
 * path produced them. `captureFrames` hands back an `AiToolOutput` whose
 * `data` is `unknown` by construction (it is a tool payload, not a typed
 * return), so it gets validated here like any other untyped boundary — and
 * tolerantly: a `frames[]` entry that failed is a per-frame failure the
 * snapshot reports, not a malformed response.
 */
const CaptureFrameResultSchema = Type.Object({
  pageId: Type.String(),
  ok: Type.Boolean(),
  imageIndex: Type.Optional(Type.Number()),
  error: Type.Optional(Type.String()),
})

const CaptureDataSchema = Type.Object({
  frames: Type.Array(CaptureFrameResultSchema),
})

export interface ShareSnapshotInput {
  dir: string
  token: string
  board: Board
  /** The user the capture runs on behalf of — carried through to the live-bridge fallback. */
  userId: string
}

/**
 * Injectable seams for tests — never passed by the route. Mirrors
 * `HeadlessCaptureOverrides`: a share test must be able to assert what is
 * WRITTEN without launching Chromium, and the thing worth asserting (that the
 * manifest carries no page ids, no source paths, no node ids) is entirely
 * independent of who produced the pixels.
 */
export interface ShareSnapshotOverrides {
  captureFrames?: typeof captureFrames
  /** Page id → display title. Stands in for the parse when a fixture has no real pages. */
  titles?: Map<string, string>
}

export type ShareSnapshotResult =
  | { ok: true; snapshot: SharedBoard }
  | { ok: false; error: string }

/** `<snapshotId>-<index>.png` — matches `SHARE_IMAGE_FILE_RE`'s expectations. */
function mintSnapshotId(): string {
  return randomBytes(6).toString('hex')
}

/**
 * Photograph `board` and write the snapshot. Replaces whatever was in the
 * share's directory: an update is a full re-capture, never a merge, so a
 * frame the designer deleted from the board cannot survive in a share.
 */
export async function writeShareSnapshot(
  input: ShareSnapshotInput,
  overrides: ShareSnapshotOverrides = {},
): Promise<ShareSnapshotResult> {
  const snapshotDir = shareSnapshotDir(input.dir, input.token)
  if (!snapshotDir) return { ok: false, error: 'Invalid share token.' }

  const frames = input.board.frames
  if (frames.length === 0) {
    return { ok: false, error: 'This board has no frames yet, so there is nothing to share. Add a screen to the board and try again.' }
  }

  // Titles come from the parse, which the capture is about to do anyway — the
  // shared `pageParseCache` means asking for them here is close to free.
  const titleByPageId =
    overrides.titles ?? new Map((await loadStudioPages(input.dir)).pages.map((page) => [page.id, page.title]))

  // Unique page ids: a board may hold two frames of the SAME page (a
  // duplicated variant), and photographing it twice would cost a second
  // render for identical bytes. Both frames reference the one image.
  const pageIds = [...new Set(frames.map((frame) => frame.pageId))]
  const capture = overrides.captureFrames ?? captureFrames
  const outcome = await capture({ userId: input.userId, dir: input.dir, pageIds })
  if (!outcome.output.ok) {
    return { ok: false, error: outcome.output.error ?? 'The board could not be photographed.' }
  }

  const parsed = safeParseValue(CaptureDataSchema, outcome.output.data ?? {})
  if (!parsed.ok) {
    return {
      ok: false,
      error: `The capture returned a result this server could not validate: ${parsed.errors.map((e) => `${e.path} ${e.message}`).join('; ')}`,
    }
  }

  const images = outcome.output.images ?? []
  const resultByPageId = new Map<string, { imageIndex?: number; ok: boolean }>()
  for (const frame of parsed.value.frames) {
    if (!resultByPageId.has(frame.pageId)) {
      resultByPageId.set(frame.pageId, { ok: frame.ok, ...(frame.imageIndex === undefined ? {} : { imageIndex: frame.imageIndex }) })
    }
  }

  const snapshotId = mintSnapshotId()
  const written: Array<{ file: string; bytes: Buffer }> = []
  const sharedFrames: SharedFrame[] = []

  for (const [index, frame] of frames.entries()) {
    const result = resultByPageId.get(frame.pageId)
    if (!result?.ok || result.imageIndex === undefined) continue
    const image = images[result.imageIndex]
    if (!image) continue

    const file = `${snapshotId}-${index}.png`
    written.push({ file, bytes: Buffer.from(image.data, 'base64') })
    sharedFrames.push({
      name: titleByPageId.get(frame.pageId) ?? 'Untitled',
      x: frame.x,
      y: frame.y,
      width: frame.width ?? FRAME_WIDTH,
      height: frame.height ?? FRAME_HEIGHT,
      image: file,
    })
  }

  if (sharedFrames.length === 0) {
    return { ok: false, error: 'None of this board’s frames could be photographed, so there is nothing to share yet.' }
  }

  const snapshot: SharedBoard = {
    version: 1,
    projectName: projectDisplayName(input.dir),
    boardName: input.board.name,
    sharedAt: new Date().toISOString(),
    frames: sharedFrames,
  }

  // Wipe first: an update must not leave the previous capture's PNGs behind,
  // where they would be unreferenced bytes of someone's design sitting in a
  // directory the public route can reach.
  deleteShareSnapshot(input.dir, input.token)
  mkdirSync(snapshotDir, { recursive: true })
  for (const entry of written) writeFileSync(join(snapshotDir, entry.file), entry.bytes)
  writeFileSync(join(snapshotDir, 'board.json'), `${JSON.stringify(snapshot, null, 2)}\n`)

  return { ok: true, snapshot }
}

/** The board a share targets, or `null` when the id names no board in this project. */
export function findBoard(dir: string, boardId: string | undefined): Board | null {
  const file = readBoardsFileOrEmpty(dir)
  if (!boardId) return file.boards[0] ?? null
  return file.boards.find((board) => board.id === boardId) ?? null
}
