/**
 * compareVerdictCache.ts — unit tests over real temp files, same posture as
 * `pageParseCache.test.ts` (mtime-based invalidation needs a real filesystem
 * clock, not a mock).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  buildCompareCacheKey,
  clearCompareVerdictCache,
  getCachedCompareVerdict,
  setCachedCompareVerdict,
  type CachedCompareVerdict,
} from './compareVerdictCache'

const fakeVerdict: CachedCompareVerdict = {
  pass: true,
  verdict: 'Matches the reference.',
  similarityScore: 99.5,
  diffPercent: 0.5,
  capture: { width: 100, height: 100, dpr: 1, dimensionMatch: 'exact' },
  structuralRegionCount: 0,
  regions: [],
  regionsTruncated: false,
  images: { screenBase64: 'a', referenceBase64: 'b', referenceMimeType: 'image/png', diffBase64: 'c' },
}

describe('compareVerdictCache', () => {
  let tmpDir: string
  let pageFile: string
  let cssFile: string

  beforeEach(() => {
    clearCompareVerdictCache()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compare-verdict-cache-'))
    pageFile = path.join(tmpDir, 'Home.tsx')
    cssFile = path.join(tmpDir, 'Home.module.css')
    fs.writeFileSync(pageFile, 'export default function Home() { return <div/> }', 'utf8')
    fs.writeFileSync(cssFile, '.page { color: currentColor; }', 'utf8')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('misses a cold key', () => {
    const key = buildCompareCacheKey(tmpDir, 'home', 'ref-1', 98, 1.5, 6)
    expect(getCachedCompareVerdict(key)).toBeNull()
  })

  it('hits after a write with every tracked file unchanged', () => {
    const key = buildCompareCacheKey(tmpDir, 'home', 'ref-1', 98, 1.5, 6)
    setCachedCompareVerdict(key, [pageFile, cssFile], fakeVerdict)
    expect(getCachedCompareVerdict(key)).toEqual(fakeVerdict)
  })

  it('misses once the page\'s own file is edited', () => {
    const key = buildCompareCacheKey(tmpDir, 'home', 'ref-1', 98, 1.5, 6)
    setCachedCompareVerdict(key, [pageFile, cssFile], fakeVerdict)
    expect(getCachedCompareVerdict(key)).toEqual(fakeVerdict)

    const bumped = new Date(fs.statSync(pageFile).mtime.getTime() + 5000)
    fs.writeFileSync(pageFile, 'export default function Home() { return <span/> }', 'utf8')
    fs.utimesSync(pageFile, bumped, bumped)

    expect(getCachedCompareVerdict(key)).toBeNull()
  })

  it('misses once an imported stylesheet is edited, even though the page\'s own file did not change', () => {
    const key = buildCompareCacheKey(tmpDir, 'home', 'ref-1', 98, 1.5, 6)
    setCachedCompareVerdict(key, [pageFile, cssFile], fakeVerdict)
    expect(getCachedCompareVerdict(key)).toEqual(fakeVerdict)

    const bumped = new Date(fs.statSync(cssFile).mtime.getTime() + 5000)
    fs.writeFileSync(cssFile, '.page { color: red; }', 'utf8')
    fs.utimesSync(cssFile, bumped, bumped)

    expect(getCachedCompareVerdict(key)).toBeNull()
  })

  it('misses once a tracked file is deleted', () => {
    const key = buildCompareCacheKey(tmpDir, 'home', 'ref-1', 98, 1.5, 6)
    setCachedCompareVerdict(key, [pageFile, cssFile], fakeVerdict)
    fs.rmSync(cssFile)
    expect(getCachedCompareVerdict(key)).toBeNull()
  })

  it('misses once a tracked file that did NOT exist at write time is later created — the create/delete transition a plain skip would hide', () => {
    const frameworkJson = path.join(tmpDir, '.studio', 'framework.json')
    const key = buildCompareCacheKey(tmpDir, 'home', 'ref-1', 98, 1.5, 6)
    setCachedCompareVerdict(key, [pageFile, cssFile, frameworkJson], fakeVerdict)
    expect(getCachedCompareVerdict(key)).toEqual(fakeVerdict)

    fs.mkdirSync(path.dirname(frameworkJson), { recursive: true })
    fs.writeFileSync(frameworkJson, '{}', 'utf8')

    expect(getCachedCompareVerdict(key)).toBeNull()
  })

  it('different thresholds/topN are different cache entries, not one shared verdict', () => {
    const keyA = buildCompareCacheKey(tmpDir, 'home', 'ref-1', 98, 1.5, 6)
    const keyB = buildCompareCacheKey(tmpDir, 'home', 'ref-1', 90, 1.5, 6)
    setCachedCompareVerdict(keyA, [pageFile], fakeVerdict)
    expect(getCachedCompareVerdict(keyA)).toEqual(fakeVerdict)
    expect(getCachedCompareVerdict(keyB)).toBeNull()
  })

  it('a different reference id is a different cache entry', () => {
    const keyA = buildCompareCacheKey(tmpDir, 'home', 'ref-1', 98, 1.5, 6)
    const keyB = buildCompareCacheKey(tmpDir, 'home', 'ref-2', 98, 1.5, 6)
    setCachedCompareVerdict(keyA, [pageFile], fakeVerdict)
    expect(getCachedCompareVerdict(keyB)).toBeNull()
  })
})
