/**
 * One settled capture page, handed to whoever wants to ask it something.
 *
 * Three tools now need the identical five steps — mint a single-purpose grant,
 * open a page on the warm Chromium, navigate to `/admin/agent-capture?token=…`,
 * wait for the page's own deterministic readiness signal, validate the report —
 * and then diverge only in what they do with the settled frames:
 *
 *   - `headlessCapture.ts` rasterises each frame element (`studio_screenshot`,
 *     `studio_export_frames`, `studio_compare`),
 *   - `headlessFrameInspect.ts` asks the frame a question instead
 *     (`studio_computed_styles`, `studio_measure_element`).
 *
 * Those five steps were `headlessCapture.ts`'s private middle; a second copy in
 * the inspect driver would have been a second place for the token to leak, the
 * ready expression to drift, and the failure vocabulary to fork. So they live
 * here, and the failure enum lives here with them — a caller that falls back to
 * the live editor bridge has to be able to say WHICH half broke, and that is
 * only true if there is one enum.
 *
 * The `finally` that revokes the token is the real security boundary; the
 * grant's minutes-long TTL is only the net.
 */
import { safeParseJson } from '@core/utils/jsonValidate'
import { FRAME_WIDTH, FRAME_HEIGHT, type PreviewAxes } from '@core/studio-board'
import {
  AGENT_CAPTURE_GLOBAL,
  AgentCaptureReportSchema,
  type AgentCaptureFrameReport,
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
  | 'headless-inspect-failed'

export interface HeadlessCaptureFailure {
  ok: false
  code: HeadlessCaptureFailureCode
  error: string
}

export interface AuthoredGeometry {
  width: number
  height: number
}

/** Authored frame geometry for each requested page, defaulted exactly the way the live capture path defaults it. */
export function authoredGeometry(dir: string, pageIds: readonly string[]): Map<string, AuthoredGeometry> {
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

/** The viewport that fits every requested frame, clamped so one very tall screen cannot ask for an unbounded surface. */
export function captureViewport(geometry: Map<string, AuthoredGeometry>): { width: number; height: number } {
  let width = FRAME_WIDTH
  let tallest = MIN_VIEWPORT_HEIGHT
  for (const frame of geometry.values()) {
    width = Math.max(width, frame.width)
    tallest = Math.max(tallest, frame.height)
  }
  return { width: Math.round(width), height: Math.round(Math.min(MAX_VIEWPORT_HEIGHT, tallest)) }
}

export interface CaptureSessionInput {
  userId: string
  dir: string
  pageIds: readonly string[]
  axes?: Partial<PreviewAxes>
  viewport: { width: number; height: number }
  deviceScaleFactor?: number
}

export type CaptureSessionResult<T> = { ok: true; value: T } | HeadlessCaptureFailure

function readyExpression(): string {
  // A string, not a closure: the driver runs in Bun and this runs in Chromium.
  return `Boolean(window.${AGENT_CAPTURE_GLOBAL}) && window.${AGENT_CAPTURE_GLOBAL}.status !== 'loading'`
}

/**
 * Open the capture page for `pageIds`, wait until every frame has settled or
 * failed, then hand the live page and the validated per-frame reports to `run`.
 *
 * `run`'s own return value is passed through untouched — this function owns the
 * browser, the grant and the wire validation, and nothing else. A frame that
 * failed to render is an `ok: false` ENTRY in `frames`, not a failure of the
 * session: one broken screen in a batch of five must still let the other four
 * be used.
 */
export async function withSettledCapture<T>(
  input: CaptureSessionInput,
  overrides: HeadlessCaptureOverrides,
  run: (page: CapturePage, frames: readonly AgentCaptureFrameReport[]) => Promise<T>,
): Promise<CaptureSessionResult<T>> {
  const token = mintCaptureToken({
    userId: input.userId,
    dir: input.dir,
    pageIds: input.pageIds,
    ...(input.axes ? { axes: input.axes } : {}),
  })
  const url = overrides.baseUrl
    ? `${overrides.baseUrl.replace(/\/$/, '')}/admin/agent-capture?token=${encodeURIComponent(token)}`
    : captureEntryUrl(token)
  const navTimeoutMs = overrides.navTimeoutMs ?? NAV_TIMEOUT_MS
  const readyTimeoutMs = overrides.readyTimeoutMs ?? READY_TIMEOUT_MS

  try {
    return await withCapturePage(
      {
        viewport: input.viewport,
        ...(input.deviceScaleFactor === undefined ? {} : { deviceScaleFactor: input.deviceScaleFactor }),
        ...(overrides.launchBrowser ? { launchBrowser: overrides.launchBrowser } : {}),
      },
      async (page) => {
        try {
          await page.goto(url, { waitUntil: 'load', timeout: navTimeoutMs })
        } catch (err) {
          return {
            ok: false,
            code: 'headless-navigation-failed',
            error: `Could not open the capture page at ${url}: ${err instanceof Error ? err.message : String(err)}`,
          }
        }

        try {
          await page.waitForFunction(readyExpression(), { timeout: readyTimeoutMs, polling: READY_POLL_MS })
        } catch {
          return {
            ok: false,
            code: 'headless-not-ready',
            error: `The capture page did not report every frame settled within ${readyTimeoutMs}ms.`,
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
        if (parsed.value.status === 'error') {
          return { ok: false, code: 'headless-page-error', error: parsed.value.error }
        }

        return { ok: true, value: await run(page, parsed.value.frames) }
      },
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
