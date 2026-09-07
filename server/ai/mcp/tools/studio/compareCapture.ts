/**
 * compareCapture — `studio_compare`'s capture half: turn a list of cache-miss
 * pages into their captured frames, in as few browser round trips as it can.
 *
 * Split out of `compare.ts` (W9-2) alongside `compareGrading.ts`, on the same
 * line: this module answers "get me the pixels", grading answers "did they
 * clear the bar", and `compare.ts` is left owning the orchestration — cache
 * lookup, per-page loop, payload assembly. None of the three needs to know how
 * the other two work.
 */
import type { AiToolOutput } from '@core/ai'
import { captureFrames } from '../../capture/captureFrames'
import type { NodeRect } from './frameDiffEngine'

export interface CapturedFrame {
  ok: boolean
  pageId: string
  width?: number
  height?: number
  imageIndex?: number
  nodeRects?: NodeRect[]
  /** See `compare.ts`'s previous single-page revision / `computeFrameDiff`'s `nodeRects.imageScale` doc for why this has no default. */
  imageScale?: number
  error?: string
}

/** One page's capture, or the reason there is none. Keyed by page id by the caller. */
export type PageCapture =
  | { ok: true; frame: CapturedFrame; images: AiToolOutput['images'] }
  | { ok: false; error: string }

/**
 * Capture every cache-miss page, in as few browser round trips as possible.
 *
 * `studio_export_frames` has always taken `pageIds[]` and captured the batch
 * behind one bridge call; this tool was still asking for one page at a time
 * inside its per-page loop, so a five-screen verification paid five sequential
 * bridge round trips — each one a canvas pan, a frame mount, a settle wait and
 * a rasterise — when it could have paid one. That was the difference between
 * roughly a minute and roughly fifteen seconds on the loop the system prompt
 * tells the agent to run after every fix pass.
 *
 * Grouped by dpr rather than sent as a single call because the dpr is exactly
 * what makes a diff EXACT rather than resampled (`captureDprFor`), and one
 * capture call applies one dpr to its whole batch. In the ordinary case —
 * screens of one size measured against references of one size — every page
 * shares a dpr and this is a single call.
 *
 * W4-2A — routed through `capture/captureFrames.ts` rather than straight at
 * the editor bridge, so a measurement runs headlessly by default. That is not
 * merely a latency win: a comparison against a design reference is a question
 * about what is ON DISK, and answering it used to require a browser tab whose
 * viewport it then hijacked. The live bridge remains the automatic fallback.
 */
export async function captureMissedPages(
  userId: string,
  dir: string,
  targets: readonly { pageId: string; dpr: number | null }[],
  signal: AbortSignal | undefined,
): Promise<{ captures: Map<string, PageCapture>; source: 'headless' | 'live' | 'none' }> {
  const byDpr = new Map<number | null, string[]>()
  for (const target of targets) {
    const group = byDpr.get(target.dpr)
    if (group) group.push(target.pageId)
    else byDpr.set(target.dpr, [target.pageId])
  }

  const captures = new Map<string, PageCapture>()
  let source: 'headless' | 'live' | 'none' = 'none'
  for (const [dpr, pageIds] of byDpr) {
    const captured = await captureFrames({
      userId,
      dir,
      pageIds,
      ...(dpr === null ? {} : { dpr }),
      // This capture is measured server-side with pixelmatch, not shown to
      // the model by default — the vision-safe ~1568px edge clamp exists for
      // a reason that does not apply here (A2). Model visibility is decided
      // separately by `includeImages`.
      purpose: 'measurement',
      ...(signal ? { signal } : {}),
    })
    if (captured.source !== 'none') source = captured.source
    if (!captured.output.ok) {
      // A transport-level failure is the whole group's failure, but never the
      // whole call's: pages in another dpr group, and every cache hit, stand.
      const error = captured.output.error ?? 'The capture request failed.'
      for (const pageId of pageIds) captures.set(pageId, { ok: false, error })
      continue
    }
    const frames = (captured.output.data as { frames?: CapturedFrame[] } | null)?.frames ?? []
    for (const frame of frames) {
      captures.set(frame.pageId, { ok: true, frame, images: captured.output.images })
    }
  }
  return { captures, source }
}
