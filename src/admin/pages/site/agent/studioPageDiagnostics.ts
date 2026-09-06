/**
 * `studio_page_diagnostics` — the browser half.
 *
 * Drains what `CanvasDiagnosticsInjector` collected inside each requested
 * board frame's iframe and returns it as findings. Nothing is computed here
 * that was not already observed: this is a read of a buffer, so it cannot
 * fabricate a problem and cannot miss one that happened before it was called.
 *
 * ## The three answers, kept distinct
 *
 * A page comes back as exactly one of:
 *
 *   - `frame: 'missing'`   — no board frame is mounted for that page id. The
 *                            page may be perfectly fine; nothing was watched.
 *   - `collector: 'absent'`— a frame exists but has no collector installed
 *                            (a frame mid-mount, or an older document). Also
 *                            not evidence of health.
 *   - findings (possibly empty) — a real answer.
 *
 * Collapsing the first two into "no findings" would let a broken page report
 * clean, which is the exact failure mode this tool exists to remove.
 *
 * Reads the iframe's `contentWindow`, not the host element: every board frame
 * renders its page inside its own iframe (`IframeFrameSurface`), so the
 * runtime that threw is the iframe's, and the buffer is keyed by that window.
 */
import { parseValue } from '@core/utils/typeboxHelpers'
import { StudioPageDiagnosticsInputSchema, aiToolOk } from '@core/ai'
import type { AiToolOutput } from '@core/ai'
import { readFrameDiagnostics, type CanvasDiagnosticEntry } from '../canvas/canvasDiagnosticsBuffer'
import { findAgentRenderFrame } from './renderEvidence'

const DEFAULT_LIMIT = 25
const STUDIO_BREAKPOINT_ID = 'studio'

/** One page's answer. Discriminated by `status` so a caller cannot read "watched and clean" out of "never watched". */
interface PageDiagnosticsResult {
  pageId: string
  status: 'ok' | 'no-frame' | 'no-collector'
  /** Present on `status: 'ok'`. Epoch ms the frame's collector was installed — the "since" of "since load". */
  since?: number
  findings?: CanvasDiagnosticEntry[]
  /** Distinct findings beyond `limit`, and distinct problems the frame buffer itself had to drop. */
  truncated?: number
  droppedDistinct?: number
  note?: string
}

function frameWindowFor(pageId: string): Window | null {
  const frame = findAgentRenderFrame({ breakpointId: STUDIO_BREAKPOINT_ID, pageId })
  if (!frame) return null
  const iframe = frame.querySelector('iframe')
  return iframe?.contentWindow ?? null
}

/**
 * Errors first, then by how often each happened. A weaker model reads the top
 * of a list and acts on it, so the entry most likely to explain a blank frame
 * has to BE the top of the list — not wherever it happened to land in
 * insertion order.
 */
function severityRank(entry: CanvasDiagnosticEntry): number {
  return entry.code === 'runtime-console-error' || entry.code === 'network-request-failed' ? 1 : 0
}

export function runStudioPageDiagnostics(rawInput: unknown): AiToolOutput {
  const input = parseValue(StudioPageDiagnosticsInputSchema, rawInput)
  const limit = input.limit ?? DEFAULT_LIMIT

  const pages: PageDiagnosticsResult[] = input.pageIds.map((pageId) => {
    const view = frameWindowFor(pageId)
    if (!view) {
      return {
        pageId,
        status: 'no-frame',
        note: `No live board frame for "${pageId}", so nothing was watched — this is NOT a clean result. Open the project in a Studio tab (studio_screenshot places a frame for every page file), then call this again.`,
      }
    }
    const snapshot = readFrameDiagnostics(view)
    if (!snapshot) {
      return {
        pageId,
        status: 'no-collector',
        note: 'The frame exists but its diagnostics collector is not installed yet (the frame is still mounting). Take a screenshot to force the frame to settle, then call this again.',
      }
    }
    const sorted = [...snapshot.entries].sort(
      (a, b) => severityRank(a) - severityRank(b) || b.count - a.count || a.firstAt - b.firstAt,
    )
    return {
      pageId,
      status: 'ok',
      since: snapshot.installedAt,
      findings: sorted.slice(0, limit),
      ...(sorted.length > limit ? { truncated: sorted.length - limit } : {}),
      ...(snapshot.droppedDistinct > 0 ? { droppedDistinct: snapshot.droppedDistinct } : {}),
    }
  })

  return aiToolOk({ pages })
}
