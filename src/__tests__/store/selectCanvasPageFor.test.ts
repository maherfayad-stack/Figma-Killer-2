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

interface CountingFrames {
  frames: unknown[]
  findCalls: () => number
}

function makeFrames(specs: { id: string; locale?: string }[]): CountingFrames {
  let findCalls = 0
  const raw = specs.map((spec) => ({
    id: spec.id,
    pageId: spec.id,
    axes: spec.locale ? { locale: spec.locale } : undefined,
  }))
  const frames = new Proxy(raw, {
    get(target, prop, receiver) {
      if (prop === 'find') findCalls++
      return Reflect.get(target, prop, receiver)
    },
  })
  return { frames, findCalls: () => findCalls }
}

function makeState(
  pages: unknown[],
  overrides: {
    frames?: unknown[]
    localizedPages?: Record<string, unknown>
    previewLocale?: string | null
  } = {},
): EditorStore {
  return {
    site: { pages },
    activePageId: null,
    activeDocument: null,
    previewAxes: { locale: overrides.previewLocale ?? null },
    localizedPages: overrides.localizedPages ?? {},
    boards: {
      version: 1,
      boards: overrides.frames ? [{ id: 'board-1', frames: overrides.frames }] : [],
    },
    activeBoardId: overrides.frames ? 'board-1' : null,
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

/**
 * The `frameId` branch — added after the `pageId` memo above and, until this
 * suite, uncached: `selectActiveBoard(s)?.frames.find(...)` is TWO `Array.find`s
 * per call, and `NodeRenderer` makes that call twice per mounted node on every
 * store commit. On a board with no locale variants (every board, unless
 * someone duplicates a frame as one) that work can be skipped entirely.
 */
describe('selectCanvasPageFor — frameId / locale branch', () => {
  it('never touches board frames when no locale-variant page has been fetched', () => {
    const { pages } = makePages(['a', 'b'])
    const { frames, findCalls } = makeFrames([{ id: 'f-a', locale: 'ar' }, { id: 'f-b' }])
    const state = makeState(pages, { frames })

    for (let i = 0; i < 50; i++) selectCanvasPageFor(state, 'a', 'f-a')

    // `localizedPages` is empty, so the branch cannot return anything — the
    // frames array must never be scanned at all.
    expect(findCalls()).toBe(0)
  })

  it('scans board frames at most once per (frames, frameId) pair', () => {
    const { pages } = makePages(['a', 'b'])
    const { frames, findCalls } = makeFrames([{ id: 'f-a', locale: 'ar' }, { id: 'f-b' }])
    const localized = { id: 'a', title: 'a-ar', slug: 'a', nodes: {}, rootNodeId: 'root' }
    const state = makeState(pages, { frames, localizedPages: { 'a::ar': localized } })

    expect(selectCanvasPageFor(state, 'a', 'f-a')).toBe(localized)
    expect(findCalls()).toBe(1)

    // Every other node in the same frame, plus the second `mcClassName` call
    // each of them makes, must hit the cache.
    for (let i = 0; i < 50; i++) expect(selectCanvasPageFor(state, 'a', 'f-a')).toBe(localized)
    expect(findCalls()).toBe(1)

    // A DIFFERENT frame in the same sweep gets its own slot without evicting
    // the first — the same non-thrash requirement the pageId cache has.
    selectCanvasPageFor(state, 'b', 'f-b')
    expect(findCalls()).toBe(2)
    expect(selectCanvasPageFor(state, 'a', 'f-a')).toBe(localized)
    expect(findCalls()).toBe(2)
  })

  it('re-scans when the frames array identity changes (a frame moved / its axes changed)', () => {
    const { pages } = makePages(['a'])
    const first = makeFrames([{ id: 'f-a', locale: 'ar' }])
    const localizedAr = { id: 'a', title: 'a-ar', slug: 'a', nodes: {}, rootNodeId: 'root' }
    const localizedFr = { id: 'a', title: 'a-fr', slug: 'a', nodes: {}, rootNodeId: 'root' }
    const localizedPages = { 'a::ar': localizedAr, 'a::fr': localizedFr }

    expect(selectCanvasPageFor(makeState(pages, { frames: first.frames, localizedPages }), 'a', 'f-a')).toBe(localizedAr)

    const second = makeFrames([{ id: 'f-a', locale: 'fr' }])
    expect(selectCanvasPageFor(makeState(pages, { frames: second.frames, localizedPages }), 'a', 'f-a')).toBe(localizedFr)
    expect(second.findCalls()).toBe(1)
  })

  it('falls back to the default tree when the frame locale matches the board locale', () => {
    const { pages } = makePages(['a'])
    const { frames } = makeFrames([{ id: 'f-a', locale: 'ar' }])
    const localized = { id: 'a', title: 'a-ar', slug: 'a', nodes: {}, rootNodeId: 'root' }
    const state = makeState(pages, { frames, localizedPages: { 'a::ar': localized }, previewLocale: 'ar' })

    expect((selectCanvasPageFor(state, 'a', 'f-a') as { title: string }).title).toBe('a')
  })

  it('falls back to the default tree when the variant page has not been fetched yet', () => {
    const { pages } = makePages(['a', 'b'])
    const { frames } = makeFrames([{ id: 'f-a', locale: 'ar' }, { id: 'f-b', locale: 'fr' }])
    // Non-empty (so the branch runs) but missing THIS frame's variant.
    const state = makeState(pages, {
      frames,
      localizedPages: { 'b::fr': { id: 'b', title: 'b-fr', slug: 'b', nodes: {}, rootNodeId: 'root' } },
    })

    expect((selectCanvasPageFor(state, 'a', 'f-a') as { title: string }).title).toBe('a')
  })
})
