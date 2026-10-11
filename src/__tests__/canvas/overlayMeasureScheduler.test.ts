/**
 * S4 — the selection overlay measures on events, not every frame.
 *
 * The acceptance criterion for this work order is a number: an idle board with
 * a live selection must run ZERO `requestAnimationFrame` callbacks per second,
 * per frame. The old design ran one loop per mounted frame for as long as
 * anything was selected or hovered, so eight frames and one selected node kept
 * eight 60 Hz loops alive over a canvas nobody was touching.
 *
 * A fake rAF is the only honest way to assert that: "did the main thread get to
 * sleep" is not observable from a mounted-component test, but "how many times
 * did the scheduler run after it settled" is exactly this number.
 *
 * Every assertion is on the MEASURE COUNT, never on the fake queue's depth.
 * `bun test` runs several files per worker process without isolating globals
 * (see `bunfig.toml`), so an earlier file's still-mounted component can have
 * frames sitting in the queue this file installs — and the invariant under test
 * is "this scheduler asked for no frame", which "flushing N frames ran my
 * measure 0 more times" states exactly and queue depth states only by accident.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { beginCanvasGesture, endCanvasGesture, isCanvasGestureActive } from '@site/canvas/canvasGesture'
import {
  CANVAS_VIEWPORT_IDLE_MS,
  isCanvasViewportActive,
  markCanvasViewportActivity,
} from '@site/canvas/canvasViewportActivity'
import { createOverlayMeasureScheduler, type OverlayMeasureScheduler } from '@site/canvas/overlayMeasureScheduler'

interface FakeRaf {
  /** Run `count` animation frames (each may queue the next). */
  flush(count?: number): void
  restore(): void
}

function installFakeRaf(): FakeRaf {
  const realRequest = globalThis.requestAnimationFrame
  const realCancel = globalThis.cancelAnimationFrame
  let nextHandle = 1
  const queue = new Map<number, FrameRequestCallback>()

  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    const handle = nextHandle++
    queue.set(handle, callback)
    return handle
  }) as typeof globalThis.requestAnimationFrame
  globalThis.cancelAnimationFrame = ((handle: number) => {
    queue.delete(handle)
  }) as typeof globalThis.cancelAnimationFrame

  return {
    flush: (count = 1) => {
      for (let i = 0; i < count; i++) {
        const due = [...queue.entries()]
        queue.clear()
        for (const [, callback] of due) callback(0)
      }
    },
    restore: () => {
      globalThis.requestAnimationFrame = realRequest
      globalThis.cancelAnimationFrame = realCancel
    },
  }
}

let raf: FakeRaf | null = null
let scheduler: OverlayMeasureScheduler | null = null

function createScheduler(options: { continuous?: boolean; ringsFollowViewport?: boolean } = {}) {
  let measures = 0
  let anchorInvalidations = 0
  scheduler = createOverlayMeasureScheduler({
    // No iframe: the document-level observers are portal-mode only and resolve
    // to nothing here, which is exactly the shape this suite wants — it is
    // asserting the rAF discipline, not the observers.
    iframeElement: null,
    ringsFollowViewport: options.ringsFollowViewport ?? false,
    measure: () => {
      measures++
    },
    invalidateAnchor: () => {
      anchorInvalidations++
    },
    continuous: options.continuous ?? false,
  })
  return {
    scheduler: scheduler!,
    measures: () => measures,
    anchorInvalidations: () => anchorInvalidations,
  }
}

/**
 * Both continuous-gesture flags are MODULE state, shared by every test file in
 * this worker process (`bunfig.toml`: no `--isolate`). A neighbouring file that
 * left a gesture open, or whose canvas wrote one transform on the way out,
 * would arm a scheduler at construction — and every assertion here is about a
 * scheduler that is NOT armed. Quiesce both, then assert it took.
 */
beforeEach(async () => {
  endCanvasGesture(beginCanvasGesture())
  if (isCanvasViewportActive()) await Bun.sleep(CANVAS_VIEWPORT_IDLE_MS + 25)
  expect(isCanvasGestureActive()).toBe(false)
  expect(isCanvasViewportActive()).toBe(false)
})

afterEach(() => {
  scheduler?.dispose()
  scheduler = null
  raf?.restore()
  raf = null
})

describe('overlay measure scheduler — rAF discipline', () => {
  it('measures once and then runs NO further passes when nothing is moving', () => {
    raf = installFakeRaf()
    const s = createScheduler()

    // One pass for the state that made the scheduler exist (a fresh selection).
    raf.flush()
    expect(s.measures()).toBe(1)

    // THE assertion: an idle board with a live selection is 0 rAF/s. Ten more
    // frames go by and the scheduler is in none of them.
    raf.flush(10)
    expect(s.measures()).toBe(1)
  })

  it('coalesces repeated schedule() calls into a single pass', () => {
    raf = installFakeRaf()
    const s = createScheduler()
    raf.flush()
    expect(s.measures()).toBe(1)

    s.scheduler.schedule()
    s.scheduler.schedule()
    s.scheduler.schedule()
    raf.flush()
    expect(s.measures()).toBe(2)
    raf.flush(5)
    expect(s.measures()).toBe(2)
  })

  it('runs a continuous loop while render state says a gesture is in flight', () => {
    raf = installFakeRaf()
    const s = createScheduler({ continuous: true })

    raf.flush(5)
    expect(s.measures()).toBe(5)
    // Still armed — this is the one case a per-frame loop is correct.
    raf.flush(3)
    expect(s.measures()).toBe(8)
  })

  it('arms on a page-mutating gesture and stands down — with one settle pass — when it ends', () => {
    raf = installFakeRaf()
    const s = createScheduler()
    raf.flush(3)
    expect(s.measures()).toBe(1)

    const token = beginCanvasGesture()
    raf.flush(4)
    expect(s.measures()).toBe(5)

    endCanvasGesture(token)
    // Exactly one more pass: geometry was deliberately not recomputed during
    // the gesture, so the settle measurement is not optional — but it is one.
    raf.flush(3)
    expect(s.measures()).toBe(6)
  })

  it('parent-document rings: arms on a pan/zoom transform write and stands down when the viewport goes idle', async () => {
    raf = installFakeRaf()
    const s = createScheduler()
    raf.flush(3)
    const settled = s.measures()

    markCanvasViewportActivity()
    raf.flush(3)
    expect(s.measures()).toBe(settled + 3)

    // The flag self-clears on an idle timer — "the pan ended" is an event, not
    // something every consumer has to discover by polling.
    await Bun.sleep(250)
    raf.flush(1) // the settle pass the idle transition schedules
    const afterSettle = s.measures()
    raf.flush(5)
    expect(s.measures()).toBe(afterSettle)
  })

  it('in-frame rings (PERF-3): a pan arms NO per-frame pass, then settles once when the viewport goes idle', async () => {
    raf = installFakeRaf()
    const s = createScheduler({ ringsFollowViewport: true })
    raf.flush(3)
    const settled = s.measures()

    // Rings inside the frame move with its CSS transform; the toolbar and
    // inspector follow each transform write arithmetically. Re-measuring the
    // rings every frame of the pan was the wasted work the audit named.
    for (let write = 0; write < 5; write += 1) {
      markCanvasViewportActivity()
      raf.flush(1)
    }
    expect(s.measures()).toBe(settled)

    await Bun.sleep(CANVAS_VIEWPORT_IDLE_MS + 60)
    raf.flush(3)
    expect(s.measures()).toBe(settled + 1)
  })

  it('invalidates the parent-document anchor on a window resize, and measures once', () => {
    raf = installFakeRaf()
    const s = createScheduler()
    raf.flush(3)
    expect(s.anchorInvalidations()).toBe(0)
    expect(s.measures()).toBe(1)

    window.dispatchEvent(new Event('resize'))
    expect(s.anchorInvalidations()).toBe(1)
    raf.flush()
    expect(s.measures()).toBe(2)
    raf.flush(5)
    expect(s.measures()).toBe(2)
  })

  it('stops measuring after dispose, even mid-gesture', () => {
    raf = installFakeRaf()
    const s = createScheduler({ continuous: true })
    raf.flush(2)
    const before = s.measures()

    s.scheduler.dispose()
    scheduler = null
    raf.flush(5)
    expect(s.measures()).toBe(before)
  })
})
