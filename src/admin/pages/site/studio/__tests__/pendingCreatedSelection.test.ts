/**
 * `store-13` — the one-slot handoff between a structural source write and the
 * board re-read that brings its result in.
 *
 * Three properties, each of which is a defect if it goes: an empty answer
 * CLEARS the slot (so a move cannot inherit the copy a duplicate left there),
 * the slot is claimed exactly once (so an unrelated later reload does not
 * re-apply it), and a stale answer expires rather than being applied late.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import {
  clearPendingCreatedSelection,
  setPendingCreatedSelection,
  takePendingCreatedSelection,
} from '../pendingCreatedSelection'

afterEach(() => {
  clearPendingCreatedSelection()
})

describe('pendingCreatedSelection', () => {
  it('hands back exactly what the write created', () => {
    setPendingCreatedSelection(['pages/Home.tsx:6:7'])
    expect(takePendingCreatedSelection()).toEqual(['pages/Home.tsx:6:7'])
  })

  it('is claimed once — a second re-read gets nothing', () => {
    setPendingCreatedSelection(['pages/Home.tsx:6:7'])
    takePendingCreatedSelection()
    expect(takePendingCreatedSelection()).toEqual([])
  })

  it('an empty answer clears whatever was waiting', () => {
    setPendingCreatedSelection(['pages/Home.tsx:6:7'])
    // The next landed write — a move, say — created nothing.
    setPendingCreatedSelection([])
    expect(takePendingCreatedSelection()).toEqual([])
  })

  it('the last gesture wins when two are parked', () => {
    setPendingCreatedSelection(['pages/Home.tsx:6:7'])
    setPendingCreatedSelection(['pages/Home.tsx:9:7'])
    expect(takePendingCreatedSelection()).toEqual(['pages/Home.tsx:9:7'])
  })

  it('expires rather than acting on an unrelated reload much later', () => {
    const now = 1_000_000
    setPendingCreatedSelection(['pages/Home.tsx:6:7'], now)
    expect(takePendingCreatedSelection(now + 60_000)).toEqual([])
  })

  it('is still claimable while the resync is merely slow', () => {
    const now = 1_000_000
    setPendingCreatedSelection(['pages/Home.tsx:6:7'], now)
    expect(takePendingCreatedSelection(now + 5_000)).toEqual(['pages/Home.tsx:6:7'])
  })

  it('does not copy the caller’s array by reference', () => {
    const ids = ['pages/Home.tsx:6:7']
    setPendingCreatedSelection(ids)
    ids.push('pages/Home.tsx:9:7')
    expect(takePendingCreatedSelection()).toEqual(['pages/Home.tsx:6:7'])
  })
})
