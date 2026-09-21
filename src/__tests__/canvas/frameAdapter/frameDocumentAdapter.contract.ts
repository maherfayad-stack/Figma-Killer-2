/**
 * frameDocumentAdapter.contract — the ONE shared conformance suite both
 * `PortalFrameAdapter.test.ts` and `BridgeFrameAdapter.test.ts` import and
 * run against their own harness, so a future third adapter (if one is ever
 * needed) is graded against the same bar. See `STATE.md`'s `live-05` entry.
 *
 * Deliberately NOT itself a `.test.ts` file — it exports a runner
 * (`runFrameDocumentAdapterContract`) that only produces `describe`/`it`
 * blocks once a caller invokes it with a concrete harness; a bare `.test.ts`
 * file with no top-level `describe`/`it` would report a silently-empty 0
 * tests for this file, which is worse than not being discovered as a test
 * file at all. Same "reusable helper under `__tests__/`" convention as
 * `iframeCanvasQuery.ts`.
 *
 * This suite asserts INTERFACE-LEVEL conformance (every method exists,
 * returns the right shape, never throws on a well-formed call, `dispose()`
 * is safe to call more than once) — NOT deep DOM/wire semantic equivalence,
 * which the two adapter-specific test files already cover on their own
 * terms, since the two adapters' actual MECHANISMS are legitimately
 * different (direct DOM mutation vs. a postMessage round trip) even though
 * the CONTRACT is the same.
 */
import { describe, expect, it } from 'bun:test'
import type { FrameDocumentAdapter, NodeRef } from '@site/canvas/frameAdapter/FrameDocumentAdapter'

export interface AdapterTestHarness {
  adapter: FrameDocumentAdapter
  /** A real node ref this harness's frame actually contains, so measure()/select()/hover() have something real to act on. */
  existingRef: NodeRef
  cleanup(): void
}

export function runFrameDocumentAdapterContract(name: string, makeHarness: () => AdapterTestHarness): void {
  describe(`FrameDocumentAdapter contract — ${name}`, () => {
    it('applyOverlay/removeOverlay do not throw, and removeOverlay is safe on an id that was never applied', () => {
      const { adapter, cleanup } = makeHarness()
      try {
        expect(() => adapter.applyOverlay('contract-overlay', '.x { color: red }')).not.toThrow()
        expect(() => adapter.removeOverlay('contract-overlay')).not.toThrow()
        expect(() => adapter.removeOverlay('never-applied')).not.toThrow()
      } finally {
        cleanup()
      }
    })

    it('select accepts an empty array and a real ref without throwing', () => {
      const { adapter, existingRef, cleanup } = makeHarness()
      try {
        expect(() => adapter.select([])).not.toThrow()
        expect(() => adapter.select([existingRef])).not.toThrow()
        expect(() => adapter.select([])).not.toThrow()
      } finally {
        cleanup()
      }
    })

    it('hover accepts null and a real ref without throwing', () => {
      const { adapter, existingRef, cleanup } = makeHarness()
      try {
        expect(() => adapter.hover(existingRef)).not.toThrow()
        expect(() => adapter.hover(null)).not.toThrow()
      } finally {
        cleanup()
      }
    })

    it('measure returns a promise resolving to one measurement per ref, in the same order', async () => {
      const { adapter, existingRef, cleanup } = makeHarness()
      try {
        const result = adapter.measure([existingRef, existingRef])
        expect(result).toBeInstanceOf(Promise)
        const measurements = await result
        expect(measurements).toHaveLength(2)
        expect(measurements[0]!.nodeId).toBe(existingRef.nodeId)
        expect(measurements[1]!.nodeId).toBe(existingRef.nodeId)
      } finally {
        cleanup()
      }
    })

    it('setAxes does not throw for both directions and both color schemes', () => {
      const { adapter, cleanup } = makeHarness()
      try {
        expect(() => adapter.setAxes({ direction: 'ltr', colorScheme: 'light' })).not.toThrow()
        expect(() => adapter.setAxes({ direction: 'rtl', colorScheme: 'dark' })).not.toThrow()
      } finally {
        cleanup()
      }
    })

    it('setInteractionMode does not throw for design or live, including re-sending the same mode', () => {
      const { adapter, cleanup } = makeHarness()
      try {
        expect(() => adapter.setInteractionMode('design')).not.toThrow()
        expect(() => adapter.setInteractionMode('design')).not.toThrow()
        expect(() => adapter.setInteractionMode('live')).not.toThrow()
      } finally {
        cleanup()
      }
    })

    it('optimistic.* do not throw for a well-formed call', () => {
      const { adapter, existingRef, cleanup } = makeHarness()
      try {
        expect(() => adapter.optimistic.insert('contract-new', existingRef.nodeId, 0, 'div', 'hi')).not.toThrow()
        expect(() => adapter.optimistic.text('contract-new', 'updated')).not.toThrow()
        // Moves the newly-inserted node back under the SAME parent — moving a
        // node to be its own child (`existingRef` as both mover and target)
        // is nonsensical and correctly throws in a real DOM; this exercises
        // the real "move within a valid, distinct parent" case instead.
        expect(() => adapter.optimistic.move('contract-new', existingRef.nodeId, 0)).not.toThrow()
        expect(() => adapter.optimistic.delete('contract-new')).not.toThrow()
      } finally {
        cleanup()
      }
    })

    // `speed-01`
    it('optimistic.style/clearStyle do not throw for an inline call, a class-target call, or a clear', () => {
      const { adapter, existingRef, cleanup } = makeHarness()
      try {
        expect(() => adapter.optimistic.style(existingRef.nodeId, { color: 'red' })).not.toThrow()
        expect(() => adapter.optimistic.style(existingRef.nodeId, { color: 'blue' }, 'card')).not.toThrow()
        expect(() => adapter.optimistic.clearStyle(existingRef.nodeId)).not.toThrow()
      } finally {
        cleanup()
      }
    })

    it('on() returns an unsubscribe function, callable more than once without throwing', () => {
      const { adapter, cleanup } = makeHarness()
      try {
        const unsubscribe = adapter.on('ready', () => {})
        expect(typeof unsubscribe).toBe('function')
        expect(() => unsubscribe()).not.toThrow()
        expect(() => unsubscribe()).not.toThrow()
      } finally {
        cleanup()
      }
    })

    it('dispose() is safe to call more than once', () => {
      const { adapter, cleanup } = makeHarness()
      try {
        expect(() => adapter.dispose()).not.toThrow()
        expect(() => adapter.dispose()).not.toThrow()
      } finally {
        cleanup()
      }
    })
  })
}
