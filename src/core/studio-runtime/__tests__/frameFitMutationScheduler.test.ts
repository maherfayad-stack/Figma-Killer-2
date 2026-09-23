/**
 * frameFitMutationScheduler — the classify + debounce logic behind
 * `useIframeFrameAutoHeight`'s per-mutation fit reset. Uses an injected
 * manual timer (no real `setTimeout` wait, no flakiness) so a "burst of N
 * keystrokes" is expressed as N synchronous `handle()` calls followed by an
 * explicit `flush()`.
 */
import { describe, expect, it } from 'bun:test'
import {
  createFrameFitMutationScheduler,
  FRAME_FIT_TEXT_MUTATION_DEBOUNCE_MS,
  LIVE_FRAME_FIT_STRUCTURAL_DEBOUNCE_MS,
  type FrameFitMutationSchedulerOptions,
} from '../frameFitMutationScheduler'
import { SELECTION_OVERLAY_ROOT_ID } from '../selectionChromeCss'

/**
 * Records shaped like the real thing: a target node and added/removed node
 * lists, because the scheduler now asks WHAT was mutated (selection chrome
 * or page content), not only which kind of record it is.
 */
function pageContent(): HTMLElement {
  const main = document.createElement('main')
  document.body.appendChild(main)
  return main
}

function record(init: Partial<MutationRecord> & Pick<MutationRecord, 'type' | 'target'>): MutationRecord {
  return {
    addedNodes: [] as unknown as NodeList,
    removedNodes: [] as unknown as NodeList,
    attributeName: null,
    ...init,
  } as MutationRecord
}

function characterDataRecord(): MutationRecord {
  const text = document.createTextNode('typed')
  pageContent().appendChild(text)
  return record({ type: 'characterData', target: text })
}

function childListRecord(): MutationRecord {
  const added = document.createElement('section')
  return record({ type: 'childList', target: pageContent(), addedNodes: [added] as unknown as NodeList })
}

/** The in-frame overlay root, as `CanvasSelectionOverlayInjector` / the live runtime create it. */
function overlayRoot(): HTMLElement {
  let root = document.getElementById(SELECTION_OVERLAY_ROOT_ID)
  if (!root) {
    root = document.createElement('div')
    root.id = SELECTION_OVERLAY_ROOT_ID
    document.body.appendChild(root)
  }
  return root
}

/** A hover ring mounting in the overlay root — what every hover crossing used to produce. */
function hoverRingMountRecord(): MutationRecord {
  const ring = document.createElement('div')
  ring.setAttribute('data-canvas-hover-ring', 'true')
  return record({ type: 'childList', target: overlayRoot(), addedNodes: [ring] as unknown as NodeList })
}

/** Portal-frame options: text debounced, structure immediate. */
function portalOptions(
  timer: ReturnType<typeof createManualTimer>,
  onSettle: () => void,
  debounceMs = FRAME_FIT_TEXT_MUTATION_DEBOUNCE_MS,
): FrameFitMutationSchedulerOptions {
  return {
    onSettle,
    textDebounceMs: debounceMs,
    structuralDebounceMs: 0,
    setTimeoutFn: timer.setTimeoutFn,
    clearTimeoutFn: timer.clearTimeoutFn,
  }
}

/** A controllable fake timer: `setTimeoutFn`/`clearTimeoutFn` never fire on
 * their own — the test decides when (`flush()`), so the assertions are about
 * CALL COUNTS and SCHEDULING, not wall-clock timing. */
function createManualTimer() {
  let nextId = 1
  const pending = new Map<number, { cb: () => void; delay: number }>()

  const setTimeoutFn = ((cb: () => void, delay?: number) => {
    const id = nextId++
    pending.set(id, { cb, delay: delay ?? 0 })
    return id as unknown as ReturnType<typeof setTimeout>
  }) as typeof setTimeout

  const clearTimeoutFn = ((id: unknown) => {
    pending.delete(id as number)
  }) as typeof clearTimeout

  return {
    setTimeoutFn,
    clearTimeoutFn,
    pendingCount: () => pending.size,
    pendingDelays: () => [...pending.values()].map((entry) => entry.delay),
    /** Runs every currently-pending callback (mirrors letting a real timer elapse). */
    flush() {
      const callbacks = [...pending.values()].map((entry) => entry.cb)
      pending.clear()
      for (const cb of callbacks) cb()
    },
  }
}

describe('createFrameFitMutationScheduler', () => {
  it('debounces a burst of text-only (characterData) mutations into exactly one settle', () => {
    const timer = createManualTimer()
    let settleCount = 0
    const scheduler = createFrameFitMutationScheduler({
      onSettle: () => {
        settleCount += 1
      },
      textDebounceMs: FRAME_FIT_TEXT_MUTATION_DEBOUNCE_MS,
      structuralDebounceMs: 0,
      setTimeoutFn: timer.setTimeoutFn,
      clearTimeoutFn: timer.clearTimeoutFn,
    })

    // Simulate 30 keystrokes: 30 separate MutationObserver callback firings,
    // each carrying exactly one characterData record (contentEditable
    // "plaintext-only" — one native text mutation per keystroke).
    for (let i = 0; i < 30; i += 1) {
      scheduler.handle([characterDataRecord()])
    }

    // Nothing has settled yet — still debounced, waiting on the typing pause.
    expect(settleCount).toBe(0)
    expect(timer.pendingCount()).toBe(1)

    timer.flush()

    // The whole 30-keystroke burst collapsed into ONE settle, not 30 — this
    // is the fix: `collectScrollDeficits`'s O(all elements) forced-reflow
    // scan (invoked inside `onSettle` → `scheduleMeasure` → `measure` in the
    // real hook) no longer runs once per character.
    expect(settleCount).toBe(1)
  })

  it('reschedules the debounce timer on every new text-only mutation (each keystroke restarts the pause window)', () => {
    const timer = createManualTimer()
    let settleCount = 0
    const scheduler = createFrameFitMutationScheduler({
      onSettle: () => {
        settleCount += 1
      },
      textDebounceMs: 200,
      structuralDebounceMs: 0,
      setTimeoutFn: timer.setTimeoutFn,
      clearTimeoutFn: timer.clearTimeoutFn,
    })

    scheduler.handle([characterDataRecord()])
    const firstPending = timer.pendingCount()
    scheduler.handle([characterDataRecord()])
    const secondPending = timer.pendingCount()

    // Never more than one pending timer — each new keystroke cancels the
    // previous one rather than stacking up.
    expect(firstPending).toBe(1)
    expect(secondPending).toBe(1)
    expect(settleCount).toBe(0)
  })

  it('settles a structural (childList) mutation immediately, with no debounce', () => {
    const timer = createManualTimer()
    let settleCount = 0
    const scheduler = createFrameFitMutationScheduler({
      onSettle: () => {
        settleCount += 1
      },
      textDebounceMs: FRAME_FIT_TEXT_MUTATION_DEBOUNCE_MS,
      structuralDebounceMs: 0,
      setTimeoutFn: timer.setTimeoutFn,
      clearTimeoutFn: timer.clearTimeoutFn,
    })

    scheduler.handle([childListRecord()])

    expect(settleCount).toBe(1)
    expect(timer.pendingCount()).toBe(0)
  })

  it('a structural mutation mid-burst cancels the pending text-only debounce and settles right away', () => {
    const timer = createManualTimer()
    const settleOrder: string[] = []
    const scheduler = createFrameFitMutationScheduler({
      onSettle: () => settleOrder.push('settle'),
      textDebounceMs: FRAME_FIT_TEXT_MUTATION_DEBOUNCE_MS,
      structuralDebounceMs: 0,
      setTimeoutFn: timer.setTimeoutFn,
      clearTimeoutFn: timer.clearTimeoutFn,
    })

    scheduler.handle([characterDataRecord()])
    expect(timer.pendingCount()).toBe(1)

    // A node is deleted mid-typing-burst (e.g. Cmd+Z, or a structural
    // codemod write lands) — must settle NOW, not wait out the stale
    // debounce window with content that's already gone.
    scheduler.handle([childListRecord()])

    expect(settleOrder).toEqual(['settle'])
    expect(timer.pendingCount()).toBe(0)

    // Flushing afterward must not double-settle from the (already-cancelled)
    // debounce.
    timer.flush()
    expect(settleOrder).toEqual(['settle'])
  })

  it('a mixed-record batch containing any childList record is treated as structural', () => {
    const timer = createManualTimer()
    let settleCount = 0
    const scheduler = createFrameFitMutationScheduler({
      onSettle: () => {
        settleCount += 1
      },
      textDebounceMs: FRAME_FIT_TEXT_MUTATION_DEBOUNCE_MS,
      structuralDebounceMs: 0,
      setTimeoutFn: timer.setTimeoutFn,
      clearTimeoutFn: timer.clearTimeoutFn,
    })

    scheduler.handle([characterDataRecord(), childListRecord(), characterDataRecord()])

    expect(settleCount).toBe(1)
    expect(timer.pendingCount()).toBe(0)
  })

  it('dispose() cancels a pending debounced settle', () => {
    const timer = createManualTimer()
    let settleCount = 0
    const scheduler = createFrameFitMutationScheduler({
      onSettle: () => {
        settleCount += 1
      },
      textDebounceMs: FRAME_FIT_TEXT_MUTATION_DEBOUNCE_MS,
      structuralDebounceMs: 0,
      setTimeoutFn: timer.setTimeoutFn,
      clearTimeoutFn: timer.clearTimeoutFn,
    })

    scheduler.handle([characterDataRecord()])
    scheduler.dispose()
    timer.flush()

    // Unmounting the hook (frame collapsed, page switched) mid-debounce must
    // not fire a settle against a torn-down document.
    expect(settleCount).toBe(0)
    expect(timer.pendingCount()).toBe(0)
  })

  it('uses the real global setTimeout/clearTimeout by default (no injection required)', async () => {
    let settled = false
    const scheduler = createFrameFitMutationScheduler({
      onSettle: () => {
        settled = true
      },
      textDebounceMs: 5,
      structuralDebounceMs: 0,
    })

    scheduler.handle([characterDataRecord()])
    expect(settled).toBe(false)

    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(settled).toBe(true)
  })
})

describe('createFrameFitMutationScheduler — what is never content (PERF-2, PERF-9)', () => {
  it('a hover ring mounting in the overlay root neither settles nor schedules a settle (PERF-2)', () => {
    const timer = createManualTimer()
    let settleCount = 0
    const scheduler = createFrameFitMutationScheduler(portalOptions(timer, () => (settleCount += 1)))

    scheduler.handle([hoverRingMountRecord()])

    expect(settleCount).toBe(0)
    expect(timer.pendingCount()).toBe(0)
  })

  it('the overlay root itself being appended to <body> is chrome too', () => {
    const timer = createManualTimer()
    let settleCount = 0
    const scheduler = createFrameFitMutationScheduler(portalOptions(timer, () => (settleCount += 1)))
    const root = document.createElement('div')
    root.id = SELECTION_OVERLAY_ROOT_ID

    scheduler.handle([record({ type: 'childList', target: document.body, addedNodes: [root] as unknown as NodeList })])

    expect(settleCount).toBe(0)
  })

  it('a chrome-only batch does not cancel a pending text-edit settle', () => {
    const timer = createManualTimer()
    let settleCount = 0
    const scheduler = createFrameFitMutationScheduler(portalOptions(timer, () => (settleCount += 1)))

    scheduler.handle([characterDataRecord()])
    scheduler.handle([hoverRingMountRecord()])
    expect(timer.pendingCount()).toBe(1)
    timer.flush()

    expect(settleCount).toBe(1)
  })

  it('a batch mixing chrome with real content is still content', () => {
    const timer = createManualTimer()
    let settleCount = 0
    const scheduler = createFrameFitMutationScheduler(portalOptions(timer, () => (settleCount += 1)))

    scheduler.handle([hoverRingMountRecord(), childListRecord()])

    expect(settleCount).toBe(1)
  })

  it('an attribute-only batch never resets the fit — a JS-animated app writes style every frame (PERF-9)', () => {
    const timer = createManualTimer()
    let settleCount = 0
    const scheduler = createFrameFitMutationScheduler({
      ...portalOptions(timer, () => (settleCount += 1)),
      structuralDebounceMs: LIVE_FRAME_FIT_STRUCTURAL_DEBOUNCE_MS,
    })

    for (let frame = 0; frame < 60; frame += 1) {
      scheduler.handle([record({ type: 'attributes', target: pageContent(), attributeName: 'style' })])
    }

    expect(settleCount).toBe(0)
    expect(timer.pendingCount()).toBe(0)
  })

  it('a live frame debounces structural churn into one trailing settle (PERF-9)', () => {
    const timer = createManualTimer()
    let settleCount = 0
    const scheduler = createFrameFitMutationScheduler({
      ...portalOptions(timer, () => (settleCount += 1)),
      structuralDebounceMs: LIVE_FRAME_FIT_STRUCTURAL_DEBOUNCE_MS,
    })

    for (let frame = 0; frame < 30; frame += 1) scheduler.handle([childListRecord()])

    expect(settleCount).toBe(0)
    expect(timer.pendingDelays()).toEqual([LIVE_FRAME_FIT_STRUCTURAL_DEBOUNCE_MS])
    timer.flush()
    expect(settleCount).toBe(1)
  })
})
