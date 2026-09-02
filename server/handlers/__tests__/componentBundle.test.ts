/**
 * componentBundle — WS-3.2 coverage. `runComponentBundleTask` (the
 * subprocess worker's own logic) is exercised DIRECTLY, never spawned, for
 * every case except one explicit end-to-end happy path — matching
 * `styleCompileWorker.test.ts`'s own precedent for testing a subprocess
 * entry point's logic without paying for a real process per case. External
 * packages (`react`, `react-dom`, …) never need to exist on disk: `Bun.build`
 * skips resolving anything named in `external` entirely.
 *
 * `tryServeStudioComponentBundle`'s own tests use a fixture dir created
 * INSIDE `projectsRootDir()` (`studio-workspace/`) — the route's own
 * containment guard (`isRealpathContained(dir, projectsRootDir())`, same
 * primitive `installDeps.test.ts` relies on for its own route tests) rejects
 * anything outside it, same as production. Only the temp folder each test
 * itself creates is ever removed — never a sibling real project.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { probeProject } from '../studio/projectProbe'
import { mergeStudioMeta } from '../studio/studioMeta'
import { projectsRootDir } from '../studioProjects'
import { runComponentBundleTask } from '../studio/componentBundleWorker'
import { computeBundleCacheKey, sanitizePackageName, tryServeStudioComponentBundle } from '../studio/componentBundle'

function write(dir: string, relPath: string, contents: string): string {
  const full = path.join(dir, ...relPath.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents, 'utf8')
  return full
}

// ---------------------------------------------------------------------------
// componentBundleWorker — build succeeds, externals stay external
// ---------------------------------------------------------------------------

describe('runComponentBundleTask', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'component-bundle-worker-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('builds a barrel bundle and keeps react/react-dom/jsx-runtime external', async () => {
    const cacheDir = path.join(tmpDir, '.studio', 'cache')
    fs.mkdirSync(cacheDir, { recursive: true })
    write(tmpDir, 'node_modules/acme-ui/package.json', JSON.stringify({ name: 'acme-ui', version: '1.0.0', main: 'index.js' }))
    write(
      tmpDir,
      'node_modules/acme-ui/index.js',
      ["import { createElement } from 'react'", 'export function Button(props) {', "  return createElement('button', null, props.label)", '}'].join('\n'),
    )
    const entryAbsPath = write(tmpDir, '.studio/cache/bundle-entry-test.ts', "export { Button as acme_ui__Button } from 'acme-ui'\n")
    const outputAbsPath = path.join(cacheDir, 'bundle-test.js')

    const result = await runComponentBundleTask({
      entryAbsPath,
      outputAbsPath,
      external: ['react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime'],
      maxBundleBytes: 10_000_000,
    })

    expect(result.ok).toBe(true)
    expect(result.errors).toEqual([])
    expect(fs.existsSync(outputAbsPath)).toBe(true)
    const output = fs.readFileSync(outputAbsPath, 'utf8')
    expect(output).toContain('acme_ui__Button')
    // The import stays a bare, unresolved specifier — proof `react` was
    // never inlined (Bun.build never even tried to resolve it from disk,
    // since it's in `external`; nothing named `react` exists in this
    // fixture's `node_modules` at all, and the build still succeeds).
    expect(output).toMatch(/from\s*["']react["']/)
  })

  it('refuses and deletes a bundle that exceeds the byte cap', async () => {
    const cacheDir = path.join(tmpDir, '.studio', 'cache')
    fs.mkdirSync(cacheDir, { recursive: true })
    write(tmpDir, 'node_modules/acme-ui/package.json', JSON.stringify({ name: 'acme-ui', version: '1.0.0', main: 'index.js' }))
    write(tmpDir, 'node_modules/acme-ui/index.js', 'export function Button() { return null }\n')
    const entryAbsPath = write(tmpDir, '.studio/cache/bundle-entry-cap.ts', "export { Button as acme_ui__Button } from 'acme-ui'\n")
    const outputAbsPath = path.join(cacheDir, 'bundle-cap.js')

    const result = await runComponentBundleTask({
      entryAbsPath,
      outputAbsPath,
      external: ['react'],
      maxBundleBytes: 1, // absurdly small — any real output exceeds it
    })

    expect(result.ok).toBe(false)
    expect(result.errors[0]).toContain('exceeding')
    expect(fs.existsSync(outputAbsPath)).toBe(false)
  })

  it('reports a build failure without throwing when the entry cannot resolve', async () => {
    const cacheDir = path.join(tmpDir, '.studio', 'cache')
    fs.mkdirSync(cacheDir, { recursive: true })
    const entryAbsPath = write(tmpDir, '.studio/cache/bundle-entry-missing.ts', "export { Button as x__Button } from 'does-not-exist'\n")
    const outputAbsPath = path.join(cacheDir, 'bundle-missing.js')

    const result = await runComponentBundleTask({ entryAbsPath, outputAbsPath, external: ['react'], maxBundleBytes: 10_000_000 })
    expect(result.ok).toBe(false)
    expect(result.errors.length).toBeGreaterThan(0)
    expect(fs.existsSync(outputAbsPath)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// computeBundleCacheKey — stable / changes with input
// ---------------------------------------------------------------------------

describe('computeBundleCacheKey', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'component-bundle-cachekey-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('is stable across identical inputs', () => {
    write(tmpDir, 'node_modules/acme-ui/package.json', JSON.stringify({ name: 'acme-ui', version: '1.0.0', types: 'index.d.ts' }))
    write(tmpDir, 'node_modules/acme-ui/index.d.ts', 'export declare const Button: React.FC<{}>\n')

    const first = computeBundleCacheKey(tmpDir, 'render-packages', ['acme-ui'])
    const second = computeBundleCacheKey(tmpDir, 'render-packages', ['acme-ui'])
    expect(first).toBe(second)
    expect(first).toMatch(/^[0-9a-f]{16}$/)
  })

  it('changes when the package version changes', () => {
    write(tmpDir, 'node_modules/acme-ui/package.json', JSON.stringify({ name: 'acme-ui', version: '1.0.0', types: 'index.d.ts' }))
    write(tmpDir, 'node_modules/acme-ui/index.d.ts', 'export declare const Button: React.FC<{}>\n')
    const before = computeBundleCacheKey(tmpDir, 'render-packages', ['acme-ui'])

    write(tmpDir, 'node_modules/acme-ui/package.json', JSON.stringify({ name: 'acme-ui', version: '2.0.0', types: 'index.d.ts' }))
    const after = computeBundleCacheKey(tmpDir, 'render-packages', ['acme-ui'])

    expect(after).not.toBe(before)
  })

  it('changes when the trust tier changes', () => {
    const a = computeBundleCacheKey(tmpDir, 'static', ['acme-ui'])
    const b = computeBundleCacheKey(tmpDir, 'render-packages', ['acme-ui'])
    expect(a).not.toBe(b)
  })
})

describe('sanitizePackageName', () => {
  it('turns a scoped package name into a valid identifier fragment', () => {
    expect(sanitizePackageName('@acme/ui')).toBe('_acme_ui')
    expect(sanitizePackageName('acme-ui')).toBe('acme_ui')
  })
})

// ---------------------------------------------------------------------------
// tryServeStudioComponentBundle — route-level refusals + one real build
// ---------------------------------------------------------------------------

describe('tryServeStudioComponentBundle', () => {
  let wsDir: string

  beforeEach(() => {
    const root = projectsRootDir()
    fs.mkdirSync(root, { recursive: true })
    wsDir = fs.mkdtempSync(path.join(root, '__component_bundle_test_'))
  })

  afterEach(() => {
    fs.rmSync(wsDir, { recursive: true, force: true })
  })

  function writePackageJson(fields: Record<string, unknown> = {}): void {
    write(wsDir, 'package.json', JSON.stringify({ name: 'fixture', ...fields }))
  }

  /** Forces `componentPackageDemand` to see `pkgNames` without needing a real regex-matching `.d.ts` — same shortcut `styleCompile.test.ts` uses for `trust` via `mergeStudioMeta`. */
  function forceComponentPackageDemand(pkgNames: string[]): void {
    const profile = probeProject(wsDir)
    mergeStudioMeta(wsDir, { profile: { ...profile, componentPackages: pkgNames } })
  }

  function installReactMatchingHost(): void {
    writePackageJson({ dependencies: { react: '^19.2.5' } })
  }

  function makeRequest(pathAndQuery: string, init?: RequestInit): { req: Request; url: URL; pathname: string } {
    const url = new URL(`http://localhost${pathAndQuery}`)
    const req = new Request(url, init)
    return { req, url, pathname: url.pathname }
  }

  function postBody(body: unknown) {
    return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
  }

  it('returns null for an unrelated path', async () => {
    const { req, url, pathname } = makeRequest('/admin/api/studio/other')
    expect(await tryServeStudioComponentBundle(req, url, pathname)).toBeNull()
  })

  it('rejects a dir outside studio-workspace/ without doing any work', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'component-bundle-outside-'))
    try {
      const { req, url, pathname } = makeRequest('/admin/api/studio/component-bundle', postBody({ dir: outside }))
      const res = await tryServeStudioComponentBundle(req, url, pathname)
      expect(res!.status).toBe(404)
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it('is a no-op success when no component package is demanded', async () => {
    const { req, url, pathname } = makeRequest('/admin/api/studio/component-bundle', postBody({ dir: wsDir }))
    const res = await tryServeStudioComponentBundle(req, url, pathname)
    const body = (await res!.json()) as { ok: boolean; components: unknown[] }
    expect(body.ok).toBe(true)
    expect(body.components).toEqual([])
  })

  it('refuses at Tier 0 (static, the default) without ever spawning the bundler', async () => {
    forceComponentPackageDemand(['acme-ui'])
    // Trust is left at the default — never explicitly promoted.

    const { req, url, pathname } = makeRequest('/admin/api/studio/component-bundle', postBody({ dir: wsDir }))
    const res = await tryServeStudioComponentBundle(req, url, pathname)
    const body = (await res!.json()) as { ok: boolean; code?: string }
    expect(body.ok).toBe(false)
    expect(body.code).toBe('trust-tier-required')
    // Nothing under .studio/cache should exist — the route returned before
    // doing any Tier-1-shaped work.
    expect(fs.existsSync(path.join(wsDir, '.studio', 'cache'))).toBe(false)
  })

  it('proceeds when the workspace names no react anywhere', async () => {
    // This used to refuse with `react-not-declared`, which made an absence of
    // evidence into evidence of a problem and blocked EVERY project Studio
    // itself creates (`projectSeed.ts` writes a package.json declaring only
    // the design system). React is in `EXTERNAL_SPECIFIERS`, so the bundle
    // carries no React of its own and the components run on the editor's —
    // a project with no React of its own is the case with the LEAST risk of
    // the duplicate-React "Invalid hook call" this gate exists to prevent,
    // not the most.
    forceComponentPackageDemand(['acme-ui'])
    mergeStudioMeta(wsDir, { trust: 'render-packages' })
    writePackageJson({}) // no react dependency at all

    const { req, url, pathname } = makeRequest('/admin/api/studio/component-bundle', postBody({ dir: wsDir }))
    const res = await tryServeStudioComponentBundle(req, url, pathname)
    const body = (await res!.json()) as { ok: boolean; code?: string }
    // Got PAST the react gate — it fails later, on the fixture having no real
    // package to extract components from, which is a different refusal.
    expect(body.code).not.toBe('react-not-declared')
    expect(body.code).toBe('no-components-found')
  })

  it('reads react from peerDependencies, which is where a library declares it', async () => {
    forceComponentPackageDemand(['acme-ui'])
    mergeStudioMeta(wsDir, { trust: 'render-packages' })
    writePackageJson({ peerDependencies: { react: '^18.2.0' } })

    const { req, url, pathname } = makeRequest('/admin/api/studio/component-bundle', postBody({ dir: wsDir }))
    const res = await tryServeStudioComponentBundle(req, url, pathname)
    const body = (await res!.json()) as { ok: boolean; code?: string }
    // Host is React 19, so a peer-declared 18 is a real, known mismatch.
    expect(body.ok).toBe(false)
    expect(body.code).toBe('react-version-mismatch')
  })

  it('falls back to the INSTALLED react when nothing is declared', async () => {
    // "Declared nowhere, installed anyway" is the normal shape for a
    // transitive install. The installed copy is real evidence, so a mismatch
    // there must still refuse rather than sail through as "unknown".
    forceComponentPackageDemand(['acme-ui'])
    mergeStudioMeta(wsDir, { trust: 'render-packages' })
    writePackageJson({})
    write(wsDir, 'node_modules/react/package.json', JSON.stringify({ name: 'react', version: '18.3.1' }))

    const { req, url, pathname } = makeRequest('/admin/api/studio/component-bundle', postBody({ dir: wsDir }))
    const res = await tryServeStudioComponentBundle(req, url, pathname)
    const body = (await res!.json()) as { ok: boolean; code?: string }
    expect(body.ok).toBe(false)
    expect(body.code).toBe('react-version-mismatch')
  })

  it('approot-01 — reads the react-version check from a NESTED app root, not the project directory', async () => {
    // No package.json at wsDir root at all — only inside a nested app dir,
    // same shape as the real eSIM corpus. Shares no naming with it —
    // genericRepoShapes.test.ts discipline.
    write(wsDir, 'firmware-console/package.json', JSON.stringify({ name: 'firmware-console', dependencies: { react: '^18.2.0' } }))
    forceComponentPackageDemand(['acme-ui']) // probeProject(wsDir) now detects appRoot: 'firmware-console'
    mergeStudioMeta(wsDir, { trust: 'render-packages' })

    const { req, url, pathname } = makeRequest('/admin/api/studio/component-bundle', postBody({ dir: wsDir }))
    const res = await tryServeStudioComponentBundle(req, url, pathname)
    const body = (await res!.json()) as { ok: boolean; code?: string; message?: string }
    // A project-root read would find NO package.json at all, know nothing
    // about React, and sail straight past the version gate — this refusal is
    // only reachable if the NESTED package.json's react@18 was actually read
    // and compared against the host's 19.
    expect(body.ok).toBe(false)
    expect(body.code).toBe('react-version-mismatch')
  })

  it('refuses on a React major-version mismatch, with a clear message, rather than crashing on render', async () => {
    forceComponentPackageDemand(['acme-ui'])
    mergeStudioMeta(wsDir, { trust: 'render-packages' })
    writePackageJson({ dependencies: { react: '^18.2.0' } }) // host is React 19

    const { req, url, pathname } = makeRequest('/admin/api/studio/component-bundle', postBody({ dir: wsDir }))
    const res = await tryServeStudioComponentBundle(req, url, pathname)
    const body = (await res!.json()) as { ok: boolean; code?: string; message?: string }
    expect(body.ok).toBe(false)
    expect(body.code).toBe('react-version-mismatch')
    expect(body.message).toMatch(/18/)
    expect(body.message).toMatch(/19/)
  })

  it('refuses with no-components-found when the only demanded package resolves nothing (symlink escape), when the host permits creating one', async () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'component-bundle-escape-'))
    try {
      forceComponentPackageDemand(['evil-ui'])
      mergeStudioMeta(wsDir, { trust: 'render-packages' })
      installReactMatchingHost()

      write(wsDir, 'node_modules/evil-ui/package.json', JSON.stringify({ name: 'evil-ui', version: '1.0.0', types: 'index.d.ts' }))
      const maliciousDts = path.join(outsideDir, 'index.d.ts')
      fs.writeFileSync(maliciousDts, 'export declare const Button: React.FC<{}>\n', 'utf8')
      const linkPath = path.join(wsDir, 'node_modules', 'evil-ui', 'index.d.ts')

      try {
        fs.symlinkSync(maliciousDts, linkPath, 'file')
      } catch {
        return // host refuses symlinks (Windows without Developer Mode) — nothing to test
      }

      const { req, url, pathname } = makeRequest('/admin/api/studio/component-bundle', postBody({ dir: wsDir }))
      const res = await tryServeStudioComponentBundle(req, url, pathname)
      const body = (await res!.json()) as { ok: boolean; code?: string }
      expect(body.ok).toBe(false)
      expect(body.code).toBe('no-components-found')
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true })
    }
  })

  it('builds end-to-end (Tier 1, real subprocess) and serves the bundle back over GET', async () => {
    forceComponentPackageDemand(['acme-ui'])
    mergeStudioMeta(wsDir, { trust: 'render-packages' })
    installReactMatchingHost()
    write(wsDir, 'node_modules/acme-ui/package.json', JSON.stringify({ name: 'acme-ui', version: '1.0.0', main: 'index.js', types: 'index.d.ts' }))
    write(
      wsDir,
      'node_modules/acme-ui/index.js',
      ["import { createElement } from 'react'", 'export function Button(props) {', "  return createElement('button', null, props.label)", '}'].join('\n'),
    )
    write(
      wsDir,
      'node_modules/acme-ui/index.d.ts',
      ['export interface ButtonProps { label: string }', 'export declare function Button(props: ButtonProps): JSX.Element'].join('\n'),
    )

    const { req, url, pathname } = makeRequest('/admin/api/studio/component-bundle', postBody({ dir: wsDir }))
    const res = await tryServeStudioComponentBundle(req, url, pathname)
    const body = (await res!.json()) as {
      ok: boolean
      url?: string
      hash?: string
      components: Array<{ name: string; pkg: string }>
    }

    expect(body.ok).toBe(true)
    expect(body.hash).toMatch(/^[0-9a-f]{16}$/)
    expect(body.components).toEqual([expect.objectContaining({ name: 'Button', pkg: 'acme-ui' })])
    expect(fs.existsSync(path.join(wsDir, '.studio', 'cache', `bundle-${body.hash}.js`))).toBe(true)
    // The generated barrel entry is scaffolding, not the artefact — cleaned up either way.
    expect(fs.existsSync(path.join(wsDir, '.studio', 'cache', `bundle-entry-${body.hash}.ts`))).toBe(false)

    // A second POST hits the cache — same hash, no rebuild needed.
    const { req: req2, url: url2, pathname: pathname2 } = makeRequest('/admin/api/studio/component-bundle', postBody({ dir: wsDir }))
    const res2 = await tryServeStudioComponentBundle(req2, url2, pathname2)
    const body2 = (await res2!.json()) as { hash?: string }
    expect(body2.hash).toBe(body.hash)

    const { req: getReq, url: getUrl, pathname: getPathname } = makeRequest(
      `/admin/api/studio/component-bundle?dir=${encodeURIComponent(wsDir)}&hash=${body.hash}`,
    )
    const getRes = await tryServeStudioComponentBundle(getReq, getUrl, getPathname)
    expect(getRes?.status).toBe(200)
    const served = await getRes!.text()
    expect(served).toContain('acme_ui__Button')
  }, 20_000)

  it('GET refuses an unknown/malformed hash', async () => {
    const { req, url, pathname } = makeRequest(`/admin/api/studio/component-bundle?dir=${encodeURIComponent(wsDir)}&hash=not-a-hash`)
    const res = await tryServeStudioComponentBundle(req, url, pathname)
    expect(res?.status).toBe(404)
  })
})
