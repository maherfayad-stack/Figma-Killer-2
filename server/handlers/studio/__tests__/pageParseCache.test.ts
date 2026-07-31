/**
 * pageParseCache.ts — unit tests over real temp files (mtime-based
 * invalidation needs a real filesystem clock, not a mock).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
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
