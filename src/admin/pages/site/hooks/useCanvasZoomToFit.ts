/**
 * useCanvasZoomToFit — the three fit gestures (`Shift+1` fit, the toolbar
 * menu's Fill, `Shift+2` fit-to-selection) and the one transform they all
 * compute.
 *
 * Split out of `useCanvas.ts` when that file passed the 700-line ceiling.
 * The seam is real: these four are the only members of that hook that do not
 * touch the pointer, the wheel, the spacebar or the store subscription — they
 * MEASURE rects and hand one transform to the writer `useCanvas` owns.
 *
 * `applyTransformToDOM` and `transformRef` are passed in rather than
 * re-derived, deliberately: `applyTransformToDOM` is the ONE funnel that
 * marks viewport activity (S4) and it must stay one funnel, and `transformRef`
 * is the live transform the store selector is up to 100 ms behind (see
 * `useCanvas`'s own doc). Never swap either for a store read here.
 */
import { useCallback, type RefObject } from 'react'
import {
  DEFAULT_ZOOM_FIT_PADDING_PX,
  computeZoomToFitTransform,
  type CanvasFitRect,
  type ZoomFitMode,
} from '@site/canvas/canvasZoomFit'
import { measureCanvasFrameRects, measureCanvasSelectionRects } from '@site/canvas/canvasViewportCommands'
import type { CanvasTransform } from '@site/canvas/math'

interface UseCanvasZoomToFitOptions {
  canvasRootRef: RefObject<HTMLElement | null>
  transformLayerRef: RefObject<HTMLElement | null>
  /**
   * The LIVE transform — never the store selector, which is up to 100 ms
   * behind during a gesture. READ-ONLY here: the write goes through
   * {@link UseCanvasZoomToFitOptions.commitTransform}, because the React
   * Compiler will not let a hook write a ref it was handed (and is right
   * to — the owner of a ref should be the one that writes it).
   */
  transformRef: RefObject<CanvasTransform>
  /**
   * Adopt a computed transform: advance the live ref, write the DOM, commit
   * to the store. One callback rather than three arguments because the
   * three must happen in that order (the ref moves BEFORE the store, or the
   * store subscription fires its own competing animated write), and because
   * the React Compiler will not let this hook write a ref it was handed.
   */
  commitTransform: (t: CanvasTransform, animated: boolean) => void
}

export function useCanvasZoomToFit({
  canvasRootRef,
  transformLayerRef,
  transformRef,
  commitTransform,
}: UseCanvasZoomToFitOptions) {
/**
 * Zoom/pan so `targetRects` (screen-space, relative to the canvas root) are
 * entirely visible (`contain`) or fill the viewport (`cover`), centered.
 * Shared by `zoomToFit`, `zoomToFill` and `zoomToSelection` — the only
 * differences between the three are which rects they measure and the mode.
 * Returns `false` when there was nothing to fit (empty or fully-degenerate
 * rect list — see `computeZoomToFitTransform`).
 */
const applyZoomToFitRects = useCallback(
  (targetRects: readonly CanvasFitRect[], mode: ZoomFitMode = 'contain'): boolean => {
    const root = canvasRootRef.current
    if (!root) return false
    const rootRect = root.getBoundingClientRect()
    const next = computeZoomToFitTransform(
      { width: rootRect.width, height: rootRect.height },
      targetRects,
      transformRef.current,
      DEFAULT_ZOOM_FIT_PADDING_PX,
      mode,
    )
    if (!next) return false
    commitTransform(next, true)
    return true
  },
  [canvasRootRef, transformRef, commitTransform],
)

/**
 * `Shift+1` (`canvas.zoomToFit`) — fit every visible breakpoint frame on
 * the board (or every viewport context frame outside board mode) into the
 * viewport at once. D3, `STUDIO-FIGMA-PARITY-PLAN.md`: this used to be a
 * "reset to 100%" alias; it is now the real Figma-style fit.
 */
const zoomToFit = useCallback((): boolean => {
  const root = canvasRootRef.current
  const layer = transformLayerRef.current
  if (!root || !layer) return false
  return applyZoomToFitRects(measureCanvasFrameRects(root, layer))
}, [canvasRootRef, transformLayerRef, applyZoomToFitRects])

/**
 * The toolbar zoom menu's "Fill" (viewport-01) — same frames as `zoomToFit`,
 * scaled to COVER the viewport instead of fitting inside it. Keyboard-free
 * on purpose: Figma has no default key for it either, and the registry only
 * carries keys that exist.
 */
const zoomToFill = useCallback((): boolean => {
  const root = canvasRootRef.current
  const layer = transformLayerRef.current
  if (!root || !layer) return false
  return applyZoomToFitRects(measureCanvasFrameRects(root, layer), 'cover')
}, [canvasRootRef, transformLayerRef, applyZoomToFitRects])

/**
 * `Shift+2` (`canvas.zoomToSelection`) — fit the current selection, measured
 * from the live selection rings (see `measureCanvasSelectionRects`).
 * No-ops (`false`) when nothing is selected.
 */
const zoomToSelection = useCallback((): boolean => {
  const root = canvasRootRef.current
  if (!root) return false
  return applyZoomToFitRects(measureCanvasSelectionRects(root))
}, [canvasRootRef, applyZoomToFitRects])

  return { applyZoomToFitRects, zoomToFit, zoomToFill, zoomToSelection }
}
