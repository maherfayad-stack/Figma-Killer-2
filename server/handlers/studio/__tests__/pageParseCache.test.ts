/**
 * pageParseCache.ts — unit tests over real temp files (mtime-based
 * invalidation needs a real filesystem clock, not a mock).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  cachedRouteDependencies,
  clearPageParseCache,
  getCachedRouteParse,
  hashWorkspaceConfig,
  setCachedRouteParse,
  type CachedRouteParse,
} from '../pageParseCache'

const fakeResult: CachedRouteParse = {
  expanded: { rootIds: ['a'], nodes: { a: { id: 'a', kind: 'element', name: 'div', props: {}, children: [], loc: { file: 'A.tsx', line: 1, col: 1 }, locked: false } } },
  componentSources: {},
}

describe('pageParseCache', () => {
  let tmpDir: string
  let fileA: string
  let fileB: string

  beforeEach(() => {
    clearPageParseCache()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'page-parse-cache-'))
    fileA = path.join(tmpDir, 'A.tsx')
    fileB = path.join(tmpDir, 'B.tsx')
    fs.writeFileSync(fileA, 'export default function A() { return <div/> }', 'utf8')
    fs.writeFileSync(fileB, 'export default function B() { return <div/> }', 'utf8')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('misses a cold entry', () => {
    expect(getCachedRouteParse('key1', 'h1')).toBeNull()
  })

  it('hits after a write with unchanged files and config', () => {
    setCachedRouteParse('key1', 'h1', [fileA], fakeResult)
    expect(getCachedRouteParse('key1', 'h1')).toEqual(fakeResult)
  })

  it('misses when the config hash changes — a workspace-wide input, not a per-file one', () => {
    setCachedRouteParse('key1', 'h1', [fileA], fakeResult)
    expect(getCachedRouteParse('key1', 'h2')).toBeNull()
  })

  it('misses once the tracked file itself is edited (mtime moves)', () => {
    setCachedRouteParse('key1', 'h1', [fileA], fakeResult)
    expect(getCachedRouteParse('key1', 'h1')).toEqual(fakeResult)

    // Force a distinct mtime — same-millisecond writes can otherwise land on
    // an identical stat() reading, which would falsely look unchanged.
    const bumped = new Date(fs.statSync(fileA).mtime.getTime() + 5000)
    fs.writeFileSync(fileA, 'export default function A() { return <span/> }', 'utf8')
    fs.utimesSync(fileA, bumped, bumped)

    expect(getCachedRouteParse('key1', 'h1')).toBeNull()
  })

  it('misses when a DEPENDENCY file is edited, even though the route\'s own file did not change — the "editing Hero.tsx invalidates Home.tsx" case', () => {
    setCachedRouteParse('key1', 'h1', [fileA, fileB], fakeResult)
    expect(getCachedRouteParse('key1', 'h1')).toEqual(fakeResult)

    const bumped = new Date(fs.statSync(fileB).mtime.getTime() + 5000)
    fs.writeFileSync(fileB, 'export default function B() { return <p/> }', 'utf8')
    fs.utimesSync(fileB, bumped, bumped)

    expect(getCachedRouteParse('key1', 'h1')).toBeNull()
  })

  it('misses once a tracked file is deleted', () => {
    setCachedRouteParse('key1', 'h1', [fileA], fakeResult)
    fs.rmSync(fileA)
    expect(getCachedRouteParse('key1', 'h1')).toBeNull()
  })

  it('keeps entries under different cache keys independent', () => {
    setCachedRouteParse('key1', 'h1', [fileA], fakeResult)
    expect(getCachedRouteParse('key2', 'h1')).toBeNull()
  })
})

describe('cachedRouteDependencies (Track C5 — the reload-scope dependency map)', () => {
  let tmpDir: string
  let fileA: string
  let fileB: string

  beforeEach(() => {
    clearPageParseCache()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'page-parse-cache-dep-'))
    fileA = path.join(tmpDir, 'A.tsx')
    fileB = path.join(tmpDir, 'B.tsx')
    fs.writeFileSync(fileA, 'export default function A() { return <div/> }', 'utf8')
    fs.writeFileSync(fileB, 'export default function B() { return <div/> }', 'utf8')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns null (unknown, never an empty map) when the cache holds no entries for this dir', () => {
    // "No data" and "no dependency" are different answers — the caller widens
    // to a full reload on the first and may narrow on the second.
    expect(cachedRouteDependencies(tmpDir)).toBeNull()
  })

  it('keys each route by the relPath half of its cache key, holding its recorded dependency set', () => {
    setCachedRouteParse(`${tmpDir}::pages/A.tsx`, 'h1', [fileA], fakeResult)
    // B's own parse resolved fileA as a local-component dependency — the
    // shared-component shape a narrow reload has to see.
    setCachedRouteParse(`${tmpDir}::pages/B.tsx`, 'h1', [fileB, fileA], fakeResult)

    const deps = cachedRouteDependencies(tmpDir)!
    expect([...deps.keys()].sort()).toEqual(['pages/A.tsx', 'pages/B.tsx'])
    expect([...deps.get('pages/A.tsx')!]).toEqual([fileA])
    expect(new Set(deps.get('pages/B.tsx')!)).toEqual(new Set([fileA, fileB]))
  })

  it('ignores entries for a DIFFERENT dir entirely', () => {
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'page-parse-cache-dep-other-'))
    try {
      setCachedRouteParse(`${otherDir}::pages/C.tsx`, 'h1', [fileA], fakeResult)
      expect(cachedRouteDependencies(tmpDir)).toBeNull()
      expect([...cachedRouteDependencies(otherDir)!.keys()]).toEqual(['pages/C.tsx'])
    } finally {
      fs.rmSync(otherDir, { recursive: true, force: true })
    }
  })

  it('reports dependencies from a STALE entry too — it reads the recorded keys, never the mtimes', () => {
    // The write that triggers a reload moves a tracked file's mtime by
    // construction, so an entry that would MISS `getCachedRouteParse` still
    // tells the truth about which files that route read.
    setCachedRouteParse(`${tmpDir}::pages/A.tsx`, 'h1', [fileA], fakeResult)
    const bumped = new Date(fs.statSync(fileA).mtime.getTime() + 5000)
    fs.writeFileSync(fileA, 'export default function A() { return <span/> }', 'utf8')
    fs.utimesSync(fileA, bumped, bumped)

    expect(getCachedRouteParse(`${tmpDir}::pages/A.tsx`, 'h1')).toBeNull()
    expect([...cachedRouteDependencies(tmpDir)!.get('pages/A.tsx')!]).toEqual([fileA])
  })
})

describe('hashWorkspaceConfig', () => {
  it('is stable for the same input', () => {
    expect(hashWorkspaceConfig(['next-app', 'en', { a: { b: 'c' } }]))
      .toBe(hashWorkspaceConfig(['next-app', 'en', { a: { b: 'c' } }]))
  })

  it('differs when any part differs', () => {
    expect(hashWorkspaceConfig(['next-app', 'en'])).not.toBe(hashWorkspaceConfig(['next-app', 'fr']))
    expect(hashWorkspaceConfig(['next-app'])).not.toBe(hashWorkspaceConfig(['pages']))
  })
})
