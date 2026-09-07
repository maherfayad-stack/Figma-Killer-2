/**
 * The one place that decides HOW a set of Studio frames gets photographed.
 *
 * `studio_screenshot`, `studio_export_frames` and `studio_compare` all need
 * the same thing — "give me PNGs of these pages" — and all three used to get
 * it the same way: relay to the user's open editor tab and hope one is open.
 * That made every visual verification hostage to a browser tab, cost a canvas
 * pan + frame mount + settle wait per call, and visibly hijacked the viewport
 * of whoever happened to be editing.
 *
 * Now there are two paths and this module picks between them:
 *
 *   - **Headless (default).** A server-side Chromium renders Studio's own
 *     parse output at `/admin/agent-capture` and rasterises each frame. Works
 *     with no editor tab open, disturbs nothing if one IS open, and is the
 *     right answer for every question answered by what is ON DISK — which is
 *     every question these three tools ask, because the agent's own edits go
 *     to disk before it looks at them.
 *
 *   - **Live bridge (fallback, and authoritative for live-only state).** The
 *     original path: relay `studio_export_frames` to the connector owner's
 *     open Site workspace. It remains the ONLY way to see things that exist
 *     nowhere but that tab — a selection the user made, an in-progress edit
 *     that has not been saved yet, a board the user has panned or re-framed
 *     but not persisted. It is also the automatic fallback whenever headless
 *     cannot run (no Chromium on the host, a capture page that will not
 *     settle), so an install without a browser degrades to exactly today's
 *     behaviour instead of losing the tool.
 *
 * ## Failure honesty
 *
 * When both paths fail, the error names BOTH reasons. The old message —
 * "No Studio board is connected" — was the single answer to every possible
 * failure, and it sent an agent (and a user) to open a tab that was already
 * open when the real cause was a browser that would not launch. A caller that
 * gets `capture-unavailable` back can read exactly which half broke and why.
 */
import { aiToolError, type AiToolOutput, type CapturePurpose } from '@core/ai'
import type { PreviewAxes } from '@core/studio-board'
import type { AiBrowserBridge } from '../../runtime/types'
import { awaitEditorBridgeForUser, editorBridgeScope } from '../editorBridge'
import { rememberedLaunchFailure } from './browserPool'
import { captureFramesHeadless, type HeadlessCaptureFailure, type HeadlessCaptureOverrides } from './headlessCapture'

/** Which path a caller wants. `auto` is headless-first with the bridge as fallback. */
export type CaptureSource = 'auto' | 'headless' | 'live'

export interface CaptureFramesRequest {
  userId: string
  dir: string
  pageIds: readonly string[]
  dpr?: number
  purpose?: CapturePurpose
  axes?: Partial<PreviewAxes>
  source?: CaptureSource
  signal?: AbortSignal
}

export interface CaptureFramesOutcome {
  /** The tool output, in `studio_export_frames`' shape whichever path produced it. */
  output: AiToolOutput
  /** Which path answered — surfaced to callers so a result can say how it was taken. */
  source: 'headless' | 'live' | 'none'
  /** Present when headless was tried and failed, even if the bridge then succeeded. */
  headlessFailure?: HeadlessCaptureFailure
}

export interface CaptureFramesOverrides extends HeadlessCaptureOverrides {
  /** Test seam: stand in for `awaitEditorBridgeForUser`. */
  awaitBridge?: (userId: string, signal?: AbortSignal) => Promise<AiBrowserBridge | null>
}

/** Relay to the open editor tab — the original capture path, unchanged. */
async function captureViaBridge(
  bridge: AiBrowserBridge,
  request: CaptureFramesRequest,
): Promise<AiToolOutput> {
  return bridge.callBrowser('studio_export_frames', {
    pageIds: [...request.pageIds],
    ...(request.dpr === undefined ? {} : { dpr: request.dpr }),
    ...(request.purpose === undefined ? {} : { purpose: request.purpose }),
    ...(request.axes === undefined ? {} : { axes: request.axes }),
  })
}

export async function captureFrames(
  request: CaptureFramesRequest,
  overrides: CaptureFramesOverrides = {},
): Promise<CaptureFramesOutcome> {
  const source = request.source ?? 'auto'
  // Scoped to the project being captured (W10): a live capture must come from
  // the tab showing THIS project, never from whichever tab registered last.
  const awaitBridge = overrides.awaitBridge
    ?? ((userId: string, signal?: AbortSignal) =>
      awaitEditorBridgeForUser(userId, editorBridgeScope(request.dir), signal))

  // The caller explicitly wants the live tab (selection, unsaved edits).
  if (source === 'live') {
    const bridge = await awaitBridge(request.userId, request.signal)
    if (!bridge) {
      return {
        source: 'none',
        output: aiToolError(
          'This capture was requested from the LIVE editor tab (source: "live"), and no Studio board is connected. Open the project in a Studio browser tab, or drop `source` to let this capture run headlessly against what is on disk.',
        ),
      }
    }
    return { source: 'live', output: await captureViaBridge(bridge, request) }
  }

  let headlessFailure: HeadlessCaptureFailure | undefined
  if (source === 'headless' || source === 'auto') {
    const remembered = rememberedLaunchFailure()
    if (remembered) {
      // Skip a launch this process already knows will fail — see
      // `browserPool.ts`'s `LAUNCH_FAILURE_MEMO_MS`.
      headlessFailure = {
        ok: false,
        code: 'headless-browser-unavailable',
        error: `The headless capture browser could not run: ${remembered}`,
      }
    } else {
      const headless = await captureFramesHeadless(
        {
          userId: request.userId,
          dir: request.dir,
          pageIds: request.pageIds,
          ...(request.dpr === undefined ? {} : { dpr: request.dpr }),
          ...(request.purpose === undefined ? {} : { purpose: request.purpose }),
          ...(request.axes === undefined ? {} : { axes: request.axes }),
        },
        overrides,
      )
      if (headless.ok) return { source: 'headless', output: headless.output }
      headlessFailure = headless
      console.error(`[studio-capture] headless capture failed (${headless.code}): ${headless.error}`)
    }
  }

  if (source === 'headless') {
    return {
      source: 'none',
      headlessFailure,
      output: aiToolError(
        `Headless capture failed and \`source: "headless"\` ruled out the live editor tab. ${headlessFailure?.error ?? 'No reason was reported.'}`,
      ),
    }
  }

  // `auto` — fall back to the live tab.
  const bridge = await awaitBridge(request.userId, request.signal)
  if (bridge) {
    return { source: 'live', headlessFailure, output: await captureViaBridge(bridge, request) }
  }

  return {
    source: 'none',
    headlessFailure,
    output: aiToolError(
      // Names BOTH halves — see module doc on failure honesty.
      `capture-unavailable: neither capture path could produce an image of these screens. Headless capture: ${headlessFailure?.error ?? 'not attempted.'} Live editor tab: no Studio board is connected (open the project in a Studio browser tab, or make the headless path work — it needs a Chromium available to playwright-core, installed with \`bunx playwright install chromium\`).`,
    ),
  }
}
