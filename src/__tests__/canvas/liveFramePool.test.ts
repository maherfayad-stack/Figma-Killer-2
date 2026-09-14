/**
 * liveFramePool.ts — pure function unit tests.
 *
 * @see src/admin/pages/site/canvas/BoardFramesLayer/liveFramePool.ts
 */
import { describe, it, expect } from 'bun:test'
import { computeHotFrameIds, LIVE_FRAME_POOL_SIZE } from '@site/canvas/BoardFramesLayer/liveFramePool'

describe('LIVE_FRAME_POOL_SIZE', () => {
  it('matches the plan default (8)', () => {
    expect(LIVE_FRAME_POOL_SIZE).toBe(8)
  })
})

describe('computeHotFrameIds', () => {
  it('keeps every visible id, even with an empty previous hot-set', () => {
    const result = computeHotFrameIds(['a', 'b', 'c'], [], 8)
    expect(new Set(result)).toEqual(new Set(['a', 'b', 'c']))
  })

  it('visible ids always win, even when the visible set alone exceeds poolSize', () => {
    const visible = Array.from({ length: 12 }, (_, i) => `v${i}`)
    const result = computeHotFrameIds(visible, ['stale-1', 'stale-2'], 8)
    // Every visible id present — none dropped for exceeding the pool budget.
    for (const id of visible) expect(result).toContain(id)
    // No room left for previously-hot, now-invisible ids once visible alone exceeds poolSize.
    expect(result).not.toContain('stale-1')
    expect(result).not.toContain('stale-2')
    expect(result).toHaveLength(visible.length)
  })

  it('carries forward previously-hot, now-invisible ids up to the remaining pool budget', () => {
    // 2 visible, poolSize 5 -> 3 slots left for previously-hot ids.
    const result = computeHotFrameIds(
      ['v1', 'v2'],
      ['old-1', 'old-2', 'old-3', 'old-4'],
      5,
    )
    expect(result).toEqual(['v1', 'v2', 'old-1', 'old-2', 'old-3'])
  })

  it('preserves LRU order — most-recently-visible previous ids are kept first', () => {
    const result = computeHotFrameIds([], ['most-recent', 'older', 'oldest'], 2)
    expect(result).toEqual(['most-recent', 'older'])
  })

  it('evicts ids beyond the pool budget', () => {
    const result = computeHotFrameIds([], ['keep-1', 'keep-2', 'evict-1', 'evict-2'], 2)
    expect(result).toEqual(['keep-1', 'keep-2'])
    expect(result).not.toContain('evict-1')
    expect(result).not.toContain('evict-2')
  })

  it('does not duplicate an id that is both visible and in the previous hot-set', () => {
    const result = computeHotFrameIds(['a', 'b'], ['a', 'c'], 8)
    expect(result).toEqual(['a', 'b', 'c'])
    expect(result.filter((id) => id === 'a')).toHaveLength(1)
  })

  it('handles an empty board (no visible, no previous hot-set)', () => {
    expect(computeHotFrameIds([], [], LIVE_FRAME_POOL_SIZE)).toEqual([])
  })

  it('handles a shrinking board — previous hot ids for frames that no longer exist are just dropped by the caller re-seeding `previousHot`', () => {
    // The function itself doesn't know about frame deletion; a caller who
    // stops passing a deleted frame's id in either list naturally drops it.
    const result = computeHotFrameIds(['a'], ['a', 'deleted-frame'], 8)
    expect(result).toEqual(['a', 'deleted-frame'])
    // Once the caller's next `previousHot` omits the deleted id (because
    // BoardFramesLayer no longer renders that frame at all), it never
    // reappears.
    const next = computeHotFrameIds(['a'], ['a'], 8)
    expect(next).toEqual(['a'])
  })

  it('handles poolSize 0 — only visible ids are ever kept', () => {
    const result = computeHotFrameIds(['a', 'b'], ['c', 'd'], 0)
    expect(result).toEqual(['a', 'b'])
  })

  it('handles poolSize exactly equal to the visible count — no room for any previous ids', () => {
    const result = computeHotFrameIds(['a', 'b'], ['c'], 2)
    expect(result).toEqual(['a', 'b'])
  })
})
