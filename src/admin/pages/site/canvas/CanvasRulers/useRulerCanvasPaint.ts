import { useEffect, useRef, type RefObject } from 'react'
import type { CanvasTransform } from '@site/hooks/useCanvas'
import { onCanvasViewportTransform } from '../canvasViewportActivity'
import { paintRuler, RULER_THICKNESS_PX } from './rulerPaint'

interface UseRulerCanvasPaintParams {
  axis: 'x' | 'y'
  /** The element whose length (offsetWidth for 'x', offsetHeight for 'y') drives the ruler's on-screen extent. */
  lengthSourceRef: RefObject<HTMLElement | null>
  transformRef: RefObject<CanvasTransform>
  originBoard: number
}

/**
 * Paints a ruler `<canvas>` whenever what it shows can have changed — and at
 * no other time (audit PERF-4).
 *
 * This used to be a permanent `requestAnimationFrame` loop, one per ruler, on
 * the grounds that `transformRef` is mutated in place with no change event.
 * That stopped being true when `canvasViewportActivity.ts` (S4) started
 * publishing every transform write; the loop outlived its reason and kept an
 * idle board from ever letting the main thread sleep — two 60 Hz loops, each
 * reading `offsetWidth`/`offsetHeight` (a forced layout after any
 * parent-document write) every frame, forever. Measured on the 40-frame
 * corpus: ~121 rAF calls per second with nobody touching the board.
 *
 * What can change the picture, and what now repaints it:
 *
 *   - the pan/zoom transform → `onCanvasViewportTransform`, synchronously in
 *     the same task as the write, so a ruler never lags the board by a frame;
 *   - the ruler's on-screen length → a `ResizeObserver` on the length source,
 *     which also caches the length so a paint never forces a layout read;
 *   - the origin (the active board changed) → this effect re-runs;
 *   - the device pixel ratio (browser zoom, a monitor change) → the window
 *     `resize` that accompanies it.
 *
 * Each paint still compares against the last painted inputs and skips an
 * identical one. Nothing polls.
 *
 * OWNS its `<canvas>` ref rather than accepting one as a parameter — the
 * caller (`RulerH`/`RulerV`) attaches the RETURNED ref to its `<canvas>`
 * element. An earlier version took `canvasElRef` as a hook argument and
 * wrote `canvasEl.width`/`.height` (sizing the backing store for the
 * current DPR); `react-compiler/react-compiler` flagged that as "mutating a
 * hook argument" — the compiler treats anything reached through a
 * destructured parameter, including a ref's `.current` value, as off-limits
 * to mutate. Creating the ref with `useRef` INSIDE this hook means the
 * mutated value is no longer reachable from a parameter at all.
 */
export function useRulerCanvasPaint({
  axis,
  lengthSourceRef,
  transformRef,
  originBoard,
}: UseRulerCanvasPaintParams): RefObject<HTMLCanvasElement | null> {
  const canvasElRef = useRef<HTMLCanvasElement | null>(null)
  const lastPaintedRef = useRef({ zoom: NaN, pan: NaN, length: NaN, origin: NaN, dpr: NaN })

  useEffect(() => {
    const lengthSource = lengthSourceRef.current
    const readLength = () => (lengthSource ? (axis === 'x' ? lengthSource.offsetWidth : lengthSource.offsetHeight) : 0)
    // Cached: refreshed only by the ResizeObserver below, never read per paint.
    let length = readLength()

    function paint() {
      const canvasEl = canvasElRef.current
      if (!canvasEl || length <= 0) return

      const transform = transformRef.current
      const pan = axis === 'x' ? transform.panX : transform.panY
      const dpr = window.devicePixelRatio || 1

      const last = lastPaintedRef.current
      if (
        last.zoom === transform.zoom &&
        last.pan === pan &&
        last.length === length &&
        last.origin === originBoard &&
        last.dpr === dpr
      ) {
        return
      }
      lastPaintedRef.current = { zoom: transform.zoom, pan, length, origin: originBoard, dpr }

      const thicknessPx = RULER_THICKNESS_PX
      const physicalLength = Math.round(length * dpr)
      const physicalThickness = Math.round(thicknessPx * dpr)
      const physicalWidth = axis === 'x' ? physicalLength : physicalThickness
      const physicalHeight = axis === 'x' ? physicalThickness : physicalLength
      if (canvasEl.width !== physicalWidth) canvasEl.width = physicalWidth
      if (canvasEl.height !== physicalHeight) canvasEl.height = physicalHeight

      const ctx = canvasEl.getContext('2d')
      if (!ctx) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, length, thicknessPx)

      const style = getComputedStyle(canvasEl)
      paintRuler({
        ctx,
        axis,
        lengthPx: length,
        transform,
        originBoard,
        colors: {
          bg: style.getPropertyValue('--bg-surface-2').trim(),
          tick: style.getPropertyValue('--text-subtle').trim(),
          text: style.getPropertyValue('--text-muted').trim(),
          originTick: style.getPropertyValue('--canvas-ruler-guide-color').trim(),
        },
      })
    }

    paint()
    const stopFollowing = onCanvasViewportTransform(paint)
    const resizeObserver =
      lengthSource && typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => {
            length = readLength()
            paint()
          })
        : null
    if (lengthSource) resizeObserver?.observe(lengthSource)
    window.addEventListener('resize', paint)

    return () => {
      stopFollowing()
      resizeObserver?.disconnect()
      window.removeEventListener('resize', paint)
    }
  }, [axis, lengthSourceRef, transformRef, originBoard])

  return canvasElRef
}
