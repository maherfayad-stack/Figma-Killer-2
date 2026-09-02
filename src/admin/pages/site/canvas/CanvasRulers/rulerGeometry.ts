/**
 * rulerGeometry — pure board↔screen math for the design-mode rulers.
 *
 * PURE. No React, no DOM. Every function here operates on plain numbers, and
 * every parameter/return doc below says explicitly which SPACE it is in
 * (screen-px relative to `.canvas`, or board units) — the 0.8-era canvas bug
 * this file exists to not repeat was exactly a units confusion.
 *
 * ── The transform, and the landmine ─────────────────────────────────────
 *
 * `CanvasTransformLayer` renders `translate(panX, panY) scale(zoom)` with
 * `transform-origin: 0 0`, so a board-space point maps to screen-space (both
 * relative to the TRANSFORM LAYER's own origin) as:
 *
 *   screen = board * zoom + pan
 *
 * But the transform layer itself is NOT flush with `.canvas`'s origin: its
 * CSS is `position: absolute; top: 80px; left: 80px` relative to `.canvas`
 * (`CanvasTransformLayer.module.css`). Rulers mount as siblings of the
 * transform layer, inside `.canvas` — so a ruler's own coordinate system IS
 * `.canvas`'s untransformed origin, and board→screen math done AGAINST A
 * RULER has to add that 80px back in:
 *
 *   screen(.canvas-relative) = board * zoom + pan + 80
 *
 * `frameVirtualization.ts`'s own board→screen formula deliberately omits
 * this term (harmless there — a 600px viewport-culling margin absorbs an
 * 80px error). Copying that formula here would ship every tick 80px off.
 * `CANVAS_TRANSFORM_LAYER_OFFSET_PX` is exported specifically so a regression
 * test can pin it, and so this module never re-derives the number from
 * scratch — if `CanvasTransformLayer.module.css`'s `top`/`left` ever change,
 * this constant (and its test) must change with it.
 */

/**
 * `.transformLayer`'s static offset from `.canvas` — see the module doc.
 * Read from `CanvasTransformLayer.module.css:17-30` (`top: 80px; left: 80px`),
 * not derived. `top` and `left` are the same value, so one constant covers
 * both axes.
 */
export const CANVAS_TRANSFORM_LAYER_OFFSET_PX = 80

/** The live canvas transform, in the same shape `useCanvas()`'s `transformRef` holds. */
export interface RulerTransform {
  zoom: number
  panX: number
  panY: number
}

/**
 * Convert a BOARD-space coordinate on one axis to a SCREEN-space coordinate
 * relative to `.canvas` (the ruler's own coordinate system).
 *
 * @param boardValue Board-space coordinate (board units) on this axis.
 * @param zoom       Live canvas zoom (`transformRef.current.zoom`).
 * @param pan        Live canvas pan on this axis (`panX` or `panY`).
 */
export function boardToScreen(boardValue: number, zoom: number, pan: number): number {
  return boardValue * zoom + pan + CANVAS_TRANSFORM_LAYER_OFFSET_PX
}

/**
 * Inverse of {@link boardToScreen}: a SCREEN-space coordinate (relative to
 * `.canvas`) back to BOARD-space.
 */
export function screenToBoard(screenValue: number, zoom: number, pan: number): number {
  return (screenValue - pan - CANVAS_TRANSFORM_LAYER_OFFSET_PX) / zoom
}

/**
 * Nice-number tick ladder, ascending — the standard ruler/grid progression
 * (1, 2, 5 × each power of ten stays in-band for board units up to 1000).
 */
export const TICK_STEP_LADDER = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000] as const

/** Minimum acceptable on-screen spacing (px) between two adjacent ticks. */
export const MIN_TICK_SPACING_PX = 60

/**
 * The smallest step in {@link TICK_STEP_LADDER} whose ON-SCREEN spacing
 * (`step * zoom`) is at least {@link MIN_TICK_SPACING_PX}. At extreme
 * zoom-out, where even the ladder's largest step doesn't reach the minimum
 * spacing, falls back to that largest step anyway (ticks render closer than
 * ideal rather than not at all).
 */
export function niceTickStep(zoom: number): number {
  for (const step of TICK_STEP_LADDER) {
    if (step * zoom >= MIN_TICK_SPACING_PX) return step
  }
  return TICK_STEP_LADDER[TICK_STEP_LADDER.length - 1]
}

/** One labeled ruler tick. */
export interface RulerTick {
  /** Screen-space position (px, relative to `.canvas`) along the ruler's axis. */
  screenPos: number
  /** The label value — board-space distance from `originBoard`, NOT the raw board coordinate. */
  value: number
}

export interface ComputeRulerTicksParams {
  /** The ruler's on-screen length (viewport width for RulerH, height for RulerV), in px. */
  viewportLengthPx: number
  /** Live zoom. */
  zoom: number
  /** Live pan on this axis (`panX` for RulerH, `panY` for RulerV). */
  pan: number
  /**
   * Board-space coordinate that should read as "0" on the ruler — normally 0,
   * or the active frame's own x/y when exactly one frame is active (see
   * {@link resolveRulerOriginBoard}).
   */
  originBoard: number
}

/**
 * Every tick that falls within the visible screen range `[0, viewportLengthPx]`,
 * spaced at `niceTickStep(zoom)` board units, labeled relative to `originBoard`.
 * One extra tick is included on each side of the visible range so a partially
 * clipped label at the very edge still has a real value.
 */
export function computeRulerTicks(params: ComputeRulerTicksParams): RulerTick[] {
  const { viewportLengthPx, zoom, pan, originBoard } = params
  if (zoom <= 0 || !Number.isFinite(zoom)) return []

  const step = niceTickStep(zoom)

  // Visible board-space range, in units relative to originBoard.
  const boardStart = screenToBoard(0, zoom, pan) - originBoard
  const boardEnd = screenToBoard(viewportLengthPx, zoom, pan) - originBoard

  const firstValue = Math.floor(boardStart / step) * step - step
  const lastValue = Math.ceil(boardEnd / step) * step + step

  const ticks: RulerTick[] = []
  for (let value = firstValue; value <= lastValue; value += step) {
    ticks.push({
      screenPos: boardToScreen(originBoard + value, zoom, pan),
      // Round away floating-point noise from repeated `+= step` — a board
      // unit is always an integer in practice (frame/guide positions), and a
      // label like "99.99999999999997" would be a visible regression.
      value: Math.round(value * 1e6) / 1e6,
    })
  }
  return ticks
}

/** Anything {@link resolveRulerOriginBoard} needs from the active board. */
export interface RulerOriginBoardLike {
  frames: ReadonlyArray<{ x: number; y: number }>
}

/**
 * The board-space point that should read as ruler "0". Board `(0, 0)`
 * normally; the active board's single frame's own `(x, y)` when the board
 * has EXACTLY one frame — matching Figma's "ruler zeroes on the frame when
 * only one is in view" behavior. `null` (no active board — CMS/breakpoint
 * mode, where frames are flex-laid-out and have no `x`/`y` of their own)
 * always resolves to board `(0, 0)`.
 */
export function resolveRulerOriginBoard(
  activeBoard: RulerOriginBoardLike | null,
): { x: number; y: number } {
  if (activeBoard && activeBoard.frames.length === 1) {
    const [frame] = activeBoard.frames
    return { x: frame.x, y: frame.y }
  }
  return { x: 0, y: 0 }
}

/** Which ruler a gesture started on. Named by the ruler's own orientation, which is also the orientation of the guide it produces. */
export type RulerOrientation = 'horizontal' | 'vertical'

/**
 * The `BoardGuide.axis` a guide dragged out of `ruler` must have.
 *
 * A ruler produces a guide PARALLEL to itself, dragged perpendicular to
 * itself: you pull a horizontal line DOWN out of the top ruler, and a vertical
 * line RIGHT out of the left one. That is the Figma/Sketch/Illustrator
 * convention and the only mapping that matches the gesture.
 *
 * In `BoardGuide`'s vocabulary a horizontal line is `axis: 'y'` (it is
 * positioned by a board Y) and a vertical line is `axis: 'x'`. So the
 * horizontal ruler yields `'y'` and the vertical ruler yields `'x'` — which
 * reads backwards at a glance, and is exactly why this is a named function
 * with a test rather than two inline literals at the call site. It was wired
 * the other way round once, and every guide came out perpendicular to the
 * ruler it was dragged from.
 *
 * Note this is deliberately NOT the axis a ruler PAINTS: the horizontal ruler
 * measures the x axis (its ticks are x positions) while creating y guides. Two
 * different questions.
 */
export function guideAxisForRuler(ruler: RulerOrientation): 'x' | 'y' {
  return ruler === 'horizontal' ? 'y' : 'x'
}
