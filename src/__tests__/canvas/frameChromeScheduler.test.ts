/**
 * SB-4 — a frame's selection chrome places on events, not every frame.
 *
 * The acceptance criterion carried over from S4 is a number: an idle board with
 * a live selection must run ZERO `requestAnimationFrame` callbacks per second,
 * per frame. A fake rAF is the only honest way to assert that — "did the main
 * thread get to sleep" is not observable from a mounted-component test, but
 * "how many times did the scheduler run after it settled" is exactly this
 * number.
 *
 * Passes are scheduled into a MICROTASK (so they land before the browser paints
 * whatever caused them) and the per-frame loop is a rAF armed only by a hold, so
 * the tests flush both.
 *
 * Every assertion is on the PASS COUNT, never on the fake queue's depth.
 * `bun test` runs several files per worker process without isolating globals
 * (see `bunfig.toml`), so an earlier file's still-mounted component can have
 * frames sitting in the queue this file installs.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { beginCanvasGesture, endCanvasGesture, isCanvasGestureActive } from '@site/canvas/canvasGesture'
import {
  CANVAS_VIEWPORT_IDLE_MS,
  isCanvasViewportActive,
  markCanvasViewportActivity,
} from '@site/canvas/canvasViewportActivity'
import { createFrameChromeScheduler, type FrameChromeScheduler } from '@site/canvas/frameChromeScheduler'
import { registerFrameAdapter, unregisterFrameAdapter } from '@site/canvas/frameAdapter/canvasFrameAdapterRegistry'
import type { FrameDocumentAdapter, Unsubscribe } from '@site/canvas/frameAdapter/FrameDocumentAdapter'

interface FakeRaf {
  /** Run `count` animation frames (each may queue the next), draining microtasks after each. */
  flush(count?: number): Promise<void>
  restore(): void
}

async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve()
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
    flush: async (count = 1) => {
      for (let i = 0; i < count; i++) {
        const due = [...queue.entries()]
        queue.clear()
        for (const [, callback] of due) callback(0)
        await drainMicrotasks()
      }
    },
    restore: () => {
      globalThis.requestAnimationFrame = realRequest
      globalThis.cancelAnimationFrame = realCancel
    },
  }
}

let raf: FakeRaf | null = null
let scheduler: FrameChromeScheduler | null = null

function createScheduler(options: { continuous?: boolean; iframeElement?: HTMLIFrameElement | null; measure?: () => void | Promise<void> } = {}) {
  let passes = 0
  let anchorInvalidations = 0
  scheduler = createFrameChromeScheduler({
    iframeElement: options.iframeElement ?? null,
    measure: () => {
      passes++
      return options.measure?.()
    },
    invalidateAnchor: () => {
      anchorInvalidations++
    },
    continuous: options.continuous ?? false,
  })
  return {
    scheduler: scheduler!,
    passes: () => passes,
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

describe('frame chrome scheduler — rAF discipline', () => {
  it('places once and then runs NO further passes when nothing is moving', async () => {
    raf = installFakeRaf()
    const s = createScheduler()

    // One pass for the state that made the scheduler exist (a fresh selection).
    await raf.flush()
    expect(s.passes()).toBe(1)

    // THE assertion: an idle board with a live selection is 0 rAF/s. Ten more
    // frames go by and the scheduler is in none of them.
    await raf.flush(10)
    expect(s.passes()).toBe(1)
  })

  it('coalesces repeated schedule() calls into a single pass', async () => {
    raf = installFakeRaf()
    const s = createScheduler()
    await raf.flush()
    expect(s.passes()).toBe(1)

    s.scheduler.schedule()
    s.scheduler.schedule()
    s.scheduler.schedule()
    await raf.flush()
    expect(s.passes()).toBe(2)
    await raf.flush(5)
    expect(s.passes()).toBe(2)
  })

  it('lands a pass in a microtask — before the frame that follows the event', async () => {
    raf = installFakeRaf()
    const s = createScheduler()
    await drainMicrotasks()
    expect(s.passes()).toBe(1)

    s.scheduler.schedule()
    expect(s.passes()).toBe(1)
    await drainMicrotasks()
    // No animation frame has run: the pass did not wait for one.
    expect(s.passes()).toBe(2)
  })

  it('runs a continuous loop while render state says a gesture is in flight', async () => {
    raf = installFakeRaf()
    const s = createScheduler({ continuous: true })

    await raf.flush(5)
    // The creation pass, then one per frame.
    expect(s.passes()).toBeGreaterThanOrEqual(5)
    const before = s.passes()
    // Still armed — this is the one case a per-frame loop is correct.
    await raf.flush(3)
    expect(s.passes()).toBe(before + 3)
  })

  it('arms on a page-mutating gesture and stands down — with one settle pass — when it ends', async () => {
    raf = installFakeRaf()
    const s = createScheduler()
    await raf.flush(3)
    expect(s.passes()).toBe(1)

    const token = beginCanvasGesture()
    await raf.flush(4)
    const during = s.passes()
    expect(during).toBeGreaterThanOrEqual(5)

    endCanvasGesture(token)
    // Exactly one more pass: geometry was deliberately not recomputed during
    // the gesture, so the settle measurement is not optional — but it is one.
    await raf.flush(3)
    expect(s.passes()).toBe(during + 1)
  })

  it('a pan arms NO per-frame pass, then settles once when the viewport goes idle (the rings ride the board transform)', async () => {
    raf = installFakeRaf()
    const s = createScheduler()
    await raf.flush(3)
    const settled = s.passes()

    // Chrome in the frame's viewport box moves with its CSS transform; the
    // toolbar and inspector follow each transform write arithmetically.
    // Re-placing the rings every frame of the pan was the wasted work the audit
    // named.
    for (let write = 0; write < 5; write += 1) {
      markCanvasViewportActivity()
      await raf.flush(1)
    }
    expect(s.passes()).toBe(settled)

    await Bun.sleep(CANVAS_VIEWPORT_IDLE_MS + 60)
    await raf.flush(3)
    expect(s.passes()).toBe(settled + 1)
  })

  it('invalidates the parent-document anchor on a window resize, and places once', async () => {
    raf = installFakeRaf()
    const s = createScheduler()
    await raf.flush(3)
    expect(s.anchorInvalidations()).toBe(0)
    expect(s.passes()).toBe(1)

    window.dispatchEvent(new Event('resize'))
    expect(s.anchorInvalidations()).toBe(1)
    await raf.flush()
    expect(s.passes()).toBe(2)
    await raf.flush(5)
    expect(s.passes()).toBe(2)
  })

  it('never overlaps two passes: a request that arrives mid-pass runs once when it finishes', async () => {
    raf = installFakeRaf()
    let release: (() => void) | null = null
    let running = 0
    let maxRunning = 0
    const s = createScheduler({
      measure: () => {
        running++
        maxRunning = Math.max(maxRunning, running)
        return new Promise<void>((resolve) => {
          release = () => {
            running--
            resolve()
          }
        })
      },
    })
    await drainMicrotasks()
    expect(s.passes()).toBe(1)

    s.scheduler.schedule()
    s.scheduler.schedule()
    await drainMicrotasks()
    // The first pass is still out (a bridge frame's round trip): nothing started beside it.
    expect(s.passes()).toBe(1)

    release!()
    await drainMicrotasks()
    expect(s.passes()).toBe(2)
    release!()
    await drainMicrotasks()
    expect(maxRunning).toBe(1)
    expect(s.passes()).toBe(2)
  })

  it('stops placing after dispose, even mid-gesture', async () => {
    raf = installFakeRaf()
    const s = createScheduler({ continuous: true })
    await raf.flush(2)
    const before = s.passes()

    s.scheduler.dispose()
    scheduler = null
    await raf.flush(5)
    expect(s.passes()).toBe(before)
  })
})

describe('frame chrome scheduler — the rect index drives it', () => {
  function fakeAdapter() {
    const handlers = new Set<() => void>()
    const adapter = {
      on: (event: string, handler: () => void): Unsubscribe => {
        if (event === 'geometry:dirty') handlers.add(handler)
        return () => handlers.delete(handler)
      },
    } as unknown as FrameDocumentAdapter
    return { adapter, markDirty: () => [...handlers].forEach((handler) => handler()) }
  }

  it('a geometry:dirty from THIS frame schedules a pass; one from another frame does not', async () => {
    raf = installFakeRaf()
    const mine = document.createElement('iframe')
    const other = document.createElement('iframe')
    document.body.append(mine, other)
    const a = fakeAdapter()
    const b = fakeAdapter()
    registerFrameAdapter(mine, a.adapter, 'studio')
    registerFrameAdapter(other, b.adapter, 'studio')
    try {
      const s = createScheduler({ iframeElement: mine })
      await raf.flush(2)
      expect(s.passes()).toBe(1)

      b.markDirty()
      await raf.flush(2)
      expect(s.passes()).toBe(1)

      a.markDirty()
      await raf.flush(2)
      expect(s.passes()).toBe(2)
    } finally {
      unregisterFrameAdapter(mine)
      unregisterFrameAdapter(other)
      mine.remove()
      other.remove()
    }
  })
})
