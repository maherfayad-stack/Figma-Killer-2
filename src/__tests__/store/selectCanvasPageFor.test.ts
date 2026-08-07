/**
 * `selectCanvasPageFor` memo contract — `STUDIO-FIGMA-PARITY-PLAN.md` C1.
 *
 * `NodeRenderer.tsx` calls `selectCanvasPageFor(s, pageId, frameId)` TWICE
 * per node (once for the node, once for `mcClassName`), and every board
 * frame supplies its OWN `pageId` — so a single store commit can call this
 * with many DIFFERENT pageIds, unlike `selectActivePage`'s single
 * `(site, activePageId)` pair. The fix must therefore scan `site.pages` at
 * most ONCE per `(site, pageId)` pair, not once per call, and must not let
 * one pageId's cache entry evict another's within the same sweep (site
 * identity unchanged).
 */
import { describe, it, expect } from 'bun:test'
import { selectCanvasPageFor, type EditorStore } from '@site/store/store'

interface CountingPages {
  pages: unknown[]
  findCalls: () => number
}

function makePages(ids: string[]): CountingPages {
  let findCalls = 0
  const raw = ids.map((id) => ({ id, title: id, slug: id, nodes: {}, rootNodeId: 'root' }))
  const pages = new Proxy(raw, {
    get(target, prop, receiver) {
      if (prop === 'find') findCalls++
      return Reflect.get(target, prop, receiver)
    },
  })
  return { pages, findCalls: () => findCalls }
}

function makeState(pages: unknown[]): EditorStore {
  return {
    site: { pages },
    activePageId: null,
    activeDocument: null,
    previewAxes: { locale: null },
    localizedPages: {},
    boards: { version: 1, boards: [] },
    activeBoardId: null,
  } as unknown as EditorStore
}

describe('selectCanvasPageFor', () => {
  it('scans site.pages once per (site, pageId) pair — repeated calls for the SAME pageId hit the cache', () => {
    const { pages, findCalls } = makePages(['a', 'b', 'c'])
    const state = makeState(pages)

    const first = selectCanvasPageFor(state, 'b')
    expect((first as { id: string }).id).toBe('b')
    expect(findCalls()).toBe(1)

    // NodeRenderer's own "twice per node" shape, and every other node on the
    // same frame — must all hit the cache, not re-scan.
    for (let i = 0; i < 20; i++) {
      expect(selectCanvasPageFor(state, 'b')).toBe(first)
    }
    expect(findCalls()).toBe(1)
  })

  it('does NOT thrash across DIFFERENT pageIds in the same sweep (same site identity)', () => {
    const { pages, findCalls } = makePages(['a', 'b', 'c'])
    const state = makeState(pages)

    // Simulates one store commit rendering three board frames, each with its
    // own pageId, interleaved the way several mounted NodeRenderers would.
    const a1 = selectCanvasPageFor(state, 'a')
    const b1 = selectCanvasPageFor(state, 'b')
    const c1 = selectCanvasPageFor(state, 'c')
    expect(findCalls()).toBe(3)

    // Going BACK to an earlier pageId in the same sweep must hit its own
    // cache slot rather than having been evicted by 'b'/'c' — this is
    // exactly what a single-slot memo (unlike selectActivePage's, which only
    // ever sees ONE pageId per sweep) would get wrong.
    expect(selectCanvasPageFor(state, 'a')).toBe(a1)
    expect(selectCanvasPageFor(state, 'b')).toBe(b1)
    expect(selectCanvasPageFor(state, 'c')).toBe(c1)
    expect(findCalls()).toBe(3)
  })

  it('re-scans when the site identity changes and returns the new page object', () => {
    const a = makePages(['p1', 'p2'])
    const pageA = selectCanvasPageFor(makeState(a.pages), 'p2')

    const b = makePages(['p1', 'p2'])
    const pageB = selectCanvasPageFor(makeState(b.pages), 'p2')

    expect(b.findCalls()).toBe(1)
    expect(pageB).not.toBe(pageA)
    expect((pageB as { id: string }).id).toBe('p2')
  })

  it('caches a missing-page result (null) without re-scanning', () => {
    const { pages, findCalls } = makePages(['a'])
    const state = makeState(pages)
    expect(selectCanvasPageFor(state, 'nope')).toBeNull()
    expect(selectCanvasPageFor(state, 'nope')).toBeNull()
    expect(findCalls()).toBe(1)
  })

  it('returns null without scanning when there is no site', () => {
    const state = { site: null, activeDocument: null } as unknown as EditorStore
    expect(selectCanvasPageFor(state, 'a')).toBeNull()
  })
})
