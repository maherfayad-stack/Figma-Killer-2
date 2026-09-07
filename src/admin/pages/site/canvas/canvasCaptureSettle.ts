/**
 * canvasCaptureSettle — the one answer to "is this screen finished rendering?",
 * shared by every deterministic canvas capture path.
 *
 * Extracted out of `AgentSnapshotFrame.tsx` (the CMS breakpoint capture used
 * by `site_render_snapshot`) so `studioExportFrames.ts` (the live-bridge
 * `studio_export_frames`) and `CaptureFrame.tsx` (the headless
 * `/admin/agent-capture` page) wait on the same primitives instead of keeping
 * three copies of the same loop. All three used to hand-roll the state machine
 * and all three carried the same defect, so the machine itself
 * (`settleCaptureDocument`) now lives here with them.
 *
 * ## A resource that will never load has ALREADY settled
 *
 * The original loop treated "not finished" and "will never finish" as the same
 * state, and answered both by waiting until a 20 s abort fired and then
 * reporting the frame as a FAILED capture:
 *
 *     "onboarding" did not finish rendering within 20000ms — its preview data,
 *     fonts, or images never settled.
 *
 * That message is wrong twice over. It names three phases without saying which
 * one stalled, and — much worse — it refuses to hand back an image of a screen
 * that is sitting right there on the canvas, fully painted. A `<img>` whose
 * `src` 404s, a `@font-face` whose file is missing, and a document that keeps
 * mutating are all states where **the pixels are not going to change again**,
 * or are going to keep changing forever; in both cases the honest answer is the
 * photograph plus a named warning, not a refusal.
 *
 * So every phase here is BOUNDED and every bound degrades to a warning:
 *
 *   - **Images.** An `<img>` counts as settled the moment it is `complete` —
 *     which Chromium sets for a 404 exactly as it does for a successful load
 *     (verified: a 404 and an unroutable host both report `complete: true,
 *     naturalWidth: 0` after `load`). One that is still in flight gets
 *     `IMAGE_SETTLE_BUDGET_MS`, and `error` counts as settled the same as
 *     `load`. Broken images are COUNTED and reported ("2 images failed to
 *     load"), never waited on twice.
 *   - **Fonts.** `document.fonts.ready` is raced against
 *     `FONT_SETTLE_BUDGET_MS`. A `@font-face` pointing at a file that never
 *     answers cannot stall the capture past that.
 *   - **DOM quiet.** A document that is still mutating when
 *     `DOM_QUIET_BUDGET_MS` expires is captured mid-flight with a warning
 *     rather than refused — a screen that never stops changing has no "after"
 *     to wait for.
 *   - **Preview data.** The `CanvasPreviewReadiness` barrier gets whatever is
 *     left of the overall deadline.
 *   - **Module registration.** A project's own design-system components
 *     (`pkg.*`) register asynchronously — the bundle is fetched, then
 *     `import()`ed, then `registry.registerOrReplace`d. A one-shot renderer
 *     that photographs before that lands captures the placeholder instead of
 *     the component, which is precisely the PNG-export defect this phase
 *     exists to close. It runs FIRST (nothing else is worth waiting for if the
 *     renderers themselves are missing) and is bounded by
 *     `MODULE_REGISTRATION_BUDGET_MS`, degrading — like every other phase — to
 *     a NAMED warning rather than a refusal, because a package that will never
 *     bundle has already reached its final pixels. Callers with nothing to
 *     wait on (the editor's own visible frames, whose modules registered long
 *     ago) simply omit the option.
 *
 * The overall `timeoutMs` stays as the outer bound, and `stalledPhase` names
 * which half of the loop was still in flight when it hit — so the next time a
 * capture comes back slow, the report says `dom-quiet` or `images` instead of
 * listing all three and shrugging.
 *
 * ## What is NOT waited on, deliberately
 *
 * CSS `background-image` and `<img>` elements inside a cross-origin child
 * frame are invisible to this document's `img` query, so they are not tracked. Neither
 * can stall the capture (nothing waits on them), and both are covered by the
 * DOM-quiet pass once they paint.
 */

import type { CanvasPreviewReadiness } from './CanvasPreviewReadiness'

/** Quiet window (ms) with no DOM mutation before a document is considered settled. */
export const DOM_QUIET_MS = 32

/**
 * The outer bound on one document's whole settle. A capture that has not
 * reached a resting state by here is photographed anyway, with a warning that
 * names the phase that was still running.
 */
export const CAPTURE_SETTLE_TIMEOUT_MS = 20_000

/** Per-phase bounds, each well inside `CAPTURE_SETTLE_TIMEOUT_MS`. See the module doc. */
export const DOM_QUIET_BUDGET_MS = 5_000
/**
 * Longer than the resource budgets on purpose: this one covers a cold
 * `component-bundle` round trip (a real `Bun.build` subprocess on the server,
 * not a cache hit) plus the `import()` of its output. Still comfortably inside
 * `CAPTURE_SETTLE_TIMEOUT_MS`, and still only a warning when it expires.
 */
export const MODULE_REGISTRATION_BUDGET_MS = 10_000
export const FONT_SETTLE_BUDGET_MS = 5_000
export const IMAGE_SETTLE_BUDGET_MS = 5_000

/**
 * How a bounded wait ended.
 *
 *   - `ok`      — the thing being waited on reached its resting state.
 *   - `timeout` — the budget expired; the caller degrades to a warning.
 *   - `aborted` — the CALLER's signal fired (unmount, cancellation). Not a
 *                 capture result at all, and never turned into a warning.
 */
export type WaitOutcome = 'ok' | 'timeout' | 'aborted'

/**
 * Resolves `ok` once `iframeDocument` has gone `DOM_QUIET_MS` with no
 * attribute/characterData/childList mutation anywhere in the subtree.
 *
 * `timeoutMs` bounds the wait: a document that never stops mutating resolves
 * `timeout` instead of hanging until the caller's abort. Omit it only when the
 * caller owns its own deadline through `signal`.
 */
export function waitForDocumentQuiet(
  iframeDocument: Document,
  signal: AbortSignal,
  timeoutMs?: number,
): Promise<WaitOutcome> {
  if (signal.aborted) return Promise.resolve('aborted')
  const MutationObserverCtor = iframeDocument.defaultView?.MutationObserver ?? MutationObserver

  return new Promise<WaitOutcome>((resolve) => {
    let finished = false
    let quietTimer: ReturnType<typeof setTimeout> | undefined
    let budgetTimer: ReturnType<typeof setTimeout> | undefined
    const observer = new MutationObserverCtor(() => scheduleQuietWindow())
    const finish = (outcome: WaitOutcome) => {
      if (finished) return
      finished = true
      if (quietTimer !== undefined) clearTimeout(quietTimer)
      if (budgetTimer !== undefined) clearTimeout(budgetTimer)
      observer.disconnect()
      signal.removeEventListener('abort', onAbort)
      resolve(outcome)
    }
    const onAbort = () => finish('aborted')
    const scheduleQuietWindow = () => {
      if (finished) return
      if (quietTimer !== undefined) clearTimeout(quietTimer)
      quietTimer = setTimeout(() => finish('ok'), DOM_QUIET_MS)
    }

    observer.observe(iframeDocument.documentElement, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    })
    signal.addEventListener('abort', onAbort, { once: true })
    if (timeoutMs !== undefined) budgetTimer = setTimeout(() => finish('timeout'), timeoutMs)
    scheduleQuietWindow()
  })
}

/**
 * Resolves `ok` once `promise` settles EITHER WAY — a rejected preview request
 * has finished changing the screen exactly as a resolved one has.
 */
export function waitForPromise(
  promise: Promise<unknown>,
  signal: AbortSignal,
  timeoutMs?: number,
): Promise<WaitOutcome> {
  if (signal.aborted) return Promise.resolve('aborted')
  return new Promise<WaitOutcome>((resolve) => {
    let finished = false
    let budgetTimer: ReturnType<typeof setTimeout> | undefined
    const finish = (outcome: WaitOutcome) => {
      if (finished) return
      finished = true
      if (budgetTimer !== undefined) clearTimeout(budgetTimer)
      signal.removeEventListener('abort', onAbort)
      resolve(outcome)
    }
    const onAbort = () => finish('aborted')
    signal.addEventListener('abort', onAbort, { once: true })
    if (timeoutMs !== undefined) budgetTimer = setTimeout(() => finish('timeout'), timeoutMs)
    void promise.then(() => finish('ok'), () => finish('ok'))
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

export interface ImageSettleResult {
  outcome: WaitOutcome
  /** `<img>` elements that finished but produced no pixels — a 404, a blocked host, a corrupt file. */
  failed: number
  /** `<img>` elements still in flight when the budget expired. */
  stillLoading: number
}

/**
 * True when this `<img>` has finished, successfully or not.
 *
 * `complete` is the whole test, and it is deliberately the whole test: the DOM
 * spec sets it once fetching has ended, so a 404 and a good PNG are both
 * `complete: true`. An image with no `src` at all is also complete and is not
 * waiting for anything. Treating "errored" as "still loading" — which is what
 * `naturalWidth > 0` would do — is exactly the bug that made a broken asset
 * hang a whole export.
 */
function imageHasFinished(image: HTMLImageElement): boolean {
  return image.complete
}

/** An image that finished but rendered nothing. Counted for the warning, never waited on. */
function imageFailed(image: HTMLImageElement): boolean {
  return image.complete && image.naturalWidth === 0 && image.getAttribute('src') !== null
}

/**
 * Wait until every `<img>` in `iframeDocument` has finished loading OR failed,
 * bounded by `timeoutMs`.
 *
 * A failure is a RESULT, not a stall: the reported `failed` count becomes a
 * warning on the capture, and the capture proceeds. See the module doc.
 */
export function waitForImagesSettled(
  iframeDocument: Document,
  signal: AbortSignal,
  timeoutMs: number = IMAGE_SETTLE_BUDGET_MS,
): Promise<ImageSettleResult> {
  // `querySelectorAll('img')`, not `document.images`: identical set, and it is
  // present on every `Document` implementation this runs against (an iframe
  // realm, happy-dom in tests) rather than only on a full browser one.
  const images = Array.from(iframeDocument.querySelectorAll('img'))
  const pending = images.filter((image) => !imageHasFinished(image))
  const countFailed = () => images.filter(imageFailed).length

  if (signal.aborted) return Promise.resolve({ outcome: 'aborted', failed: countFailed(), stillLoading: pending.length })
  if (pending.length === 0) return Promise.resolve({ outcome: 'ok', failed: countFailed(), stillLoading: 0 })

  return new Promise<ImageSettleResult>((resolve) => {
    let finished = false
    let remaining = pending.length
    const detachers: Array<() => void> = []
    // Declared before `finish` closes over it, and armed last — every listener
    // below fires asynchronously, so nothing can reach `finish` first.
    const budgetTimer = setTimeout(() => finish('timeout'), timeoutMs)

    const finish = (outcome: WaitOutcome) => {
      if (finished) return
      finished = true
      clearTimeout(budgetTimer)
      for (const detach of detachers) detach()
      signal.removeEventListener('abort', onAbort)
      resolve({
        outcome,
        failed: countFailed(),
        stillLoading: pending.filter((image) => !imageHasFinished(image)).length,
      })
    }
    const onAbort = () => finish('aborted')

    for (const image of pending) {
      // `load` and `error` are the SAME event as far as a capture is concerned:
      // both mean this element's contribution to the pixels is final.
      const onDone = () => {
        remaining -= 1
        if (remaining <= 0) finish('ok')
      }
      image.addEventListener('load', onDone, { once: true })
      image.addEventListener('error', onDone, { once: true })
      detachers.push(() => {
        image.removeEventListener('load', onDone)
        image.removeEventListener('error', onDone)
      })
    }

    signal.addEventListener('abort', onAbort, { once: true })
  })
}

// ---------------------------------------------------------------------------
// The settle state machine
// ---------------------------------------------------------------------------

/** Which half of the settle loop was still running when a bound expired. */
export type CaptureSettlePhase = 'modules' | 'preview-data' | 'dom-quiet' | 'images' | 'fonts'

export interface CaptureSettleResult {
  /** True when every phase reached a resting state inside its bound. */
  settled: boolean
  /** The phase still in flight when a bound expired, or `null` when nothing stalled. */
  stalledPhase: CaptureSettlePhase | null
  /**
   * User-facing notes about what was imperfect but did not stop the capture —
   * broken images, fonts that never arrived, a document still mutating. Empty
   * on a clean settle.
   */
  warnings: string[]
  /** The CALLER's signal fired (unmount / cancellation). Not a capture outcome. */
  aborted: boolean
}

export interface SettleCaptureDocumentOptions {
  document: Document
  /** Cancellation from the caller — an unmount, a superseded request. NOT the deadline. */
  signal: AbortSignal
  /** The async-preview barrier, when the caller provides one. Visible editor frames do not. */
  previewReadiness?: CanvasPreviewReadiness | null
  /**
   * The canvas module registration for this project
   * (`canvasModuleSet.ts`'s `mountCanvasModuleSet`), when the caller is a
   * one-shot renderer. Omitted by every caller whose modules were registered
   * before the frame mounted.
   */
  moduleRegistration?: Promise<unknown> | null
  /** Outer bound on the whole settle. Defaults to `CAPTURE_SETTLE_TIMEOUT_MS`. */
  timeoutMs?: number
}

/** Milliseconds left before `deadline`, floored at 0. */
function remainingMs(deadline: number): number {
  return Math.max(0, deadline - Date.now())
}

/**
 * Run `wait` under a signal that aborts when the caller aborts OR when
 * `budgetMs` expires — the shape `CanvasPreviewReadiness.waitUntilIdle` needs,
 * since it takes a signal and has no budget of its own.
 */
async function withBudget<T>(
  signal: AbortSignal,
  budgetMs: number,
  wait: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  signal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(), budgetMs)
  try {
    return await wait(controller.signal)
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}

/**
 * Wait for one capture document to finish rendering, and say honestly what
 * happened.
 *
 * The loop is the original one — preview-data idle → DOM quiet → resources →
 * DOM quiet again, restarting when new preview work appeared during the
 * resource phase — with every wait bounded (see the module doc) and every
 * expired bound turned into a `warning` + a `stalledPhase` rather than a
 * failure. `settled: false` means "photograph it and say what was unfinished",
 * NOT "refuse".
 */
export async function settleCaptureDocument(
  options: SettleCaptureDocumentOptions,
): Promise<CaptureSettleResult> {
  const { document: doc, signal, previewReadiness, moduleRegistration } = options
  const deadline = Date.now() + (options.timeoutMs ?? CAPTURE_SETTLE_TIMEOUT_MS)
  const warnings: string[] = []

  const abortedResult = (stalledPhase: CaptureSettlePhase | null): CaptureSettleResult =>
    ({ settled: false, stalledPhase, warnings, aborted: true })
  const stalled = (phase: CaptureSettlePhase, warning: string): CaptureSettleResult => {
    warnings.push(warning)
    return { settled: false, stalledPhase: phase, warnings, aborted: false }
  }

  // Module renderers first — see the module doc. A frame whose components are
  // still unregistered would otherwise go quiet around its placeholders and be
  // declared settled.
  if (moduleRegistration) {
    const budget = Math.min(MODULE_REGISTRATION_BUDGET_MS, remainingMs(deadline))
    const outcome = await waitForPromise(moduleRegistration, signal, budget)
    if (outcome === 'aborted') return abortedResult('modules')
    if (outcome === 'timeout') {
      warnings.push(
        `This project's package components had not finished registering after ${budget}ms; ` +
        'any design-system component on this screen was captured as a placeholder.',
      )
    }
  }

  // Let descendant effects register their first data/media requests before an
  // initially-idle tracker can be mistaken for a finished preview.
  if (!await waitForDelay(0, signal)) return abortedResult(null)

  while (!signal.aborted) {
    if (remainingMs(deadline) === 0) {
      return stalled('dom-quiet', 'This screen was still rendering when it was captured.')
    }

    if (previewReadiness && previewReadiness.pendingCount() !== 0) {
      const idle = await withBudget(signal, remainingMs(deadline), (s) => previewReadiness.waitUntilIdle(s))
      if (signal.aborted) return abortedResult('preview-data')
      if (!idle) {
        return stalled(
          'preview-data',
          `${previewReadiness.pendingCount()} preview data request(s) never finished; this screen was captured without them.`,
        )
      }
    }
    const settledRevision = previewReadiness?.revision() ?? 0

    const firstQuiet = await waitForDocumentQuiet(doc, signal, Math.min(DOM_QUIET_BUDGET_MS, remainingMs(deadline)))
    if (firstQuiet === 'aborted') return abortedResult('dom-quiet')
    if (firstQuiet === 'timeout') {
      return stalled('dom-quiet', 'This screen never stopped changing, so it was captured mid-render.')
    }
    if (
      previewReadiness &&
      (previewReadiness.pendingCount() !== 0 || previewReadiness.revision() !== settledRevision)
    ) continue

    // ── Resources. Both phases are bounded and both count an ERROR as done. ──
    const imageBudget = Math.min(IMAGE_SETTLE_BUDGET_MS, remainingMs(deadline))
    const images = await waitForImagesSettled(doc, signal, imageBudget)
    if (images.outcome === 'aborted') return abortedResult('images')
    if (images.failed > 0) {
      warnings.push(
        images.failed === 1
          ? '1 image failed to load and is missing from this capture.'
          : `${images.failed} images failed to load and are missing from this capture.`,
      )
    }
    if (images.outcome === 'timeout') {
      warnings.push(
        `${images.stillLoading} image(s) were still loading after ${imageBudget}ms and were captured unfinished.`,
      )
    }

    const fonts = doc.fonts
    if (fonts?.status === 'loading') {
      const fontBudget = Math.min(FONT_SETTLE_BUDGET_MS, remainingMs(deadline))
      const outcome = await waitForPromise(fonts.ready, signal, fontBudget)
      if (outcome === 'aborted') return abortedResult('fonts')
      if (outcome === 'timeout') {
        warnings.push(
          `Web fonts had not finished loading after ${fontBudget}ms; this capture may use fallback glyph metrics.`,
        )
      }
    }

    const finalQuiet = await waitForDocumentQuiet(doc, signal, Math.min(DOM_QUIET_BUDGET_MS, remainingMs(deadline)))
    if (finalQuiet === 'aborted') return abortedResult('dom-quiet')
    if (finalQuiet === 'timeout') {
      return stalled('dom-quiet', 'This screen never stopped changing, so it was captured mid-render.')
    }

    // A settled data request can add more asynchronous preview work during the
    // resource phase. Restart so the final committed DOM is included as well.
    if (
      !previewReadiness ||
      (previewReadiness.pendingCount() === 0 && previewReadiness.revision() === settledRevision)
    ) {
      return { settled: true, stalledPhase: null, warnings, aborted: false }
    }
  }

  return abortedResult(null)
}
