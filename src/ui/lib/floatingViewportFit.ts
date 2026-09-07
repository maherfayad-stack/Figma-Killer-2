/**
 * floatingViewportFit — the final viewport-fit pass applied to an already
 * anchored floating surface.
 *
 * `computeFloatingPosition` (see `floatingPosition.ts`) picks a *side* and
 * clamps the resulting rectangle against the viewport, but it works from the
 * floating element's **measured** height. That is not enough on its own for a
 * tall panel:
 *
 *   - A panel taller than the viewport has no clamped `y` that makes it fit —
 *     the side pass pins it to the top margin and the overflowing tail simply
 *     runs off the bottom of the screen. The inspector's ⚙ popovers hit this
 *     the moment their trigger sits low in the Properties panel (the reported
 *     bug: "Typography settings" clipped mid-`margin-block`).
 *   - Measurement via `getBoundingClientRect()` is transform-aware, so a panel
 *     mid-enter-animation measures ~3% short and lands ~3% too low.
 *
 * The fix is to stop treating height as an input the layout must accommodate
 * and start treating it as an output the layout *dictates*: this function
 * returns a `maxHeight` ceiling alongside the clamped `x`/`y`. The consumer
 * applies the ceiling as a CSS `max-height` and lets its body scroll, so a
 * panel of any height always sits fully inside the viewport with `margin` px
 * of breathing room on every edge.
 *
 * Pure and DOM-free on purpose — the viewport is passed in, never read from
 * `window` — so the geometry is unit-testable without a browser.
 */

export interface FloatingViewportFitInput {
  /** Proposed left edge in viewport pixels, from the anchored-positioning pass. */
  x: number
  /** Proposed top edge in viewport pixels, from the anchored-positioning pass. */
  y: number
  /** Render width of the floating element, px. */
  width: number
  /**
   * Measured layout height of the floating element, px. Read this from
   * `offsetHeight` rather than `getBoundingClientRect().height`: the latter
   * includes the enter animation's `scale()` and reports short.
   */
  height: number
  viewportWidth: number
  viewportHeight: number
  /** Minimum gap kept between the element and every viewport edge, px. */
  margin: number
}

export interface FloatingViewportFit {
  /** Clamped left edge in viewport pixels. */
  x: number
  /** Clamped top edge in viewport pixels. */
  y: number
  /**
   * Height ceiling the element must not exceed. Always the viewport height
   * minus a margin on each edge — apply it as `max-height` and scroll the
   * body inside it.
   */
  maxHeight: number
}

/** Clamps `value` into `[min, max]`, with `min` winning when the range is inverted. */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max))
}

/**
 * Clamp an anchored floating rectangle so it sits fully inside the viewport,
 * and report the height ceiling that makes that possible.
 */
export function fitFloatingToViewport({
  x,
  y,
  width,
  height,
  viewportWidth,
  viewportHeight,
  margin,
}: FloatingViewportFitInput): FloatingViewportFit {
  const maxHeight = Math.max(0, viewportHeight - margin * 2)
  const maxWidth = Math.max(0, viewportWidth - margin * 2)

  // The element can never render taller/wider than its ceiling, so clamp the
  // position against the *constrained* size, not the requested one. Without
  // this, an oversized panel would be pushed to a negative `y`.
  const fittedHeight = Math.min(height, maxHeight)
  const fittedWidth = Math.min(width, maxWidth)

  return {
    x: clamp(x, margin, viewportWidth - fittedWidth - margin),
    y: clamp(y, margin, viewportHeight - fittedHeight - margin),
    maxHeight,
  }
}
