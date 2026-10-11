/**
 * posterStore + posterKey (SB-2) — a picture is keyed by what the frame renders,
 * one picture per frame, LRU by bytes, persistence is best-effort.
 *
 * @see src/admin/pages/site/canvas/BoardFramesLayer/posterStore.ts
 * @see src/admin/pages/site/canvas/BoardFramesLayer/posterKey.ts
 */
import { describe, expect, it } from 'bun:test'
import { posterKey, posterKeyFrameId, siteStyleSignature } from '@site/canvas/BoardFramesLayer/posterKey'
import { createPosterStore, type PosterPersistence, type PosterUrls } from '@site/canvas/BoardFramesLayer/posterStore'
import { makeNode, makePage } from '../fixtures'

const blobOf = (size: number) => new Blob([new Uint8Array(size)])

function fakeUrls() {
  const live = new Set<string>()
  let next = 0
  const urls: PosterUrls = {
    create: () => {
      const url = `blob:p${next++}`
      live.add(url)
      return url
    },
    revoke: (url) => void live.delete(url),
  }
  return { urls, live }
}

function memoryPersistence() {
  const rows = new Map<string, { frameId: string; blob: Blob }>()
  const persistence: PosterPersistence = {
    get: async (key) => rows.get(key)?.blob,
    put: async (key, frameId, blob) => {
      for (const [other, row] of rows) if (row.frameId === frameId && other !== key) rows.delete(other)
      rows.set(key, { frameId, blob })
    },
    clear: async (frameId) => {
      for (const [key, row] of rows) if (frameId === undefined || row.frameId === frameId) rows.delete(key)
    },
  }
  return { persistence, rows }
}

const STYLE = siteStyleSignature({ styleRules: {}, breakpoints: {}, conditions: {}, framework: {}, fonts: {} })

describe('posterKey', () => {
  const page = makePage({ id: 'home', nodes: { root: makeNode({ id: 'root', moduleId: 'base.body', children: [] }) } })

  it('is content-addressed: an equal-content page object resolves to the same key', () => {
    const clone = structuredClone(page)
    const parts = { frameId: 'f1', styleSignature: STYLE, axes: undefined, width: 1440 }
    expect(posterKey({ ...parts, page })).toBe(posterKey({ ...parts, page: clone }))
  })

  it('changes with the tree, the site styles, the axes and the width', () => {
    const parts = { frameId: 'f1', page, styleSignature: STYLE, axes: undefined, width: 1440 }
    const base = posterKey(parts)
    const edited = makePage({ id: 'home', nodes: { root: makeNode({ id: 'root', moduleId: 'base.container', children: [] }) } })
    const restyled = siteStyleSignature({ styleRules: { a: 1 }, breakpoints: {}, conditions: {}, framework: {}, fonts: {} })
    expect(posterKey({ ...parts, page: edited })).not.toBe(base)
    expect(posterKey({ ...parts, styleSignature: restyled })).not.toBe(base)
    expect(posterKey({ ...parts, axes: { direction: 'rtl' } })).not.toBe(base)
    expect(posterKey({ ...parts, width: 800 })).not.toBe(base)
  })

  it('leads with the frame id, which the store uses to keep one picture per frame', () => {
    const key = posterKey({ frameId: 'frame-7', page, styleSignature: STYLE, axes: undefined, width: 100 })
    expect(posterKeyFrameId(key)).toBe('frame-7')
  })

  it('a site style signature is stable for unchanged inputs', () => {
    const inputs = { styleRules: {}, breakpoints: {}, conditions: {}, framework: {}, fonts: {} }
    expect(siteStyleSignature(inputs)).toBe(siteStyleSignature({ ...inputs }))
  })
})

describe('posterStore', () => {
  it('peek is a miss until a picture is put, then a stable URL', () => {
    const { urls } = fakeUrls()
    const store = createPosterStore({ urls })
    expect(store.peek('f1::a')).toBeUndefined()
    store.put('f1::a', blobOf(10))
    const first = store.peek('f1::a')
    expect(first).toBeDefined()
    expect(store.peek('f1::a')).toBe(first)
  })

  it('keeps ONE picture per frame: a new key drops the frame\'s older one and revokes its URL', () => {
    const { urls, live } = fakeUrls()
    const store = createPosterStore({ urls })
    store.put('f1::old', blobOf(10))
    store.peek('f1::old')
    store.put('f1::new', blobOf(10))
    expect(store.has('f1::old')).toBe(false)
    expect(store.has('f1::new')).toBe(true)
    expect(live.size).toBe(0)
    store.put('f2::x', blobOf(10))
    expect(store.stats().entries).toBe(2)
  })

  it('evicts the least recently used picture when over the byte budget, never the one just added', () => {
    const { urls } = fakeUrls()
    const store = createPosterStore({ urls, maxBytes: 25 })
    store.put('a::1', blobOf(10))
    store.put('b::1', blobOf(10))
    store.peek('a::1')
    store.put('c::1', blobOf(10))
    expect(store.has('b::1')).toBe(false)
    expect(store.has('a::1')).toBe(true)
    expect(store.has('c::1')).toBe(true)
    expect(store.stats().bytes).toBe(20)
  })

  it('a picture larger than the budget is still held (the newest is never evicted)', () => {
    const store = createPosterStore({ urls: fakeUrls().urls, maxBytes: 5 })
    store.put('a::1', blobOf(10))
    expect(store.has('a::1')).toBe(true)
  })

  it('invalidate forgets one frame or all, and tells subscribers', () => {
    const store = createPosterStore({ urls: fakeUrls().urls })
    store.put('a::1', blobOf(1))
    store.put('b::1', blobOf(1))
    let notified = 0
    store.subscribe(() => (notified += 1))
    store.invalidate('a')
    expect(store.has('a::1')).toBe(false)
    expect(store.has('b::1')).toBe(true)
    store.invalidate()
    expect(store.stats().entries).toBe(0)
    expect(notified).toBe(2)
  })

  it('persists on put and hydrates a fresh store from persistence (a reopened board)', async () => {
    const { persistence, rows } = memoryPersistence()
    const first = createPosterStore({ urls: fakeUrls().urls, persistence })
    first.put('f1::a', blobOf(7))
    await Promise.resolve()
    expect(rows.has('f1::a')).toBe(true)

    const reopened = createPosterStore({ urls: fakeUrls().urls, persistence })
    let notified = 0
    reopened.subscribe(() => (notified += 1))
    expect(reopened.peek('f1::a')).toBeUndefined()
    expect(await reopened.ensure('f1::a')).toBe(true)
    expect(reopened.peek('f1::a')).toBeDefined()
    expect(notified).toBe(1)
    expect(await reopened.ensure('f1::missing')).toBe(false)
  })

  it('a failing persistence is a miss, never an error', async () => {
    const persistence: PosterPersistence = {
      get: () => Promise.reject(new Error('quota')),
      put: () => Promise.reject(new Error('quota')),
      clear: () => Promise.reject(new Error('quota')),
    }
    const store = createPosterStore({ urls: fakeUrls().urls, persistence })
    expect(await store.ensure('f1::a')).toBe(false)
    store.put('f1::a', blobOf(1))
    store.invalidate('f1')
    await Promise.resolve()
    expect(store.has('f1::a')).toBe(false)
  })
})
