/**
 * framePool.ts — the ONE frame-mount policy, pure unit tests.
 *
 * Replaces `frameMountPool.test.ts` (S1, portal frames) and
 * `liveFramePool.test.ts` (L8 Phase B, Tier-2 live frames), whose subjects
 * were merged into one module parameterised by what a frame costs. Every
 * property both files asserted is asserted here, for both costs, plus the
 * two the merge makes newly true: the budget is the only difference between
 * them, and a frame that has left the board stops holding a slot on the live
 * side too (the old `computeHotFrameIds` had no `knownIds` argument and
 * carried a deleted frame's id until the caller happened to re-seed).
 *
 * @see src/admin/pages/site/canvas/BoardFramesLayer/framePool.ts
 */
import { describe, it, expect } from 'bun:test'
import {
  FRAME_POOL_HEADROOM,
  LIVE_FRAME_POOL_SIZE,
  MIN_FRAME_POOL,
  framePoolBudget,
  nextFramePool,
  readFrameMountReason,
  resolveFrameMount,
  sameFramePool,
  type FrameMountCost,
} from '@site/canvas/BoardFramesLayer/framePool'

const known = (...ids: string[]) => new Set(ids)
const COSTS: FrameMountCost[] = ['portal', 'live']

describe('framePoolBudget', () => {
  it('gives portal frames a floor of 8 with headroom above the visible set', () => {
    expect(framePoolBudget('portal', 0)).toBe(MIN_FRAME_POOL)
    expect(framePoolBudget('portal', 1)).toBe(MIN_FRAME_POOL)
    expect(framePoolBudget('portal', 30)).toBe(30 + FRAME_POOL_HEADROOM)
  })

  it('gives live frames a ceiling of 8 that only the visible set may exceed', () => {
    expect(framePoolBudget('live', 0)).toBe(LIVE_FRAME_POOL_SIZE)
    expect(framePoolBudget('live', 1)).toBe(LIVE_FRAME_POOL_SIZE)
    // 12 visible Tier-2 frames all stay mounted — a frame you are looking at
    // is never evicted — but nothing rides along beyond them.
    expect(framePoolBudget('live', 12)).toBe(12)
  })

  it('never budgets below the visible count, for either cost — the truncation may only bite the retained tail', () => {
    for (const cost of COSTS) {
      for (const onScreen of [0, 1, 7, 8, 9, 40]) {
        expect(framePoolBudget(cost, onScreen)).toBeGreaterThanOrEqual(onScreen)
      }
    }
  })

  it('keeps a live board strictly cheaper than a portal board at the same visible count', () => {
    for (const onScreen of [0, 1, 8, 20]) {
      expect(framePoolBudget('live', onScreen)).toBeLessThanOrEqual(framePoolBudget('portal', onScreen))
    }
  })
})

describe('nextFramePool — shared policy, both costs', () => {
  for (const cost of COSTS) {
    it(`[${cost}] keeps every on-screen frame, in the layer's order, ahead of the retained tail`, () => {
      const pool = nextFramePool(['x', 'y'], ['p', 'q'], known('p', 'q', 'x', 'y'), cost)
      expect(pool.slice(0, 2)).toEqual(['p', 'q'])
      expect(pool).toContain('x')
    })

    it(`[${cost}] keeps a frame that just left the viewport — the whole point of the pool`, () => {
      const first = nextFramePool([], ['a', 'b'], known('a', 'b', 'c'), cost)
      expect(first).toEqual(['a', 'b'])
      const second = nextFramePool(first, ['b', 'c'], known('a', 'b', 'c'), cost)
      expect(second).toContain('a')
    })

    it(`[${cost}] bounds the pool at the budget while panning a 40-frame board, evicting least-recently-on-screen`, () => {
      const ids = Array.from({ length: 40 }, (_, i) => `f${i}`)
      let pool: string[] = []
      for (let i = 0; i < ids.length - 1; i += 1) {
        pool = nextFramePool(pool, [ids[i]!, ids[i + 1]!], known(...ids), cost)
        expect(pool.length).toBeLessThanOrEqual(framePoolBudget(cost, 2))
      }
      // What survived is the tail of the pan, not its head.
      expect(pool).toContain('f39')
      expect(pool).not.toContain('f0')
    })

    it(`[${cost}] drops frames that are no longer on the board at all`, () => {
      const pool = nextFramePool(['gone', 'kept'], ['live'], known('live', 'kept'), cost)
      expect(pool).not.toContain('gone')
      expect(pool).toContain('kept')
    })

    it(`[${cost}] never lists a frame twice`, () => {
      expect(nextFramePool(['a', 'b'], ['a', 'a', 'b'], known('a', 'b'), cost)).toEqual(['a', 'b'])
    })

    it(`[${cost}] never evicts a visible frame, even when the visible set alone exceeds the budget floor`, () => {
      const visible = Array.from({ length: 12 }, (_, i) => `v${i}`)
      const pool = nextFramePool(['stale-1', 'stale-2'], visible, known(...visible, 'stale-1', 'stale-2'), cost)
      for (const id of visible) expect(pool).toContain(id)
    })
  }

  it('is the BUDGET, and nothing else, that separates the two costs', () => {
    const board = Array.from({ length: 30 }, (_, i) => `f${i}`)
    const previous = board.slice(10)
    const onScreen = board.slice(0, 3)
    const portal = nextFramePool(previous, onScreen, known(...board), 'portal')
    const live = nextFramePool(previous, onScreen, known(...board), 'live')
    expect(portal.length).toBe(framePoolBudget('portal', 3))
    expect(live.length).toBe(framePoolBudget('live', 3))
    // Same order, same eviction — the live list is a prefix of the portal one.
    expect(portal.slice(0, live.length)).toEqual(live)
  })

  it('a live board drops its warm cache entirely once the visible set fills the ceiling', () => {
    const visible = Array.from({ length: 8 }, (_, i) => `v${i}`)
    const pool = nextFramePool(['warm'], visible, known(...visible, 'warm'), 'live')
    expect(pool).not.toContain('warm')
    // The same board's portal equivalent still keeps four warm.
    const portal = nextFramePool(['warm'], visible, known(...visible, 'warm'), 'portal')
    expect(portal).toContain('warm')
  })
})

describe('sameFramePool', () => {
  it('is true only for the same ids in the same order — the order IS the LRU record', () => {
    expect(sameFramePool(['a', 'b'], ['a', 'b'])).toBe(true)
    expect(sameFramePool(['a', 'b'], ['b', 'a'])).toBe(false)
    expect(sameFramePool(['a'], ['a', 'b'])).toBe(false)
  })
})

describe('resolveFrameMount', () => {
  it('mounts an on-screen frame, and says so', () => {
    expect(resolveFrameMount({ isOnScreen: true, isPooled: true })).toEqual({ mounted: true, reason: 'on-screen' })
    expect(resolveFrameMount({ isOnScreen: true, isPooled: false })).toEqual({ mounted: true, reason: 'on-screen' })
  })

  it('mounts a pooled, offscreen frame — that is what the pool is for', () => {
    expect(resolveFrameMount({ isOnScreen: false, isPooled: true })).toEqual({ mounted: true, reason: 'pooled' })
  })

  it('does not mount an offscreen frame the pool dropped', () => {
    expect(resolveFrameMount({ isOnScreen: false, isPooled: false })).toEqual({ mounted: false, reason: 'offscreen' })
  })

  it('defaults an absent pool answer to "mounted exactly while visible" — `meta-14` landmine 1', () => {
    expect(resolveFrameMount({ isOnScreen: true })).toEqual({ mounted: true, reason: 'on-screen' })
    expect(resolveFrameMount({ isOnScreen: false })).toEqual({ mounted: false, reason: 'offscreen' })
  })
})

describe('readFrameMountReason', () => {
  it('reads back exactly the three reasons, and nothing else', () => {
    const el = document.createElement('div')
    expect(readFrameMountReason(el)).toBeNull()
    expect(readFrameMountReason(null)).toBeNull()
    for (const reason of ['on-screen', 'pooled', 'offscreen'] as const) {
      el.setAttribute('data-frame-mount', reason)
      expect(readFrameMountReason(el)).toBe(reason)
    }
    el.setAttribute('data-frame-mount', 'hot')
    expect(readFrameMountReason(el)).toBeNull()
  })
})
