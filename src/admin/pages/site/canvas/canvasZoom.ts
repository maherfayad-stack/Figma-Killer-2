/**
 * canvasZoomOf — the live zoom of the canvas transform layer, read off the
 * element itself.
 *
 * WHY NOT `rect.width / offsetWidth`
 * ──────────────────────────────────
 * That ratio is the usual way to recover a CSS scale, and it is what
 * `measureIframeLocalRect` uses for a frame's iframe — correctly, because an
 * iframe is a replaced element with a real intrinsic width.
 *
 * It is WRONG for the transform layer, and silently so. Every board frame is
 * `position: absolute`, so the layer has no in-flow content, so its
 * `offsetWidth` is **0** — and a `> 0` guard then falls back to a zoom of 1.
 * That shipped: comment placement divided by 1 instead of the real zoom, so a
 * pin dropped at 50% zoom was stored twice as far from its frame's corner as
 * the user clicked, and appeared to jump the moment it rendered. A fallback
 * that returns a plausible-looking number instead of failing is the worst
 * shape a fallback can have.
 *
 * WHY NOT THE STORE
 * ─────────────────
 * `useEditorStore`'s `zoom` is committed 100 ms AFTER the last gesture event
 * (see `useCanvas`), so a click during or just after a pinch reads a stale
 * value.
 *
 * WHY NOT `--canvas-zoom`
 * ───────────────────────
 * It would work — `applyTransformToDOM` republishes it on the same rAF tick
 * that writes the transform — but it is a COPY. The computed matrix is the
 * thing actually on screen, so it cannot disagree with what the user clicked
 * on. `--canvas-zoom` stays what it was added for: pure-CSS counter-scaling,
 * where reading a matrix in script is not an option.
 */

/**
 * Returns the horizontal scale of `element`'s computed transform. Falls back
 * to 1 only when there is genuinely no transform to read (`none`, or an
 * environment without `DOMMatrixReadOnly` — jsdom).
 */
export function canvasZoomOf(element: HTMLElement): number {
  const transform = getComputedStyle(element).transform
  if (!transform || transform === 'none') return 1
  if (typeof DOMMatrixReadOnly === 'undefined') return 1
  try {
    const scale = new DOMMatrixReadOnly(transform).a
    // A zero or negative scale is not a zoom anyone can click at; dividing by
    // it would produce Infinity/NaN coordinates and a pin at the far edge of
    // the board.
    return scale > 0 ? scale : 1
  } catch {
    return 1
  }
}

/**
 * The canvas transform layer `element` lives inside, or `null`.
 *
 * A gesture that starts on board furniture (a comment pin, say) has to measure
 * against the transform layer, but only holds a ref to its own element. The
 * marker attribute is on `CanvasTransformLayer` for exactly this — a `testid`
 * would work as a selector, but a production code path must not depend on a
 * hook that exists for tests and is fair game to rename.
 */
export function canvasTransformLayerOf(element: HTMLElement): HTMLElement | null {
  return element.closest<HTMLElement>('[data-canvas-transform-layer]')
}
