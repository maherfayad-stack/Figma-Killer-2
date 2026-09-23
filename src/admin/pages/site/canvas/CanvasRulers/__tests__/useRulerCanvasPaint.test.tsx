/**
 * PERF-4 — the rulers paint on change, and an idle board runs no ruler loop.
 *
 * The rulers used to repaint from a permanent `requestAnimationFrame` loop
 * each (two 60 Hz loops, forever, each forcing a layout read). The contract
 * now: zero animation frames requested at rest, one paint per transform write
 * (in the same task — no frame of lag), and a repaint when the ruler resizes.
 *
 * Paints are counted at `getContext('2d')`, which `paint()` reaches only after
 * its "did anything change" check passes.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, render } from '@testing-library/react'
import { useRef } from 'react'
import type { CanvasTransform } from '@site/hooks/useCanvas'
import { CANVAS_VIEWPORT_IDLE_MS, markCanvasViewportActivity } from '@site/canvas/canvasViewportActivity'
import { RulerH } from '../RulerH'

let rafRequests = 0
let paints = 0
const realRaf = globalThis.requestAnimationFrame
/** happy-dom's canvas prototype — it does not expose `HTMLCanvasElement` as a global. */
const canvasPrototype = Object.getPrototypeOf(document.createElement('canvas')) as HTMLCanvasElement
const realGetContext = canvasPrototype.getContext
const liveTransform: CanvasTransform = { zoom: 1, panX: 0, panY: 0 }

function Harness() {
  const lengthSourceRef = useRef<HTMLDivElement | null>(null)
  const transformRef = useRef<CanvasTransform>(liveTransform)
  return (
    <div
      ref={(el) => {
        if (el) Object.defineProperty(el, 'offsetWidth', { configurable: true, get: () => 800 })
        lengthSourceRef.current = el
      }}
    >
      <RulerH lengthSourceRef={lengthSourceRef} transformRef={transformRef} originBoardX={0} />
    </div>
  )
}

beforeEach(() => {
  rafRequests = 0
  paints = 0
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    rafRequests += 1
    return realRaf(callback)
  }) as typeof globalThis.requestAnimationFrame
  canvasPrototype.getContext = function getContext() {
    paints += 1
    return null
  } as typeof canvasPrototype.getContext
})

afterEach(async () => {
  cleanup()
  globalThis.requestAnimationFrame = realRaf
  canvasPrototype.getContext = realGetContext
  // `markCanvasViewportActivity` arms a module-level idle timer; let it lapse
  // so the next file in this worker starts from an idle viewport.
  await Bun.sleep(CANVAS_VIEWPORT_IDLE_MS + 20)
})

describe('useRulerCanvasPaint (PERF-4)', () => {
  it('paints once on mount and requests no animation frame while the board is idle', async () => {
    render(<Harness />)
    expect(paints).toBe(1)
    await Bun.sleep(100)
    expect(rafRequests).toBe(0)
    expect(paints).toBe(1)
  })

  it('repaints synchronously on every transform write, and not for an identical one', () => {
    render(<Harness />)
    const before = paints

    liveTransform.panX += 40
    markCanvasViewportActivity()
    expect(paints).toBe(before + 1)

    markCanvasViewportActivity()
    expect(paints).toBe(before + 1)

    liveTransform.zoom = 2
    markCanvasViewportActivity()
    expect(paints).toBe(before + 2)
    expect(rafRequests).toBe(0)
    liveTransform.zoom = 1
    liveTransform.panX = 0
  })
})
