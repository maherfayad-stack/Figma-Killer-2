/**
 * rulerPaint — 2D canvas rendering for RulerH/RulerV. Not pure (writes to a
 * `CanvasRenderingContext2D`), so it stays out of `rulerGeometry.ts`
 * (PURE-only, unit-tested) and isn't itself unit-tested — this is the
 * `<canvas>` paint step `rulerGeometry.ts`'s doc says to avoid thousands of
 * per-tick DOM nodes for.
 */
import { computeRulerTicks, type RulerTransform } from './rulerGeometry'

/** Ruler chrome thickness, in CSS px. Both rulers share one value (square corner). */
export const RULER_THICKNESS_PX = 22

const TICK_LABEL_PADDING_PX = 4
/**
 * Canvas 2D's `font` setter does NOT resolve CSS custom properties (a
 * `var(--font-mono)` value is invalid canvas font syntax and gets silently
 * ignored, falling back to the browser default) — so this is a literal
 * font stack, not `var(--font-mono)`.
 */
const TICK_FONT = '10px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace'

export interface PaintRulerParams {
  ctx: CanvasRenderingContext2D
  axis: 'x' | 'y'
  /** CSS px length/thickness — the physical canvas is already DPR-scaled and pre-scaled by the caller. */
  lengthPx: number
  transform: RulerTransform
  originBoard: number
  /** Resolved CSS color values (canvas 2D can't read `var(--token)` itself). */
  colors: { bg: string; tick: string; text: string; originTick: string }
}

/** Paint one ruler's ticks + labels. Caller owns clearing/DPR scaling/save-restore. */
export function paintRuler(params: PaintRulerParams): void {
  const { ctx, axis, lengthPx, transform, originBoard, colors } = params
  const pan = axis === 'x' ? transform.panX : transform.panY

  ctx.fillStyle = colors.bg
  ctx.fillRect(0, 0, axis === 'x' ? lengthPx : RULER_THICKNESS_PX, axis === 'x' ? RULER_THICKNESS_PX : lengthPx)

  const ticks = computeRulerTicks({
    viewportLengthPx: lengthPx,
    zoom: transform.zoom,
    pan,
    originBoard,
  })

  ctx.font = TICK_FONT
  ctx.textBaseline = 'top'

  for (const tick of ticks) {
    if (tick.screenPos < -1 || tick.screenPos > lengthPx + 1) continue
    ctx.strokeStyle = tick.value === 0 ? colors.originTick : colors.tick
    ctx.beginPath()
    if (axis === 'x') {
      ctx.moveTo(tick.screenPos + 0.5, RULER_THICKNESS_PX - 6)
      ctx.lineTo(tick.screenPos + 0.5, RULER_THICKNESS_PX)
    } else {
      ctx.moveTo(RULER_THICKNESS_PX - 6, tick.screenPos + 0.5)
      ctx.lineTo(RULER_THICKNESS_PX, tick.screenPos + 0.5)
    }
    ctx.stroke()

    ctx.fillStyle = colors.text
    const label = String(tick.value)
    if (axis === 'x') {
      ctx.fillText(label, tick.screenPos + TICK_LABEL_PADDING_PX, TICK_LABEL_PADDING_PX)
    } else {
      // Vertical ruler labels are rotated -90deg so they read bottom-to-top
      // alongside the tick, matching Figma's vertical ruler convention.
      ctx.save()
      ctx.translate(TICK_LABEL_PADDING_PX + 8, tick.screenPos + TICK_LABEL_PADDING_PX)
      ctx.rotate(-Math.PI / 2)
      ctx.fillText(label, 0, 0)
      ctx.restore()
    }
  }
}
