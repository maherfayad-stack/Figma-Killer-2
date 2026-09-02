/**
 * canvasCaptureSettle — small DOM-settle primitives shared by every
 * deterministic canvas capture path.
 *
 * Extracted out of `AgentSnapshotFrame.tsx` (the CMS breakpoint capture used
 * by `site_render_snapshot`) so `studioExportFrames.ts` (WS-9.2's
 * `studio_export_frames`, which captures an already-mounted, VISIBLE board
 * frame rather than an offscreen transient one) can wait on the same
 * "DOM stopped mutating" / "a promise settled" primitives instead of
 * duplicating them. Neither function knows anything about breakpoints, agent
 * snapshots, or Studio — they are generic, abortable waits over a `Document`
 * or a `Promise`.
 */

/** Quiet window (ms) with no DOM mutation before a document is considered settled. */
export const DOM_QUIET_MS = 32

/**
 * Resolves once `iframeDocument` has gone `DOM_QUIET_MS` with no
 * attribute/characterData/childList mutation anywhere in the subtree, or
 * resolves `false` immediately if `signal` is already aborted / aborts while
 * waiting.
 */
export function waitForDocumentQuiet(
  iframeDocument: Document,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  const MutationObserverCtor = iframeDocument.defaultView?.MutationObserver ?? MutationObserver

  return new Promise<boolean>((resolve) => {
    let finished = false
    let quietTimer: ReturnType<typeof setTimeout> | undefined
    const observer = new MutationObserverCtor(() => scheduleQuietWindow())
    const finish = (settled: boolean) => {
      if (finished) return
      finished = true
      if (quietTimer !== undefined) clearTimeout(quietTimer)
      observer.disconnect()
      signal.removeEventListener('abort', onAbort)
      resolve(settled)
    }
    const onAbort = () => finish(false)
    const scheduleQuietWindow = () => {
      if (finished) return
      if (quietTimer !== undefined) clearTimeout(quietTimer)
      quietTimer = setTimeout(() => finish(true), DOM_QUIET_MS)
    }

    observer.observe(iframeDocument.documentElement, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    })
    signal.addEventListener('abort', onAbort, { once: true })
    scheduleQuietWindow()
  })
}

/** Resolves `true` once `promise` settles (either way), or `false` if aborted first. */
export function waitForPromise(promise: Promise<unknown>, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise<boolean>((resolve) => {
    let finished = false
    const finish = (settled: boolean) => {
      if (finished) return
      finished = true
      signal.removeEventListener('abort', onAbort)
      resolve(settled)
    }
    const onAbort = () => finish(false)
    signal.addEventListener('abort', onAbort, { once: true })
    void promise.then(() => finish(true), () => finish(true))
  })
}

/** Resolves `true` after `delayMs`, or `false` if aborted first. */
export function waitForDelay(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise<boolean>((resolve) => {
    let finished = false
    const timer = setTimeout(() => finish(true), delayMs)
    const finish = (settled: boolean) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve(settled)
    }
    const onAbort = () => finish(false)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
