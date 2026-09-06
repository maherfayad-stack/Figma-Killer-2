import { afterEach, describe, expect, it } from 'bun:test'
import {
  __resetToastBusForTests,
  pushToast,
  subscribeToasts,
  type Toast,
} from '@ui/components/Toast/toastBus'

afterEach(() => {
  __resetToastBusForTests()
})

describe('toastBus', () => {
  it('sends the current queue snapshot to new subscribers', () => {
    const id = pushToast({
      kind: 'success',
      title: 'Saved',
      durationMs: null,
    })
    let capturedToasts: ReadonlyArray<Toast> = []

    const unsubscribe = subscribeToasts((snapshot) => {
      capturedToasts = snapshot
    })

    expect(capturedToasts.map((toast) => toast.id)).toEqual([id])
    unsubscribe()
  })

  it('resets queued toasts and listeners for test isolation', () => {
    pushToast({
      kind: 'info',
      title: 'Before reset',
      durationMs: null,
    })
    let staleListenerCalls = 0
    subscribeToasts(() => {
      staleListenerCalls += 1
    })

    __resetToastBusForTests()
    pushToast({
      kind: 'info',
      title: 'After reset',
      durationMs: null,
    })
    let capturedToasts: ReadonlyArray<Toast> = []
    const unsubscribe = subscribeToasts((snapshot) => {
      capturedToasts = snapshot
    })

    expect(staleListenerCalls).toBe(1)
    expect(capturedToasts).toHaveLength(1)
    expect(capturedToasts[0]?.title).toBe('After reset')
    unsubscribe()
  })

  describe('dedupeKey', () => {
    function snapshot(): ReadonlyArray<Toast> {
      let captured: ReadonlyArray<Toast> = []
      const unsubscribe = subscribeToasts((next) => {
        captured = next
      })
      unsubscribe()
      return captured
    }

    it('collapses a repeat onto the toast already showing it, keeping its id', () => {
      const first = pushToast({
        kind: 'warning',
        title: 'Move refused',
        body: 'One piece of source renders every row of this list.',
        dedupeKey: 'structural-refusal:move:list-row',
        durationMs: null,
      })
      const second = pushToast({
        kind: 'warning',
        title: 'Move refused',
        body: 'One piece of source renders every row of this list.',
        dedupeKey: 'structural-refusal:move:list-row',
        durationMs: null,
      })

      expect(second).toBe(first)
      const toasts = snapshot()
      expect(toasts).toHaveLength(1)
      expect(toasts[0]?.repeatCount).toBe(2)
    })

    it('keeps the collapsed toast in its original stack position', () => {
      pushToast({ kind: 'warning', title: 'Refused', dedupeKey: 'refusal', durationMs: null })
      pushToast({ kind: 'success', title: 'Saved', durationMs: null })
      pushToast({ kind: 'warning', title: 'Refused', dedupeKey: 'refusal', durationMs: null })

      expect(snapshot().map((t) => t.title)).toEqual(['Refused', 'Saved'])
    })

    it('leaves toasts without a key stacking as they always did', () => {
      pushToast({ kind: 'error', title: 'Save failed', durationMs: null })
      pushToast({ kind: 'error', title: 'Save failed', durationMs: null })

      const toasts = snapshot()
      expect(toasts).toHaveLength(2)
      expect(toasts.every((t) => t.repeatCount === 1)).toBe(true)
    })

    it('does not collapse two different refusals', () => {
      pushToast({ kind: 'warning', title: 'Move refused', dedupeKey: 'a', durationMs: null })
      pushToast({ kind: 'warning', title: 'Delete refused', dedupeKey: 'b', durationMs: null })

      expect(snapshot()).toHaveLength(2)
    })
  })
})
