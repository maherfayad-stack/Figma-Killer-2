import { describe, it, expect } from 'bun:test'
import {
  CANVAS_TRANSFORM_LAYER_OFFSET_PX,
  MIN_TICK_SPACING_PX,
  TICK_STEP_LADDER,
  boardToScreen,
  screenToBoard,
  niceTickStep,
  computeRulerTicks,
  resolveRulerOriginBoard,
} from '../rulerGeometry'

describe('rulerGeometry', () => {
  // ── Landmine #1 regression: the 80px offset ──────────────────────────────
  describe('CANVAS_TRANSFORM_LAYER_OFFSET_PX pinning', () => {
    it('is 80 — matches CanvasTransformLayer.module.css top/left', () => {
      // If this ever fails, CanvasTransformLayer.module.css's `.transformLayer`
      // top/left changed and this constant must change with it (see this
      // module's doc for why the ruler math needs the same number).
      expect(CANVAS_TRANSFORM_LAYER_OFFSET_PX).toBe(80)
    })

    it('boardToScreen(0, 1, 0) is exactly the 80px offset, not 0', () => {
      // The naive `frameVirtualization.ts`-style formula (board*zoom + pan)
      // would return 0 here. The correct ruler-space answer is 80.
      expect(boardToScreen(0, 1, 0)).toBe(80)
    })

    it('screenToBoard(80, 1, 0) is exactly board 0', () => {
      expect(screenToBoard(80, 1, 0)).toBe(0)
    })
  })

  // ── boardToScreen / screenToBoard round-trip ─────────────────────────────
  describe('boardToScreen / screenToBoard round-trip', () => {
    const cases: Array<{ board: number; zoom: number; pan: number }> = [
      { board: 0, zoom: 1, pan: 0 },
      { board: 100, zoom: 0.5, pan: 200 },
      { board: -350, zoom: 2, pan: -120 },
      { board: 1024, zoom: 0.1, pan: 4000 },
      { board: -8000, zoom: 4, pan: -900 },
    ]

    for (const { board, zoom, pan } of cases) {
      it(`round-trips board=${board} zoom=${zoom} pan=${pan}`, () => {
        const screen = boardToScreen(board, zoom, pan)
        expect(screenToBoard(screen, zoom, pan)).toBeCloseTo(board, 9)
      })
    }

    it('boardToScreen matches the documented formula exactly', () => {
      // screen = board * zoom + pan + offset
      expect(boardToScreen(50, 2, 10)).toBe(50 * 2 + 10 + CANVAS_TRANSFORM_LAYER_OFFSET_PX)
    })
  })

  // ── Tick ladder selection across zoom decades ────────────────────────────
  describe('niceTickStep', () => {
    it('picks the smallest ladder step whose on-screen spacing clears MIN_TICK_SPACING_PX', () => {
      for (const zoom of [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 8]) {
        const step = niceTickStep(zoom)
        expect(TICK_STEP_LADDER).toContain(step as (typeof TICK_STEP_LADDER)[number])
        // The chosen step must clear the minimum spacing...
        expect(step * zoom).toBeGreaterThanOrEqual(MIN_TICK_SPACING_PX - 1e-9)
        // ...and be the SMALLEST ladder entry that does, unless nothing does
        // (extreme zoom-out), in which case it must be the ladder's max.
        const smallerStepClears = TICK_STEP_LADDER.some(
          (candidate) => candidate < step && candidate * zoom >= MIN_TICK_SPACING_PX,
        )
        expect(smallerStepClears).toBe(false)
      }
    })

    it('falls back to the ladder max at extreme zoom-out, even below the minimum spacing', () => {
      // zoom=0.05: even the largest ladder step (1000) only spans 50px on
      // screen — below MIN_TICK_SPACING_PX (60) — but the function still
      // returns it rather than returning nothing (see this function's doc).
      const step = niceTickStep(0.05)
      expect(step).toBe(TICK_STEP_LADDER[TICK_STEP_LADDER.length - 1])
      expect(step * 0.05).toBeLessThan(MIN_TICK_SPACING_PX)
    })

    it('at 100% zoom, 100 board units span >= 60px, so step is 100 or smaller candidate that clears', () => {
      // zoom=1: candidates clearing 60px are step >= 60 -> smallest ladder
      // entry >= 60 is 100.
      expect(niceTickStep(1)).toBe(100)
    })

    it('at 400% zoom (max), a much smaller step already clears 60px', () => {
      // zoom=4: need step*4 >= 60 -> step >= 15 -> smallest ladder entry is 25.
      expect(niceTickStep(4)).toBe(25)
    })

    it('at 10% zoom (min), falls back toward the large end of the ladder', () => {
      // zoom=0.1: need step*0.1 >= 60 -> step >= 600 -> smallest ladder entry is 1000.
      expect(niceTickStep(0.1)).toBe(1000)
    })

    it('never returns a step below MIN_TICK_SPACING_PX/zoom when the ladder can satisfy it', () => {
      for (const zoom of [0.1, 0.5, 1, 2, 4]) {
        const step = niceTickStep(zoom)
        if (step !== TICK_STEP_LADDER[TICK_STEP_LADDER.length - 1]) {
          expect(step * zoom).toBeGreaterThanOrEqual(MIN_TICK_SPACING_PX)
        }
      }
    })
  })

  // ── computeRulerTicks ─────────────────────────────────────────────────────
  describe('computeRulerTicks', () => {
    it('produces ticks covering the visible viewport at 100% zoom, origin 0', () => {
      const ticks = computeRulerTicks({ viewportLengthPx: 800, zoom: 1, pan: 0, originBoard: 0 })
      expect(ticks.length).toBeGreaterThan(0)
      // Every tick's screenPos, converted back to board space, matches its label value.
      for (const tick of ticks) {
        expect(screenToBoard(tick.screenPos, 1, 0)).toBeCloseTo(tick.value, 9)
      }
      // Ticks are evenly spaced by the nice step.
      const step = niceTickStep(1)
      for (let i = 1; i < ticks.length; i++) {
        expect(ticks[i].value - ticks[i - 1].value).toBeCloseTo(step, 9)
      }
    })

    it('labels relative to originBoard, not the raw board coordinate', () => {
      const originBoard = 500
      const ticks = computeRulerTicks({ viewportLengthPx: 800, zoom: 1, pan: -500 - CANVAS_TRANSFORM_LAYER_OFFSET_PX, originBoard })
      // With pan chosen so board 500 (== originBoard) sits at screen 0, the
      // first on-screen tick's label should read at/near 0, not 500.
      const nearZero = ticks.find((t) => Math.abs(t.value) < 1e-6)
      expect(nearZero).toBeDefined()
    })

    it('returns [] for non-finite or zero zoom rather than dividing by zero', () => {
      expect(computeRulerTicks({ viewportLengthPx: 800, zoom: 0, pan: 0, originBoard: 0 })).toEqual([])
      expect(computeRulerTicks({ viewportLengthPx: 800, zoom: Number.NaN, pan: 0, originBoard: 0 })).toEqual([])
    })
  })

  // ── resolveRulerOriginBoard ───────────────────────────────────────────────
  describe('resolveRulerOriginBoard', () => {
    it('is board (0,0) with no active board', () => {
      expect(resolveRulerOriginBoard(null)).toEqual({ x: 0, y: 0 })
    })

    it('is board (0,0) with multiple frames', () => {
      expect(
        resolveRulerOriginBoard({ frames: [{ x: 10, y: 20 }, { x: 500, y: 500 }] }),
      ).toEqual({ x: 0, y: 0 })
    })

    it('is board (0,0) with zero frames', () => {
      expect(resolveRulerOriginBoard({ frames: [] })).toEqual({ x: 0, y: 0 })
    })

    it('shifts to the single frame\'s own (x, y) when exactly one frame is active', () => {
      expect(resolveRulerOriginBoard({ frames: [{ x: 340, y: -120 }] })).toEqual({ x: 340, y: -120 })
    })
  })
})
