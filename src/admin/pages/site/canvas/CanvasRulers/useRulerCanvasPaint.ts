import { useEffect, useRef, type RefObject } from 'react'
import type { CanvasTransform } from '@site/hooks/useCanvas'
import { paintRuler, RULER_THICKNESS_PX } from './rulerPaint'

interface UseRulerCanvasPaintParams {
  axis: 'x' | 'y'
  /** The element whose length (offsetWidth for 'x', offsetHeight for 'y') drives the ruler's on-screen extent. */
  lengthSourceRef: RefObject<HTMLElement | null>
  transformRef: RefObject<CanvasTransform>
  originBoard: number
}

/**
 * Repaints a ruler `<canvas>` on a persistent `requestAnimationFrame` loop —
 * the same idiom `BreakpointSelectionOverlay`'s RAF tick already uses for a
 * live-transform-driven overlay (see `canvas-internals.md`'s "Selection and
 * geometry"). Polling is required, not optional: `transformRef` is mutated
 * in place with no change event (see its doc in `useCanvas.ts`), so there is
 * no subscription to hang a repaint off. The loop itself is cheap — it does
 * nothing but compare a handful of numbers — and only repaints the canvas
 * (the actual work) when zoom/pan/length/origin actually changed since the
 * last tick.
 *
 * OWNS its `<canvas>` ref rather than accepting one as a parameter — the
 * caller (`RulerH`/`RulerV`) attaches the RETURNED ref to its `<canvas>`
 * element. An earlier version took `canvasElRef` as a hook argument and
 * wrote `canvasEl.width`/`.height` (sizing the backing store for the
 * current DPR) inside the rAF loop; `react-compiler/react-compiler` flagged
 * that as "mutating a hook argument" — the compiler treats anything reached
 * through a destructured parameter, including a ref's `.current` value, as
 * off-limits to mutate, even though a `<canvas>` backing-store resize is
 * exactly the kind of imperative DOM work refs exist for. Creating the ref
 * with `useRef` INSIDE this hook (not passing one in) means the mutated
 * value is no longer reachable from a parameter at all, which resolves the
 * compiler's diagnostic without an eslint-disable / "use no memo" escape
 * hatch — this is genuinely compilable, correctly-scoped imperative code.
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
    let rafId = requestAnimationFrame(tick)

    function tick() {
      rafId = requestAnimationFrame(tick)

      const canvasEl = canvasElRef.current
      const lengthSource = lengthSourceRef.current
      if (!canvasEl || !lengthSource) return

      const length = axis === 'x' ? lengthSource.offsetWidth : lengthSource.offsetHeight
      if (length <= 0) return

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

    return () => cancelAnimationFrame(rafId)
  }, [axis, lengthSourceRef, transformRef, originBoard])

  return canvasElRef
}
