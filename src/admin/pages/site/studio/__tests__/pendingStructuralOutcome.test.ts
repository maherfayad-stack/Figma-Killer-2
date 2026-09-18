/**
 * `store-13`/`store-14` — the one-slot handoff between a structural source
 * write and the board re-read that brings its result in.
 *
 * Four properties, each of which is a defect if it goes: an empty answer
 * CLEARS the slot (so a move cannot inherit the copy a duplicate left there),
 * the slot is claimed exactly once (so an unrelated later reload does not
 * re-apply it), a stale answer expires rather than being applied late, and the
 * two answers it carries — what to select, and what ⌘Z should do — travel
 * together so a reload cannot claim one and drop the other.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import {
  clearPendingStructuralOutcome,
  setPendingStructuralOutcome,
  takePendingStructuralOutcome,
  type PendingStructuralHistory,
} from '../pendingStructuralOutcome'

afterEach(() => {
  clearPendingStructuralOutcome()
})

const history: PendingStructuralHistory = {
  kind: 'push',
  gesture: {
    label: 'Duplicate',
    forward: [{ kind: 'duplicate', nodeId: 'pages/Home.tsx:5:5' }],
    inverseTemplate: { kind: 'delete-created' },
    inverse: [{ kind: 'delete', nodeId: 'pages/Home.tsx:6:7' }],
  },
}

describe('pendingStructuralOutcome', () => {
  it('hands back exactly what the write reported', () => {
    setPendingStructuralOutcome({ selectNodeIds: ['pages/Home.tsx:6:7'], history })
    expect(takePendingStructuralOutcome()).toEqual({ selectNodeIds: ['pages/Home.tsx:6:7'], history })
  })

  it('is claimed once — a second re-read gets nothing', () => {
    setPendingStructuralOutcome({ selectNodeIds: ['pages/Home.tsx:6:7'], history })
    takePendingStructuralOutcome()
    expect(takePendingStructuralOutcome()).toBeNull()
  })

  it('an empty answer clears whatever was waiting', () => {
    setPendingStructuralOutcome({ selectNodeIds: ['pages/Home.tsx:6:7'], history })
    // The next landed write — a move with no undo of its own, say — reported
    // nothing at all.
    setPendingStructuralOutcome({ selectNodeIds: [], history: null })
    expect(takePendingStructuralOutcome()).toBeNull()
  })

  it('keeps a history-only answer, which has nothing to select but still has an undo', () => {
    setPendingStructuralOutcome({ selectNodeIds: [], history })
    expect(takePendingStructuralOutcome()).toEqual({ selectNodeIds: [], history })
  })

  it('the last gesture wins when two are parked', () => {
    setPendingStructuralOutcome({ selectNodeIds: ['pages/Home.tsx:6:7'], history: null })
    setPendingStructuralOutcome({ selectNodeIds: ['pages/Home.tsx:9:7'], history: null })
    expect(takePendingStructuralOutcome()?.selectNodeIds).toEqual(['pages/Home.tsx:9:7'])
  })

  it('expires rather than acting on an unrelated reload much later', () => {
    const now = 1_000_000
    setPendingStructuralOutcome({ selectNodeIds: ['pages/Home.tsx:6:7'], history }, now)
    expect(takePendingStructuralOutcome(now + 60_000)).toBeNull()
  })

  it('is still claimable while the resync is merely slow', () => {
    const now = 1_000_000
    setPendingStructuralOutcome({ selectNodeIds: ['pages/Home.tsx:6:7'], history }, now)
    expect(takePendingStructuralOutcome(now + 5_000)?.selectNodeIds).toEqual(['pages/Home.tsx:6:7'])
  })

  it('does not hold the caller’s array by reference', () => {
    const selectNodeIds = ['pages/Home.tsx:6:7']
    setPendingStructuralOutcome({ selectNodeIds, history: null })
    selectNodeIds.push('pages/Home.tsx:9:7')
    expect(takePendingStructuralOutcome()?.selectNodeIds).toEqual(['pages/Home.tsx:6:7'])
  })
})
