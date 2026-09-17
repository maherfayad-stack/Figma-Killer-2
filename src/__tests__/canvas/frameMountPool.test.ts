/**
 * frameMountPool.ts — pure policy unit tests (S1).
 *
 * The two properties that matter are the ones the module exists for: a frame
 * that just left the viewport keeps its iframe (so panning back is free), and
 * the number of live documents is bounded no matter how far you pan.
 *
 * @see src/admin/pages/site/canvas/BoardFramesLayer/frameMountPool.ts
 */
import { describe, it, expect } from 'bun:test'
import {
  FRAME_POOL_HEADROOM,
  MIN_FRAME_POOL,
  frameMountBudget,
  nextFrameRetention,
  sameFrameRetention,
} from '@site/canvas/BoardFramesLayer/frameMountPool'

const known = (...ids: string[]) => new Set(ids)

describe('frameMountBudget', () => {
  it('never drops below the floor, however few frames are visible', () => {
    expect(frameMountBudget(0)).toBe(MIN_FRAME_POOL)
    expect(frameMountBudget(1)).toBe(MIN_FRAME_POOL)
  })

  it('always leaves headroom above the visible set', () => {
    expect(frameMountBudget(30)).toBe(30 + FRAME_POOL_HEADROOM)
  })
})

describe('nextFrameRetention', () => {
  it('keeps a frame that just left the viewport — the whole point of the pool', () => {
    const first = nextFrameRetention([], ['a', 'b'], known('a', 'b', 'c'))
    expect(first).toEqual(['a', 'b'])

    // 'a' pans off screen; it must stay live so panning back costs nothing.
    const second = nextFrameRetention(first, ['b', 'c'], known('a', 'b', 'c'))
    expect(second).toContain('a')
  })

  it('puts the on-screen frames first, so they can never be evicted', () => {
    const retained = nextFrameRetention(['x', 'y'], ['p', 'q'], known('p', 'q', 'x', 'y'))
    expect(retained.slice(0, 2)).toEqual(['p', 'q'])
  })

  it('bounds the live set at the budget, evicting least-recently-on-screen', () => {
    const ids = Array.from({ length: 40 }, (_, i) => `f${i}`)
    let retained: string[] = []
    // Pan right across a 40-frame board, two frames visible at a time.
    for (let i = 0; i < ids.length - 1; i += 1) {
      retained = nextFrameRetention(retained, [ids[i]!, ids[i + 1]!], known(...ids))
      expect(retained.length).toBeLessThanOrEqual(frameMountBudget(2))
    }
    // What survived is the tail of the pan, not its head.
    expect(retained).toContain('f39')
    expect(retained).not.toContain('f0')
  })

  it('drops frames that are no longer on the board at all', () => {
    const retained = nextFrameRetention(['gone', 'kept'], ['live'], known('live', 'kept'))
    expect(retained).not.toContain('gone')
    expect(retained).toContain('kept')
  })

  it('never lists a frame twice', () => {
    const retained = nextFrameRetention(['a', 'b'], ['a', 'a', 'b'], known('a', 'b'))
    expect(retained).toEqual(['a', 'b'])
  })
})

describe('sameFrameRetention', () => {
  it('is true only for the same ids in the same order', () => {
    expect(sameFrameRetention(['a', 'b'], ['a', 'b'])).toBe(true)
    expect(sameFrameRetention(['a', 'b'], ['b', 'a'])).toBe(false)
    expect(sameFrameRetention(['a'], ['a', 'b'])).toBe(false)
  })
})
