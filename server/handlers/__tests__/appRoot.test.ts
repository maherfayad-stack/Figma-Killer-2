/**
 * appRoot.ts — unit tests for `approot-01`'s shared resolver.
 *
 * `joinAppRoot` is the pure join-and-containment primitive; `resolveAppRoot`
 * is the cache-or-fresh-probe convenience wrapper every `dir`-only consumer
 * (`installDeps.ts`, `componentBundle.ts`) actually calls.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { joinAppRoot, resolveAppRoot } from '../studio/appRoot'
import { writeStudioMeta } from '../studio/studioMeta'
import { PROBE_VERSION, type ProjectProfile } from '../studio/projectProfileSchema'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-root-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function write(relPath: string, contents: string): void {
  const full = path.join(tmpDir, ...relPath.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents, 'utf8')
}

describe('joinAppRoot', () => {
  it('returns dir unchanged when appRoot is empty', () => {
    expect(joinAppRoot(tmpDir, '')).toBe(path.resolve(tmpDir))
  })

  it('joins a valid nested appRoot that exists inside dir', () => {
    fs.mkdirSync(path.join(tmpDir, 'firmware-console'), { recursive: true })
    expect(joinAppRoot(tmpDir, 'firmware-console')).toBe(path.resolve(tmpDir, 'firmware-console'))
  })

  it('falls back to dir when the candidate does not exist on disk (a stale cache)', () => {
    // Never created — the containment check's realpath resolution fails closed.
    expect(joinAppRoot(tmpDir, 'never-created')).toBe(path.resolve(tmpDir));
  })

  it('falls back to dir rather than trusting a traversal escape, even though the candidate resolves to a REAL directory outside dir', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'app-root-outside-'))
    try {
      // Simulates a hand-edited `.studio/meta.json` whose cached `profile.appRoot`
      // was tampered with — `appRoot` is schema-typed as a bare string with no
      // traversal check of its own (same posture `pagesDir`'s belt-and-braces
      // guard already documents), so this module is the one place that must
      // still refuse it.
      const relTraversal = path.relative(tmpDir, outside).split(path.sep).join('/')
      expect(joinAppRoot(tmpDir, relTraversal)).toBe(path.resolve(tmpDir))
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe('resolveAppRoot', () => {
  it('reads the CACHED profile.appRoot without re-probing', () => {
    fs.mkdirSync(path.join(tmpDir, 'cached-app'), { recursive: true })
    const cachedProfile = {
      // Without this the cache is below `PROBE_VERSION`, i.e. provably stale,
      // and `resolveProjectProfile` correctly re-probes instead of serving it.
      probeVersion: PROBE_VERSION,
      framework: 'unknown',
      appRoot: 'cached-app',
      pagesDir: 'cached-app/pages',
      routeStyle: 'flat',
      entryFiles: [],
      packageManager: 'bun',
      styleToolchain: { tailwind: null, cssModules: false, sass: false, postcssConfigPath: null, cssInJs: null },
      componentPackages: [],
      colorScheme: { mechanism: 'none' },
      aliases: {},
      warnings: [],
    } satisfies ProjectProfile
    writeStudioMeta(tmpDir, { profile: cachedProfile })

    // A live probe of this fixture would find NO package.json anywhere and
    // return appRoot: '' — proving the cache was used, not a fresh probe.
    expect(resolveAppRoot(tmpDir)).toBe(path.resolve(tmpDir, 'cached-app'))
  })

  it('probes fresh when no cached profile exists', () => {
    write('firmware-console/package.json', JSON.stringify({ name: 'firmware-console' }))
    expect(resolveAppRoot(tmpDir)).toBe(path.resolve(tmpDir, 'firmware-console'))
  })

  it('returns dir itself for the common case — no app-root indirection', () => {
    write('package.json', JSON.stringify({ name: 'fixture' }))
    expect(resolveAppRoot(tmpDir)).toBe(path.resolve(tmpDir))
  })
})
