/**
 * A store write that changes nothing notifies nobody (P6-C, PERF-11).
 *
 * Every mounted `NodeRenderer` subscribes to the editor store, so one
 * notification runs thousands of selectors on a large board — a canvas click
 * used to make two writes that changed nothing, each paying that sweep before
 * the selection ring painted. `skipUnchangedSets` drops an object partial whose
 * values are all current; a real change still notifies exactly once.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import { partialChangesNothing } from '@site/store/skipUnchangedSets'

let unsubscribe: (() => void) | null = null
afterEach(() => {
  unsubscribe?.()
  unsubscribe = null
  useEditorStore.getState().setFocusedPanel('canvas')
})

function countNotifications(): () => number {
  let count = 0
  unsubscribe = useEditorStore.subscribe(() => {
    count += 1
  })
  return () => count
}

describe('skipUnchangedSets', () => {
  it('an object write whose values are all current notifies nobody', () => {
    useEditorStore.getState().setFocusedPanel('canvas')
    const notifications = countNotifications()
    useEditorStore.getState().setFocusedPanel('canvas')
    useEditorStore.setState({ focusedPanel: 'canvas' })
    expect(notifications()).toBe(0)
  })

  it('a real change still notifies, once', () => {
    useEditorStore.getState().setFocusedPanel('canvas')
    const notifications = countNotifications()
    const before = useEditorStore.getState()
    useEditorStore.getState().setFocusedPanel('properties')
    expect(notifications()).toBe(1)
    expect(useEditorStore.getState().focusedPanel).toBe('properties')
    expect(useEditorStore.getState()).not.toBe(before)
  })

  it('compares by identity: an equal but new object is a change', () => {
    const items = ['a']
    expect(partialChangesNothing({ items }, { items })).toBe(true)
    expect(partialChangesNothing({ items }, { items: ['a'] })).toBe(false)
    expect(partialChangesNothing({ a: 1, b: 2 }, { a: 1 })).toBe(true)
    expect(partialChangesNothing({ a: Number.NaN }, { a: Number.NaN })).toBe(true)
  })
})
