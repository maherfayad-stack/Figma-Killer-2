/**
 * frameMount.ts: what a board frame shows once the live set has decided
 * whether it holds an iframe (SB-5). The live set itself is `liveFrameCap.test.ts`.
 *
 * @see src/admin/pages/site/canvas/BoardFramesLayer/frameMount.ts
 */
import { describe, it, expect } from 'bun:test'
import {
  FRAME_MOUNT_ATTR,
  readFrameMountReason,
  resolveFrameMount,
  sameLiveSet,
} from '@site/canvas/BoardFramesLayer/frameMount'

describe('resolveFrameMount', () => {
  it('a frame in the live set is live, whether or not it has a picture', () => {
    expect(resolveFrameMount({ isLive: true, hasPoster: true })).toEqual({ mounted: true, reason: 'live' })
    expect(resolveFrameMount({ isLive: true, hasPoster: false })).toEqual({ mounted: true, reason: 'live' })
  })

  it('a frame outside the live set shows its picture when it has one', () => {
    expect(resolveFrameMount({ isLive: false, hasPoster: true })).toEqual({ mounted: false, reason: 'poster' })
  })

  it('a frame outside the live set with no picture yet is cold: the title placeholder', () => {
    expect(resolveFrameMount({ isLive: false, hasPoster: false })).toEqual({ mounted: false, reason: 'cold' })
  })
})

describe('sameLiveSet', () => {
  it('is membership, not order: the layer must not re-render because the ranking shuffled', () => {
    expect(sameLiveSet(['a', 'b'], ['b', 'a'])).toBe(true)
    expect(sameLiveSet(['a'], ['a', 'b'])).toBe(false)
    expect(sameLiveSet(['a', 'b'], ['a', 'c'])).toBe(false)
    expect(sameLiveSet([], [])).toBe(true)
  })
})

describe('readFrameMountReason', () => {
  it('reads back exactly the three reasons, and nothing else', () => {
    const el = document.createElement('div')
    expect(readFrameMountReason(el)).toBeNull()
    expect(readFrameMountReason(null)).toBeNull()
    for (const reason of ['live', 'poster', 'cold'] as const) {
      el.setAttribute(FRAME_MOUNT_ATTR, reason)
      expect(readFrameMountReason(el)).toBe(reason)
    }
    for (const stale of ['on-screen', 'pooled', 'offscreen', 'hot']) {
      el.setAttribute(FRAME_MOUNT_ATTR, stale)
      expect(readFrameMountReason(el)).toBeNull()
    }
  })
})
