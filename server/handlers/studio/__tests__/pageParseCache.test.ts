/**
 * pageParseCache.ts — unit tests over real temp files (stamp-based
 * invalidation needs a real filesystem clock, not a mock).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { clearFileDigests, digestOf, fileStamp } from '../loadDigest'
import {
  cachedRouteDependencies,
  clearPageParseCache,
  flushParseCacheWrites,
  getCachedRouteParse,
  setCachedRouteParse,
  type CachedRouteParse,
  type RouteCacheScope,
} from '../pageParseCache'
import { clearParseCacheSigningKeys } from '../parseCacheStore'

const fakeResult: CachedRouteParse = {
  expanded: { rootIds: ['a'], nodes: { a: { id: 'a', kind: 'element', name: 'div', props: {}, children: [], loc: { file: 'A.tsx', line: 1, col: 1 }, locked: false } } },
  componentSources: {},
}

/** A scope whose work began well after the fixture files were written, and whose files are not in any `Project`. */
function scope(dir: string, configHash = 'h1', overrides: Partial<RouteCacheScope> = {}): RouteCacheScope {
  return { dir, configHash, preferredKey: undefined, startedAt: Date.now() + 60_000, projectStamp: () => undefined, ...overrides }
}

function bump(file: string, text: string): void {
  const later = new Date(fs.statSync(file).mtime.getTime() + 5000)
  fs.writeFileSync(file, text, 'utf8')
  fs.utimesSync(file, later, later)
}

let dataDir: string
let savedDataDir: string | undefined

beforeEach(() => {
  savedDataDir = process.env.STUDIO_DATA_DIR
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'page-parse-cache-data-'))
  process.env.STUDIO_DATA_DIR = dataDir
  clearParseCacheSigningKeys()
  clearPageParseCache()
  clearFileDigests()
})

afterEach(() => {
  if (savedDataDir === undefined) delete process.env.STUDIO_DATA_DIR
  else process.env.STUDIO_DATA_DIR = savedDataDir
  clearParseCacheSigningKeys()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe('pageParseCache — memory tier', () => {
  let tmpDir: string
  let fileA: string
  let fileB: string

  beforeEach(() => {
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
    expect(getCachedRouteParse(scope(tmpDir), 'A.tsx')).toBeNull()
  })

  it('hits after a write with unchanged files and config, and reports the recorded stamps', () => {
    setCachedRouteParse(scope(tmpDir), 'A.tsx', [fileA], fakeResult)
    const hit = getCachedRouteParse(scope(tmpDir), 'A.tsx')!
    expect({ expanded: hit.expanded, componentSources: hit.componentSources }).toEqual(fakeResult)
    expect([...hit.dependencies]).toEqual([[fileA, fileStamp(fileA)]])
  })

  it('misses when the config hash changes — a workspace-wide input, not a per-file one', () => {
    setCachedRouteParse(scope(tmpDir), 'A.tsx', [fileA], fakeResult)
    expect(getCachedRouteParse(scope(tmpDir, 'h2'), 'A.tsx')).toBeNull()
  })

  it('misses once the tracked file itself is edited', () => {
    setCachedRouteParse(scope(tmpDir), 'A.tsx', [fileA], fakeResult)
    bump(fileA, 'export default function A() { return <span/> }')
    expect(getCachedRouteParse(scope(tmpDir), 'A.tsx')).toBeNull()
  })

  it('misses when a DEPENDENCY file is edited, even though the route\'s own file did not change', () => {
    setCachedRouteParse(scope(tmpDir), 'A.tsx', [fileA, fileB], fakeResult)
    bump(fileB, 'export default function B() { return <p/> }')
    expect(getCachedRouteParse(scope(tmpDir), 'A.tsx')).toBeNull()
  })

  it('misses once a tracked file is deleted', () => {
    setCachedRouteParse(scope(tmpDir), 'A.tsx', [fileA], fakeResult)
    fs.rmSync(fileA)
    expect(getCachedRouteParse(scope(tmpDir), 'A.tsx')).toBeNull()
  })

  it('a dependency recorded MISSING invalidates the entry when it appears — absence is a dependency (P6-B)', () => {
    const card = path.join(tmpDir, 'Card.tsx')
    setCachedRouteParse(scope(tmpDir), 'A.tsx', [fileA, card], fakeResult)
    expect(getCachedRouteParse(scope(tmpDir), 'A.tsx')).not.toBeNull()
    fs.writeFileSync(card, 'export function Card() { return <b/> }', 'utf8')
    expect(getCachedRouteParse(scope(tmpDir), 'A.tsx')).toBeNull()
  })

  it('keeps entries under different routes independent', () => {
    setCachedRouteParse(scope(tmpDir), 'A.tsx', [fileA], fakeResult)
    expect(getCachedRouteParse(scope(tmpDir), 'B.tsx')).toBeNull()
  })
})

describe('pageParseCache — the race rule', () => {
  let tmpDir: string
  let fileA: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'page-parse-cache-race-'))
    fileA = path.join(tmpDir, 'A.tsx')
    fs.writeFileSync(fileA, 'export default function A() { return <div/> }', 'utf8')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('does not cache a parse when a file read straight off disk was written after the work began', () => {
    const racing = scope(tmpDir, 'h1', { startedAt: Date.now() - 60_000 })
    expect(setCachedRouteParse(racing, 'A.tsx', [fileA], fakeResult)).toBeNull()
    expect(getCachedRouteParse(scope(tmpDir), 'A.tsx')).toBeNull()
  })

  it('does not cache a parse when the Project\'s copy of a file is not the version on disk', () => {
    const behind = scope(tmpDir, 'h1', { projectStamp: () => '1:1' })
    expect(setCachedRouteParse(behind, 'A.tsx', [fileA], fakeResult)).toBeNull()
    expect(getCachedRouteParse(scope(tmpDir), 'A.tsx')).toBeNull()
  })

  it('caches when the Project\'s copy IS the version on disk, however recently it was written', () => {
    const current = scope(tmpDir, 'h1', { startedAt: Date.now() - 60_000, projectStamp: (file) => fileStamp(file) })
    expect(setCachedRouteParse(current, 'A.tsx', [fileA], fakeResult)).not.toBeNull()
  })
})

describe('pageParseCache — disk tier', () => {
  let tmpDir: string
  let fileA: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'page-parse-cache-disk-'))
    fileA = path.join(tmpDir, 'A.tsx')
    fs.writeFileSync(fileA, 'export default function A() { return <div/> }', 'utf8')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('a new process (memory cleared) is answered from disk while the dependency bytes match', () => {
    setCachedRouteParse(scope(tmpDir), 'A.tsx', [fileA], fakeResult)
    flushParseCacheWrites()
    clearPageParseCache()
    clearFileDigests()
    const hit = getCachedRouteParse(scope(tmpDir), 'A.tsx')
    expect(hit && { expanded: hit.expanded, componentSources: hit.componentSources }).toEqual(fakeResult)
  })

  it('a disk entry whose dependency changed while no process was watching is a miss', () => {
    setCachedRouteParse(scope(tmpDir), 'A.tsx', [fileA], fakeResult)
    flushParseCacheWrites()
    clearPageParseCache()
    bump(fileA, 'export default function A() { return <section/> }')
    expect(getCachedRouteParse(scope(tmpDir), 'A.tsx')).toBeNull()
  })

  it('a disk entry is compared by CONTENT: a rewrite with the same bytes (new mtime) still hits', () => {
    setCachedRouteParse(scope(tmpDir), 'A.tsx', [fileA], fakeResult)
    flushParseCacheWrites()
    clearPageParseCache()
    bump(fileA, fs.readFileSync(fileA, 'utf8'))
    expect(getCachedRouteParse(scope(tmpDir), 'A.tsx')).not.toBeNull()
  })

  it('the disk write waits for the drain, and a dependency that moved before it leaves no entry', () => {
    setCachedRouteParse(scope(tmpDir), 'A.tsx', [fileA], fakeResult)
    bump(fileA, 'export default function A() { return <section/> }')
    flushParseCacheWrites()
    clearPageParseCache()
    clearFileDigests()
    expect(getCachedRouteParse(scope(tmpDir), 'A.tsx')).toBeNull()
  })

  it('a disk entry from a different locale or config is a miss', () => {
    setCachedRouteParse(scope(tmpDir), 'A.tsx', [fileA], fakeResult)
    flushParseCacheWrites()
    clearPageParseCache()
    expect(getCachedRouteParse(scope(tmpDir, 'h2'), 'A.tsx')).toBeNull()
    expect(getCachedRouteParse(scope(tmpDir, 'h1', { preferredKey: 'fr' }), 'A.tsx')).toBeNull()
  })
})

describe('cachedRouteDependencies (Track C5 — the reload-scope dependency map)', () => {
  let tmpDir: string
  let fileA: string
  let fileB: string

  beforeEach(() => {
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

  it('keys each route by the route half of its cache key, holding its recorded dependency set', () => {
    setCachedRouteParse(scope(tmpDir), 'pages/A.tsx', [fileA], fakeResult)
    // B's own parse resolved fileA as a local-component dependency — the
    // shared-component shape a narrow reload has to see.
    setCachedRouteParse(scope(tmpDir), 'pages/B.tsx', [fileB, fileA], fakeResult)

    const deps = cachedRouteDependencies(tmpDir)!
    expect([...deps.keys()].sort()).toEqual(['pages/A.tsx', 'pages/B.tsx'])
    expect([...deps.get('pages/A.tsx')!]).toEqual([fileA])
    expect(new Set(deps.get('pages/B.tsx')!)).toEqual(new Set([fileA, fileB]))
  })

  it('ignores entries for a DIFFERENT dir entirely', () => {
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'page-parse-cache-dep-other-'))
    try {
      setCachedRouteParse(scope(otherDir), 'pages/C.tsx', [fileA], fakeResult)
      expect(cachedRouteDependencies(tmpDir)).toBeNull()
      expect([...cachedRouteDependencies(otherDir)!.keys()]).toEqual(['pages/C.tsx'])
    } finally {
      fs.rmSync(otherDir, { recursive: true, force: true })
    }
  })

  it('reports dependencies from a STALE entry too — it reads the recorded keys, never the stamps', () => {
    // The write that triggers a reload moves a tracked file's stamp by
    // construction, so an entry that would MISS `getCachedRouteParse` still
    // tells the truth about which files that route read.
    setCachedRouteParse(scope(tmpDir), 'pages/A.tsx', [fileA], fakeResult)
    bump(fileA, 'export default function A() { return <span/> }')

    expect(getCachedRouteParse(scope(tmpDir), 'pages/A.tsx')).toBeNull()
    expect([...cachedRouteDependencies(tmpDir)!.get('pages/A.tsx')!]).toEqual([fileA])
  })
})

describe('digestOf', () => {
  it('is stable for the same input', () => {
    expect(digestOf(['next-app', 'en', { a: { b: 'c' } }])).toBe(digestOf(['next-app', 'en', { a: { b: 'c' } }]))
  })

  it('differs when any part differs', () => {
    expect(digestOf(['next-app', 'en'])).not.toBe(digestOf(['next-app', 'fr']))
    expect(digestOf(['next-app'])).not.toBe(digestOf(['pages']))
  })
})
