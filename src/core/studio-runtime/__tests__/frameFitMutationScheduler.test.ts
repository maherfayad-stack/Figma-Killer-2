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
} from '../frameFitMutationScheduler'

function characterDataRecord(): MutationRecord {
  return { type: 'characterData' } as MutationRecord
}

function childListRecord(): MutationRecord {
  return { type: 'childList' } as MutationRecord
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
      debounceMs: FRAME_FIT_TEXT_MUTATION_DEBOUNCE_MS,
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
      debounceMs: 200,
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
      debounceMs: FRAME_FIT_TEXT_MUTATION_DEBOUNCE_MS,
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
      debounceMs: FRAME_FIT_TEXT_MUTATION_DEBOUNCE_MS,
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
      debounceMs: FRAME_FIT_TEXT_MUTATION_DEBOUNCE_MS,
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
      debounceMs: FRAME_FIT_TEXT_MUTATION_DEBOUNCE_MS,
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
      debounceMs: 5,
    })

    scheduler.handle([characterDataRecord()])
    expect(settled).toBe(false)

    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(settled).toBe(true)
  })
})
