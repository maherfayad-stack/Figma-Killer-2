/**
 * projectThumbnail — photographs one project for its launcher tile.
 *
 * W7-3 of `STUDIO-WAVE7-PLAN.md`. The launcher's whole job is "choose a
 * project", and until now every tile looked identical: a folder glyph and a
 * name. The one thing that actually distinguishes two design projects — what
 * they look like — was the one thing the launcher never showed.
 *
 * ## Why this can just take the picture
 *
 * The mechanism already exists end-to-end and needs nothing new.
 * `captureFrames` (`server/ai/mcp/capture/captureFrames.ts`) renders board
 * frames in a warm server-side Chromium with **no editor tab open**, and
 * `headlessCapture.ts`'s module doc argues at length why that path needs no
 * trust gate: `/admin/agent-capture` draws Studio's OWN parse output — the
 * `Page` trees the bounded static evaluator produced by READING the AST — via
 * Studio's own module renderers. No component of the user's is invoked, no
 * hook is called, no `import` of project code is evaluated. Parse-never-execute
 * holds here exactly as it holds in the live canvas, so a thumbnail is
 * available at Tier 0, which is every fresh import's default and therefore
 * every project whose tile most needs a picture.
 *
 * `source: 'headless'` is passed explicitly rather than left at `auto`. The
 * fallback `auto` would take is the LIVE editor tab, and hijacking whatever
 * project a user currently has open — panning its board, remounting its
 * frames — to refresh a thumbnail for some other project is not a trade a
 * background job gets to make. If Chromium cannot run, this simply produces no
 * thumbnail and the tile keeps its folder glyph.
 *
 * ## The capture entry needed no new option
 *
 * The work order allowed for adding a `purpose: 'thumbnail'` scale to
 * `@core/ai`'s `CapturePurpose`. It turned out to be unnecessary and would
 * have been dead weight: `effectiveCaptureRatio`'s `'vision'` cap only ever
 * BINDS above 1568px on an edge, and this capture asks for `dpr: 1` — the
 * cheapest render the path offers. The downscale to tile size is `sharp`'s job
 * here, after the fact, where the exact 4:3 crop is decided anyway. So nothing
 * under `server/ai/mcp/capture/` or `src/core/ai/` was touched.
 *
 * ## Which frame gets photographed
 *
 * The first board's visually-first frame — sorted by `(y, x)`, i.e. the one a
 * reader's eye lands on, not whichever happens to be first in the JSON array —
 * unless that board holds a page whose file is named `Home` or `index`, which
 * wins. There is no "home page" flag anywhere in the board model
 * (`BoardFrame` has `id`/`pageId`/geometry and nothing else), so the filename
 * is the only stated intent available, and it is the convention every
 * scaffolded project follows (`/create` writes `pages/Home.tsx`).
 */
import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import sharp from 'sharp'
import { captureFrames, type CaptureFramesOverrides } from '../../ai/mcp/capture/captureFrames'
import { readBoardsFileOrEmpty } from './boardGeometry'
import {
  PROJECT_THUMBNAIL_HEIGHT,
  PROJECT_THUMBNAIL_WIDTH,
  projectThumbnailFile,
} from './projectThumbnailFile'

/**
 * The `userId` recorded on the capture grant. `CaptureGrant.userId` is carried
 * for logging and attribution only and never widens access (the grant
 * authorises exactly two reads, both scoped to the one `dir` it names), so a
 * background job that acts for no particular user says so rather than
 * borrowing a real account's identity.
 */
const THUMBNAIL_CAPTURE_USER = 'studio:thumbnail'

/** Page-id file basenames that outrank board position when choosing what to photograph. */
const HOME_PAGE_BASENAMES = new Set(['home', 'index'])

/** Why no thumbnail was produced. All four are ordinary, none is an exception worth throwing. */
export type ProjectThumbnailFailure = 'no-frame' | 'capture-failed' | 'no-image' | 'write-failed'

export type CaptureProjectThumbnailResult =
  | { ok: true; file: string; updatedAt: number }
  | { ok: false; reason: ProjectThumbnailFailure; error: string }

/**
 * The page whose frame represents this project, or `null` when the board has
 * no frames at all (a project that has never been opened, or one whose
 * `.studio/boards.json` does not exist yet). `null` is the common case on a
 * fresh import and is why the queue can enqueue every project cheaply: this
 * read is one small JSON file and it short-circuits before any browser work.
 */
export function thumbnailPageId(dir: string): string | null {
  const board = readBoardsFileOrEmpty(dir).boards.find((candidate) => candidate.frames.length > 0)
  if (!board) return null
  const frames = [...board.frames].sort((a, b) => a.y - b.y || a.x - b.x)
  const home = frames.find((frame) => isHomePageId(frame.pageId))
  return (home ?? frames[0])?.pageId ?? null
}

/**
 * A page id is `<relFile>:<line>:<col>` (page-parser), so the file is
 * everything before the trailing two numeric segments. Matching on the
 * basename keeps this true for a nested page (`pages/marketing/Home.tsx`) and
 * for either extension.
 */
function isHomePageId(pageId: string): boolean {
  const file = pageId.replace(/:\d+:\d+$/, '')
  const base = file.split('/').pop() ?? file
  return HOME_PAGE_BASENAMES.has(base.replace(/\.[jt]sx?$/i, '').toLowerCase())
}

/**
 * Fits a captured frame into the tile's 4:3 box.
 *
 * Scaled by WIDTH, then cropped from the top — never centre-cropped. A design
 * screen's identity is its top: the header, the hero, the nav. Scaling to
 * `cover` a 4:3 box would centre-crop a 390×844 phone screen down to a band of
 * its middle, which is the least recognisable part of it. A frame shorter than
 * the box (a wide, short banner) is padded at the bottom with TRANSPARENT
 * pixels rather than a colour, so the card's own `--bg-surface-3` shows
 * through and the padding follows the viewer's theme instead of fighting it.
 */
async function fitToTile(png: Buffer): Promise<Buffer> {
  const scaled = await sharp(png).resize({ width: PROJECT_THUMBNAIL_WIDTH }).png().toBuffer()
  const height = (await sharp(scaled).metadata()).height ?? PROJECT_THUMBNAIL_HEIGHT
  if (height === PROJECT_THUMBNAIL_HEIGHT) return scaled
  if (height > PROJECT_THUMBNAIL_HEIGHT) {
    return sharp(scaled)
      .extract({ left: 0, top: 0, width: PROJECT_THUMBNAIL_WIDTH, height: PROJECT_THUMBNAIL_HEIGHT })
      .png()
      .toBuffer()
  }
  return sharp(scaled)
    .extend({ bottom: PROJECT_THUMBNAIL_HEIGHT - height, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer()
}

/**
 * Captures `dir`'s representative frame and writes `.studio/thumbnail.png`.
 *
 * Returns a result rather than throwing, because every caller is a background
 * job whose correct response to a failure is "leave the folder glyph up" — see
 * `./projectThumbnailQueue.ts`, which is the only thing that should call this
 * in production (it serialises the captures and remembers the failures).
 *
 * `overrides` is the capture path's own test seam (`launchBrowser`, `baseUrl`,
 * timeouts) passed straight through, so a test can drive this without a
 * browser at all.
 */
export async function captureProjectThumbnail(
  dir: string,
  overrides: CaptureFramesOverrides = {},
): Promise<CaptureProjectThumbnailResult> {
  const pageId = thumbnailPageId(dir)
  if (!pageId) {
    return { ok: false, reason: 'no-frame', error: 'This project has no board frame to photograph yet.' }
  }

  const outcome = await captureFrames(
    { userId: THUMBNAIL_CAPTURE_USER, dir, pageIds: [pageId], dpr: 1, source: 'headless' },
    overrides,
  )
  if (!outcome.output.ok) {
    return {
      ok: false,
      reason: 'capture-failed',
      error: outcome.output.error ?? 'The headless capture reported no reason.',
    }
  }
  const image = outcome.output.images?.[0]
  if (!image) {
    // The batch succeeded but the one frame in it did not rasterise — the
    // per-frame `{ ok: false }` shape `runCapture` reports for a page the
    // capture surface never rendered.
    return { ok: false, reason: 'no-image', error: `The capture produced no image for "${pageId}".` }
  }

  try {
    const file = projectThumbnailFile(dir)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, await fitToTile(Buffer.from(image.data, 'base64')))
    return { ok: true, file, updatedAt: statSync(file).mtimeMs }
  } catch (err) {
    return {
      ok: false,
      reason: 'write-failed',
      error: `Could not write the thumbnail: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}
