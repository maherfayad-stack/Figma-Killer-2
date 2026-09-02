/**
 * frameSnapshotCache.ts — pure function unit tests.
 *
 * @see src/admin/pages/site/canvas/BoardFramesLayer/frameSnapshotCache.ts
 */
import { describe, it, expect } from 'bun:test'
import { getFramePoster, setFramePoster } from '@site/canvas/BoardFramesLayer/frameSnapshotCache'
import type { Page } from '@core/page-tree'

function makePage(id: string): Page {
  return { id, title: id, nodes: {}, rootId: 'root' } as unknown as Page
}

describe('frameSnapshotCache', () => {
  it('returns undefined for a page that has never been captured', () => {
    const page = makePage('p1')
    expect(getFramePoster(page, 1024)).toBeUndefined()
  })

  it('returns the cached poster for the same page object and width', () => {
    const page = makePage('p2')
    setFramePoster(page, 1024, 'data:image/png;base64,AAA')
    expect(getFramePoster(page, 1024)).toBe('data:image/png;base64,AAA')
  })

  it('misses when the requested width does not match the cached capture width (a resized frame)', () => {
    const page = makePage('p3')
    setFramePoster(page, 1024, 'data:image/png;base64,AAA')
    expect(getFramePoster(page, 800)).toBeUndefined()
  })

  it('misses for a different page object with the same id — a content edit produces a new Page object, which is exactly the invalidation signal', () => {
    const before = makePage('p4')
    setFramePoster(before, 1024, 'data:image/png;base64,AAA')
    const after = { ...before } // structural-sharing style: new object, same id, after an edit
    expect(getFramePoster(after, 1024)).toBeUndefined()
    // The old object's own entry is untouched.
    expect(getFramePoster(before, 1024)).toBe('data:image/png;base64,AAA')
  })

  it('overwrites a stale poster for the same page object with a fresh capture', () => {
    const page = makePage('p5')
    setFramePoster(page, 1024, 'data:image/png;base64,OLD')
    setFramePoster(page, 1024, 'data:image/png;base64,NEW')
    expect(getFramePoster(page, 1024)).toBe('data:image/png;base64,NEW')
  })
})
