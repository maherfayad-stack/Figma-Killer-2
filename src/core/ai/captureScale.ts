/**
 * The one place that decides how many pixels a Studio frame capture may be.
 *
 * Two capture paths now rasterise the same frames — the browser-bridged one
 * (`renderEvidence.ts`'s `html-to-image` rasteriser, running inside the user's
 * open tab) and the headless one (`server/ai/mcp/capture/`, running a real
 * Chromium server-side). A verdict from `studio_compare` must not depend on
 * WHICH of the two produced the bytes, so the ratio maths lives here, once,
 * and both call `effectiveCaptureRatio`.
 *
 * The rule both share: never upscale past 1:1, and never exceed the cap that
 * matches what the image is FOR. `purpose` picks which cap — see each
 * constant's own doc for why these are two genuinely different bounds rather
 * than one constant reused.
 */

export type CapturePurpose = 'vision' | 'measurement'

// Anthropic rejects any image dimension > 8000px outright (400), and internally
// downsizes the long edge to ~1568px before the model ever sees it. So we cap
// the long edge of the capture here: a tall landing-page screenshot stays under
// the hard limit AND we never ship more pixels than the model actually uses.
// Applies ONLY to `purpose: 'vision'` captures (the default) — an image that
// will actually be looked at by a model. See `MEASUREMENT_MAX_PIXELS` for the
// separate cap on captures that exist purely to be pixel-diffed.
const MAX_IMAGE_EDGE = 1568

/**
 * `purpose: 'measurement'` cap — for a capture that is diffed server-side
 * with pixelmatch (`studio_compare`) and never necessarily shown to a model.
 * The vision-safe `MAX_IMAGE_EDGE` clamp has nothing to do with pixel-diff
 * correctness and was actively harmful here: applied to BOTH width and
 * height, it silently degraded studio_compare's "exact-pixel" comparison
 * into an interpolated one for most real mobile screens taller than ~784 CSS
 * px at 2x (STUDIO-FIGMA-PARITY-PLAN.md A2) — the reference reconciliation's
 * resample branch was firing on ordinary tall screens, not just genuine size
 * mismatches.
 *
 * Bounded by TOTAL PIXEL COUNT instead of a per-edge clamp, so a moderately
 * tall/narrow frame (the common mobile case) keeps its full requested
 * resolution instead of being punished by a symmetric edge limit that has no
 * relationship to how much memory the capture actually costs.
 *
 * Memory reasoning (this must not be able to OOM the tab): `html-to-image`'s
 * `toCanvas()` paints into an offscreen `<canvas>`, backed by an RGBA
 * ImageData-shaped buffer — 4 bytes/px — and `canvas.toDataURL('image/png')`
 * then holds roughly a second same-size buffer while it re-encodes to PNG.
 * 15,000,000px × 4B × 2 buffers ≈ 120MB of transient, short-lived (freed as
 * soon as the same task's `await` resolves) canvas memory for a single,
 * user-triggered, one-at-a-time capture — comfortably inside a modern
 * browser tab's budget, while still refusing a genuinely unbounded request
 * (an accidental 3x capture of a 10,000px-tall unrolled page), and with
 * enough headroom above the concrete case this cap exists for (a 1440×2000
 * frame at true 2x is 11,520,000px) that the ordinary case is never clamped.
 *
 * Deliberately set BELOW `MEASUREMENT_MAX_EDGE²` (~16.8M): if it were set
 * at or above that figure, the budget could mathematically never be the
 * binding constraint — whenever both post-scale edges are ≤
 * `MEASUREMENT_MAX_EDGE`, their product is already ≤ `MEASUREMENT_MAX_EDGE²`,
 * so a higher budget would just be dead code shadowed by the edge ceiling,
 * silently degrading back into "a per-edge clamp with a bigger number" —
 * exactly the shape of cap this mode exists to NOT be.
 */
const MEASUREMENT_MAX_PIXELS = 15_000_000
/**
 * Hard per-edge ceiling for `purpose: 'measurement'`, independent of the
 * pixel budget above — protects against a single very elongated axis (e.g. a
 * narrow but extremely tall scroll-unrolled page) where the total pixel
 * count stays modest but one dimension alone would exceed what a `<canvas>`
 * backing store can hold. Individual canvas dimension limits are UA-defined
 * and vary a lot: Chromium and Gecko permit tens of thousands of px per
 * edge, but WebKit has historically been far more restrictive (as low as
 * 4096px on some builds, notably older mobile Safari). This project does not
 * gate which browser opens the Studio admin, so the ceiling is set at the
 * well-known cross-engine-safe figure rather than the most permissive one.
 */
const MEASUREMENT_MAX_EDGE = 4096

/**
 * The pixel ratio a capture of a `cssWidth × cssHeight` region may actually
 * use, given what the caller asked for and what the image is for.
 *
 * Never above `requestedRatio`, never above 1:1 when the caller asked for
 * nothing, and never above the `purpose`'s cap. The returned number is the
 * TRUTH about the resulting image — callers derive `imageScale` from the real
 * captured size rather than from the requested `dpr` precisely because these
 * two can differ.
 */
export function effectiveCaptureRatio(
  cssWidth: number,
  cssHeight: number,
  requestedRatio: number | undefined,
  purpose: CapturePurpose = 'vision',
): number {
  const requested = requestedRatio && requestedRatio > 0 ? requestedRatio : 1
  const width = Math.max(1, cssWidth)
  const height = Math.max(1, cssHeight)
  if (purpose === 'measurement') {
    return Math.min(
      requested,
      MEASUREMENT_MAX_EDGE / width,
      MEASUREMENT_MAX_EDGE / height,
      Math.sqrt(MEASUREMENT_MAX_PIXELS / (width * height)),
    )
  }
  return Math.min(requested, MAX_IMAGE_EDGE / width, MAX_IMAGE_EDGE / height)
}
