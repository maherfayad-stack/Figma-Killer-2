/**
 * The capture page's readiness bookkeeping — the browser half of the contract
 * in `@core/studio-capture`.
 *
 * The server driver polls ONE expression (`window.__studioAgentCapture.status
 * !== 'loading'`) and then reads the whole report in one `evaluate`. So the
 * page needs a place to accumulate per-frame results and a single point that
 * flips the status once every requested frame has either settled or failed.
 * That is this module: a tiny mutable registry with no React in it, so a
 * frame's settle callback can publish from inside an effect without a re-render
 * and without the driver ever observing a half-written array.
 *
 * The status only ever goes `loading` → `ready`/`error`, once. A frame that
 * fails is a `ok: false` ENTRY, not a failed report — one broken screen in a
 * batch of five must still let the other four be measured, exactly as the
 * live-bridge path already behaves.
 */
import {
  AGENT_CAPTURE_GLOBAL,
  type AgentCaptureFrameReport,
  type AgentCaptureReport,
} from '@core/studio-capture'

interface CaptureWindow {
  [AGENT_CAPTURE_GLOBAL]?: AgentCaptureReport | { status: 'loading' }
}

function publish(report: AgentCaptureReport | { status: 'loading' }): void {
  ;(window as unknown as CaptureWindow)[AGENT_CAPTURE_GLOBAL] = report
}

/**
 * A run over a known set of page ids. Created once the payload lands, so the
 * expected count is known before any frame reports — a report can never be
 * declared ready because the frames simply had not mounted yet.
 */
export function createCaptureRun(pageIds: readonly string[]) {
  const results = new Map<string, AgentCaptureFrameReport>()
  const expected = new Set(pageIds)
  let settled = false

  const maybeFinish = (): void => {
    if (settled || results.size < expected.size) return
    settled = true
    // Report in the order the driver requested, not the order frames happened
    // to settle — the caller's `pageIds` is the order everything downstream
    // (image indices included) is keyed by.
    publish({ status: 'ready', frames: pageIds.map((id) => results.get(id)!) })
  }

  return {
    report(frame: AgentCaptureFrameReport): void {
      if (settled || !expected.has(frame.pageId) || results.has(frame.pageId)) return
      results.set(frame.pageId, frame)
      maybeFinish()
    },
    /** A failure that makes the whole page useless — no payload, no store, no frames to try. */
    fail(error: string): void {
      if (settled) return
      settled = true
      publish({ status: 'error', error })
    },
  }
}

export type CaptureRun = ReturnType<typeof createCaptureRun>

/** Called once at module load so the driver's poll always sees a defined global. */
export function markCaptureLoading(): void {
  publish({ status: 'loading' })
}

/** A failure before any run exists (bad token, unreachable payload endpoint). */
export function publishCaptureError(error: string): void {
  publish({ status: 'error', error })
}
