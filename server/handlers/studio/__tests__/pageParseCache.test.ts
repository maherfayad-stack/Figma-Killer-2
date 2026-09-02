/**
 * pageParseCache.ts — unit tests over real temp files (mtime-based
 * invalidation needs a real filesystem clock, not a mock).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  anyOtherRouteDependsOnFile,
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

describe('anyOtherRouteDependsOnFile (Track C5 — reload-scope safety check)', () => {
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

  it('returns null (unknown) when the cache holds no entries at all for this dir', () => {
    expect(anyOtherRouteDependsOnFile(tmpDir, fileA, new Set())).toBeNull()
  })

  it('returns false when every OTHER cached route is checked and none depend on the file', () => {
    setCachedRouteParse(`${tmpDir}::pages/A.tsx`, 'h1', [fileA], fakeResult)
    setCachedRouteParse(`${tmpDir}::pages/B.tsx`, 'h1', [fileB], fakeResult)
    // Excludes A's own entry (the route about to be re-parsed); B's recorded
    // deps are just its own file, which is not A's file.
    expect(anyOtherRouteDependsOnFile(tmpDir, fileA, new Set([`${tmpDir}::pages/A.tsx`]))).toBe(false)
  })

  it('returns true when an OTHER route (not excluded) recorded the file as a dependency — a locally-inlined component shared across pages', () => {
    // B's own parse resolved fileA as a local-component dependency (e.g. `B.tsx` imports `A.tsx`).
    setCachedRouteParse(`${tmpDir}::pages/A.tsx`, 'h1', [fileA], fakeResult)
    setCachedRouteParse(`${tmpDir}::pages/B.tsx`, 'h1', [fileB, fileA], fakeResult)
    expect(anyOtherRouteDependsOnFile(tmpDir, fileA, new Set([`${tmpDir}::pages/A.tsx`]))).toBe(true)
  })

  it('ignores entries for a DIFFERENT dir entirely', () => {
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'page-parse-cache-dep-other-'))
    try {
      setCachedRouteParse(`${otherDir}::pages/C.tsx`, 'h1', [fileA], fakeResult) // pathological but shouldn't matter — different dir prefix
      expect(anyOtherRouteDependsOnFile(tmpDir, fileA, new Set())).toBeNull() // no entries for `tmpDir`, still unknown
    } finally {
      fs.rmSync(otherDir, { recursive: true, force: true })
    }
  })

  it('an excluded cache key never counts as "another route", even if it happens to reference the file', () => {
    setCachedRouteParse(`${tmpDir}::pages/A.tsx`, 'h1', [fileA], fakeResult)
    expect(anyOtherRouteDependsOnFile(tmpDir, fileA, new Set([`${tmpDir}::pages/A.tsx`]))).toBe(false)
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
