/**
 * Headless agent capture — screenshot Studio board frames with no editor tab
 * open, and without touching one that is.
 *
 * ## Why this needs no `studio.run.project` gate
 *
 * `referenceRender.ts` is Tier 2 and gated, because it boots the PROJECT'S OWN
 * dev server: `scripts.dev` runs, every dependency it imports executes, and
 * the blast radius is the whole repo's code. That gate is correct and stays.
 *
 * This path executes none of that. `/admin/agent-capture` renders exactly what
 * the canvas renders — Studio's OWN parse output, the `Page` trees the bounded
 * static evaluator already produced by READING the AST, drawn by Studio's own
 * module renderers into Studio's own iframe surface. No component from the
 * user's project is invoked, no hook is called, no `import` of project code is
 * evaluated; the only project-authored bytes involved are CSS text and image
 * files, both inert. Parse-never-execute holds here exactly as it holds in the
 * live canvas, so this needs precisely the capability the live canvas path
 * already needs (`studio.write`) and nothing more. Gating it at Tier 2 would
 * be security theatre: it would make the SAFE path harder to reach than the
 * live-tab path that renders the identical DOM.
 *
 * ## What it does, and what it deliberately does not
 *
 * The driver mints a single-purpose capture token (`captureToken.ts`), opens
 * one page on the warm server-side Chromium (`browserPool.ts`), navigates to
 * `/admin/agent-capture?token=…`, waits for the page's own deterministic
 * readiness signal (fonts loaded, DOM quiet, preview data settled — the same
 * settle logic `AgentSnapshotFrame` uses, because it is the same code), then
 * rasterises each frame element and revokes the token.
 *
 * It never touches the user's open tab. No pan, no zoom, no active-page
 * change, no cleared selection — the three things the live-bridge path has to
 * do to a shared session in order to photograph a frame, and the reason a
 * capture used to be visible to whoever was editing at the time.
 *
 * ## Resolution
 *
 * `dpr` is applied as Chromium's `deviceScaleFactor`, so the frame is RENDERED
 * at that density rather than rasterised at 1x and scaled. The cap that
 * applies (`@core/ai`'s `effectiveCaptureRatio`) is the same one the live path
 * applies, computed first from the authored frame geometry — which the driver
 * already knows from `.studio/boards.json` before it navigates — and then
 * re-checked against the REAL captured bytes, because a scroll-unrolled page
 * can end up taller than its authored height. A capture that overshoots on
 * the second check is downscaled, and `imageScale` is derived from the actual
 * pixel width either way. A `studio_compare` verdict therefore does not depend
 * on which of the two rasterisers produced the bytes.
 */
import sharp from 'sharp'
import { aiToolOk, effectiveCaptureRatio, type AiToolImage, type AiToolOutput, type CapturePurpose } from '@core/ai'
import { safeParseJson } from '@core/utils/jsonValidate'
import { FRAME_WIDTH, FRAME_HEIGHT, type PreviewAxes } from '@core/studio-board'
import {
  AGENT_CAPTURE_GLOBAL,
  AGENT_CAPTURE_FRAME_ATTR,
  AgentCaptureReportSchema,
  type AgentCaptureReport,
} from '@core/studio-capture'
import { readBoardsFileOrEmpty } from '../../../handlers/studio/boardGeometry'
import { withCapturePage, type CapturePage, type LaunchBrowser } from './browserPool'
import { captureEntryUrl } from './captureOrigin'
import { mintCaptureToken, revokeCaptureToken } from './captureToken'

/** Navigation budget for the capture page itself (a same-machine HTTP GET plus a JS bundle). */
const NAV_TIMEOUT_MS = 20_000
/**
 * How long the page gets to settle EVERY requested frame before the driver
 * gives up on it. Deliberately one budget for the whole batch rather than one
 * per frame: the frames mount concurrently, so per-frame budgets would
 * multiply a single slow font load into a timeout twenty times over.
 */
const READY_TIMEOUT_MS = 30_000
const READY_POLL_MS = 100
/** Viewport floor/ceiling. Tall frames are captured beyond the viewport by the element screenshot. */
const MIN_VIEWPORT_HEIGHT = 900
const MAX_VIEWPORT_HEIGHT = 4_000

export interface HeadlessCaptureInput {
  userId: string
  dir: string
  pageIds: readonly string[]
  dpr?: number
  purpose?: CapturePurpose
  axes?: Partial<PreviewAxes>
}

/** Injectable seams for tests — never touched by real callers. Mirrors `ReferenceRenderOverrides`. */
export interface HeadlessCaptureOverrides {
  launchBrowser?: LaunchBrowser<CapturePage>
  baseUrl?: string
  navTimeoutMs?: number
  readyTimeoutMs?: number
}

/**
 * Every way this path can fail, named. The point of the enum is that a caller
 * falling back to the live bridge can say WHICH half failed instead of
 * reporting "no board connected" for a Chromium that would not launch.
 */
export type HeadlessCaptureFailureCode =
  | 'headless-browser-unavailable'
  | 'headless-navigation-failed'
  | 'headless-not-ready'
  | 'headless-page-error'
  | 'headless-invalid-report'

export interface HeadlessCaptureFailure {
  ok: false
  code: HeadlessCaptureFailureCode
  error: string
}

export type HeadlessCaptureResult = { ok: true; output: AiToolOutput } | HeadlessCaptureFailure

interface AuthoredGeometry {
  width: number
  height: number
}

/** Authored frame geometry for each requested page, defaulted exactly the way the live capture path defaults it. */
function authoredGeometry(dir: string, pageIds: readonly string[]): Map<string, AuthoredGeometry> {
  const boardsFile = readBoardsFileOrEmpty(dir)
  const byPageId = new Map<string, AuthoredGeometry>()
  for (const board of boardsFile.boards) {
    for (const frame of board.frames) {
      if (byPageId.has(frame.pageId)) continue
      byPageId.set(frame.pageId, { width: frame.width ?? FRAME_WIDTH, height: frame.height ?? FRAME_HEIGHT })
    }
  }
  const selected = new Map<string, AuthoredGeometry>()
  for (const pageId of pageIds) {
    selected.set(pageId, byPageId.get(pageId) ?? { width: FRAME_WIDTH, height: FRAME_HEIGHT })
  }
  return selected
}

function readyExpression(): string {
  // A string, not a closure: the driver runs in Bun and this runs in Chromium.
  return `Boolean(window.${AGENT_CAPTURE_GLOBAL}) && window.${AGENT_CAPTURE_GLOBAL}.status !== 'loading'`
}

/**
 * Bring one frame's PNG within the cap that actually applies to the REAL
 * captured size. The authored-geometry pre-clamp is usually exact; this only
 * bites when the rendered frame turned out taller than its authored height
 * (scroll-unroll), which the driver cannot know before it navigates.
 */
async function clampCapturedPng(
  png: Buffer,
  cssWidth: number,
  cssHeight: number,
  requestedRatio: number,
  purpose: CapturePurpose,
): Promise<{ png: Buffer; width: number; height: number }> {
  const meta = await sharp(png).metadata()
  const width = meta.width ?? Math.round(cssWidth * requestedRatio)
  const height = meta.height ?? Math.round(cssHeight * requestedRatio)
  const actualRatio = cssWidth > 0 ? width / cssWidth : 1
  const allowedRatio = effectiveCaptureRatio(cssWidth, cssHeight, actualRatio, purpose)
  if (allowedRatio >= actualRatio) return { png, width, height }

  const targetWidth = Math.max(1, Math.round(cssWidth * allowedRatio))
  const resized = await sharp(png).resize({ width: targetWidth }).png().toBuffer()
  const resizedMeta = await sharp(resized).metadata()
  return {
    png: resized,
    width: resizedMeta.width ?? targetWidth,
    height: resizedMeta.height ?? Math.round(cssHeight * allowedRatio),
  }
}

/**
 * Capture `pageIds` from `dir` headlessly, returning the SAME
 * `{ frames[], images[] }` shape `studio_export_frames` returns from the live
 * bridge — so `studio_screenshot` and `studio_compare` consume either source
 * without branching on which one answered.
 */
export async function captureFramesHeadless(
  input: HeadlessCaptureInput,
  overrides: HeadlessCaptureOverrides = {},
): Promise<HeadlessCaptureResult> {
  const purpose: CapturePurpose = input.purpose ?? 'vision'
  const geometry = authoredGeometry(input.dir, input.pageIds)

  // The density to RENDER at: the requested dpr, pre-clamped by what the
  // authored geometry already proves is allowed. Re-checked against the real
  // bytes in `clampCapturedPng`.
  let renderRatio = input.dpr && input.dpr > 0 ? input.dpr : 1
  let viewportWidth = FRAME_WIDTH
  let tallestFrame = MIN_VIEWPORT_HEIGHT
  for (const frame of geometry.values()) {
    renderRatio = Math.min(renderRatio, effectiveCaptureRatio(frame.width, frame.height, renderRatio, purpose))
    viewportWidth = Math.max(viewportWidth, frame.width)
    tallestFrame = Math.max(tallestFrame, frame.height)
  }
  const viewportHeight = Math.min(MAX_VIEWPORT_HEIGHT, tallestFrame)

  const token = mintCaptureToken({
    userId: input.userId,
    dir: input.dir,
    pageIds: input.pageIds,
    ...(input.axes ? { axes: input.axes } : {}),
  })
  const url = overrides.baseUrl
    ? `${overrides.baseUrl.replace(/\/$/, '')}/admin/agent-capture?token=${encodeURIComponent(token)}`
    : captureEntryUrl(token)

  try {
    return await withCapturePage(
      {
        viewport: { width: Math.round(viewportWidth), height: Math.round(viewportHeight) },
        deviceScaleFactor: renderRatio,
        ...(overrides.launchBrowser ? { launchBrowser: overrides.launchBrowser } : {}),
      },
      async (page) => runCapture(page, {
        url,
        geometry,
        purpose,
        renderRatio,
        navTimeoutMs: overrides.navTimeoutMs ?? NAV_TIMEOUT_MS,
        readyTimeoutMs: overrides.readyTimeoutMs ?? READY_TIMEOUT_MS,
      }),
    )
  } catch (err) {
    // The browser itself could not be launched or died. This is the case that
    // MUST degrade to the live bridge rather than fail the tool: a self-hosted
    // install with no Chromium available is a supported configuration.
    return {
      ok: false,
      code: 'headless-browser-unavailable',
      error: `The headless capture browser could not run: ${err instanceof Error ? err.message : String(err)}`,
    }
  } finally {
    // The real boundary — the token's minutes-long TTL is only the net.
    revokeCaptureToken(token)
  }
}

interface RunCaptureOptions {
  url: string
  geometry: Map<string, AuthoredGeometry>
  purpose: CapturePurpose
  renderRatio: number
  navTimeoutMs: number
  readyTimeoutMs: number
}

async function runCapture(page: CapturePage, options: RunCaptureOptions): Promise<HeadlessCaptureResult> {
  try {
    await page.goto(options.url, { waitUntil: 'load', timeout: options.navTimeoutMs })
  } catch (err) {
    return {
      ok: false,
      code: 'headless-navigation-failed',
      error: `Could not open the capture page at ${options.url}: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  try {
    await page.waitForFunction(readyExpression(), { timeout: options.readyTimeoutMs, polling: READY_POLL_MS })
  } catch {
    return {
      ok: false,
      code: 'headless-not-ready',
      error: `The capture page did not report every frame settled within ${options.readyTimeoutMs}ms.`,
    }
  }

  const raw = await page.evaluate(`JSON.stringify(window.${AGENT_CAPTURE_GLOBAL})`)
  if (typeof raw !== 'string') {
    return { ok: false, code: 'headless-invalid-report', error: 'The capture page returned no readiness report.' }
  }
  const parsed = safeParseJson(raw, AgentCaptureReportSchema)
  if (!parsed.ok) {
    return {
      ok: false,
      code: 'headless-invalid-report',
      error: `The capture page returned a readiness report this server could not validate: ${parsed.error}`,
    }
  }
  const report: AgentCaptureReport = parsed.value
  if (report.status === 'error') {
    return { ok: false, code: 'headless-page-error', error: report.error }
  }

  const images: AiToolImage[] = []
  const frames: Array<Record<string, unknown>> = []
  for (const frame of report.frames) {
    if (!frame.ok) {
      frames.push({ pageId: frame.pageId, ok: false, error: frame.error })
      continue
    }
    const selector = `[${AGENT_CAPTURE_FRAME_ATTR}="${cssAttrEscape(frame.pageId)}"]`
    const element = await page.$(selector)
    if (!element) {
      frames.push({ pageId: frame.pageId, ok: false, error: `The capture page reported "${frame.pageId}" ready but rendered no element for it.` })
      continue
    }
    let shot: Buffer
    try {
      shot = await element.screenshot({ type: 'png' })
    } catch (err) {
      frames.push({
        pageId: frame.pageId,
        ok: false,
        error: `Rasterising "${frame.pageId}" failed: ${err instanceof Error ? err.message : String(err)}`,
      })
      continue
    }

    const clamped = await clampCapturedPng(shot, frame.cssWidth, frame.cssHeight, options.renderRatio, options.purpose)
    const imageIndex = images.length
    images.push({ mimeType: 'image/png', data: clamped.png.toString('base64') })
    frames.push({
      pageId: frame.pageId,
      ok: true,
      width: clamped.width,
      height: clamped.height,
      imageIndex,
      nodeRects: frame.nodeRects,
      // Derived from the REAL captured width, never from the requested dpr —
      // the same rule the live path follows, for the same reason.
      imageScale: frame.cssWidth > 0 ? clamped.width / frame.cssWidth : 1,
      warnings: frame.warnings,
    })
  }

  return { ok: true, output: aiToolOk({ frames, source: 'headless' }, images) }
}

/** Escapes a page id for use inside a CSS attribute selector's double-quoted value. */
function cssAttrEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}
