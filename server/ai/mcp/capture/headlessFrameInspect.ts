/**
 * Ask a headlessly-rendered Studio frame a question about itself — the driver
 * half of `@core/studio-capture`'s `frameInspectWire.ts`.
 *
 * `headlessCapture.ts` answers "what does this screen look like" with pixels.
 * Two questions the agent asks constantly are not answerable in pixels at all:
 *
 *   - **What did the CSS actually resolve to?** A font-family naming a font the
 *     project never loaded renders as a fallback that is pixel-plausible and
 *     completely wrong, and no amount of squinting at a PNG reveals it.
 *   - **How big is that box, and how far is it from the next one?** A
 *     screenshot forces the agent to estimate spacing by eye, which is how a
 *     24px gap gets "fixed" to 24px.
 *
 * Both used to require the user's editor tab (`execution: 'browser'`, ~8s of
 * bridge timeout when none was open), for no reason that survives inspection:
 * the answer is a property of what is ON DISK, which is exactly what the
 * capture page renders. So they run here instead, on the same warm Chromium
 * and the same single-purpose grant every capture already uses, and fall back
 * to the live tab only when the headless browser genuinely cannot run.
 *
 * The read itself is not implemented here. It is `@core/studio-capture`'s
 * `inspectFrameDocument`, running INSIDE the page — the same function the live
 * canvas runs against its own iframe — so the headless answer and the live
 * fallback cannot disagree about what "the font size" means. All this module
 * does is settle the page, call the page's global with a JSON request, and
 * validate the JSON that comes back.
 */
import {
  AGENT_CAPTURE_INSPECT_GLOBAL,
  AgentFrameInspectResponseSchema,
  type AgentFrameInspectRequest,
  type AgentFrameInspectResult,
} from '@core/studio-capture'
import type { PreviewAxes } from '@core/studio-board'
import { safeParseJson } from '@core/utils/jsonValidate'
import type { CapturePage } from './browserPool'
import { rememberedLaunchFailure } from './browserPool'
import {
  authoredGeometry,
  captureViewport,
  withSettledCapture,
  type HeadlessCaptureFailure,
  type HeadlessCaptureOverrides,
} from './captureSession'

export interface HeadlessInspectInput {
  userId: string
  dir: string
  request: AgentFrameInspectRequest
  axes?: Partial<PreviewAxes>
}

export type HeadlessInspectResult =
  | { ok: true; result: AgentFrameInspectResult }
  | HeadlessCaptureFailure

/**
 * Render `request.pageId` headlessly and answer `request` against the settled
 * frame document.
 *
 * Rendered at `deviceScaleFactor: 1` deliberately. Every value this returns is
 * in CSS px — a font size, a padding, a gap — and CSS px do not change with
 * device pixel ratio, so paying for a 2x raster would buy nothing and cost the
 * memory of a screenshot nobody looks at.
 */
export async function inspectFrameHeadless(
  input: HeadlessInspectInput,
  overrides: HeadlessCaptureOverrides = {},
): Promise<HeadlessInspectResult> {
  const remembered = rememberedLaunchFailure()
  if (remembered) {
    // Skip a launch this process already knows will fail — see
    // `browserPool.ts`'s `LAUNCH_FAILURE_MEMO_MS`.
    return {
      ok: false,
      code: 'headless-browser-unavailable',
      error: `The headless capture browser could not run: ${remembered}`,
    }
  }

  const pageIds = [input.request.pageId]
  const session = await withSettledCapture(
    {
      userId: input.userId,
      dir: input.dir,
      pageIds,
      ...(input.axes ? { axes: input.axes } : {}),
      viewport: captureViewport(authoredGeometry(input.dir, pageIds)),
    },
    overrides,
    async (page, frames) => {
      const frame = frames.find((f) => f.pageId === input.request.pageId)
      if (!frame) {
        return {
          ok: false as const,
          code: 'headless-page-error' as const,
          error: `The capture page rendered no frame for "${input.request.pageId}" — the page was deleted or renamed after this call started.`,
        }
      }
      if (!frame.ok) {
        return { ok: false as const, code: 'headless-page-error' as const, error: frame.error }
      }
      return evaluateInspect(page, input.request)
    },
  )
  return session.ok ? session.value : session
}

async function evaluateInspect(
  page: CapturePage,
  request: AgentFrameInspectRequest,
): Promise<HeadlessInspectResult> {
  // The request crosses into Chromium as a JSON STRING inside a JS string
  // literal — `page.evaluate` takes an expression, not a value, and the page
  // validates what it receives with the same TypeBox schema this side used.
  const literal = JSON.stringify(JSON.stringify(request))
  let raw: unknown
  try {
    raw = await page.evaluate(`window.${AGENT_CAPTURE_INSPECT_GLOBAL}(${literal})`)
  } catch (err) {
    return {
      ok: false,
      code: 'headless-inspect-failed',
      error: `The capture page could not answer the ${request.kind} request: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  if (typeof raw !== 'string') {
    return {
      ok: false,
      code: 'headless-inspect-failed',
      error: `The capture page returned no ${request.kind} response (its inspect global is missing or returned a non-string).`,
    }
  }
  const parsed = safeParseJson(raw, AgentFrameInspectResponseSchema)
  if (!parsed.ok) {
    return {
      ok: false,
      code: 'headless-inspect-failed',
      error: `The capture page returned a ${request.kind} response this server could not validate: ${parsed.error}`,
    }
  }
  if (!parsed.value.ok) {
    return { ok: false, code: 'headless-inspect-failed', error: parsed.value.error }
  }
  return { ok: true, result: parsed.value.result }
}
