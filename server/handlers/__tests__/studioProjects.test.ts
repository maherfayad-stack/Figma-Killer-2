/**
 * studioProjects.ts — unit tests for the configurable page-source override
 * (§1 of STUDIO-ESIM-IMPORT-PLAN.md): `projectPagesDir`'s meta-driven
 * resolution + containment guard, `discoverPageFiles`'s widened `.tsx`/`.jsx`
 * discovery, and `pageIdFromRelPath`'s widened extension strip on a nested
 * `.jsx` path. Fixture style mirrors `studio.test.ts`'s temp-dir pattern.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  collectAppRouterLayoutChain,
  discoverAppRouterRoutes,
  discoverPageFiles,
  mergeProjectFrameDefaults,
  projectPagesDir,
  renameProjectDisplayName,
  routeFromAppPageRelPath,
  writeProjectMeta,
} from '../studioProjects'
import { pageIdFromRelPath } from '../studioPageLoad'

describe('projectPagesDir', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-pages-dir-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('defaults to "<dir>/pages" when there is no meta.json at all', () => {
    expect(projectPagesDir(tmpDir)).toBe(path.join(tmpDir, 'pages'))
  })

  it('defaults to "<dir>/pages" when meta.json has no pagesDir field', () => {
    writeProjectMeta(tmpDir, { displayName: 'Untitled' })
    expect(projectPagesDir(tmpDir)).toBe(path.join(tmpDir, 'pages'))
  })

  it('honours a valid nested pagesDir override', () => {
    writeProjectMeta(tmpDir, { displayName: 'eSIM Journey', pagesDir: 'src/screens' })
    expect(projectPagesDir(tmpDir)).toBe(path.join(tmpDir, 'src', 'screens'))
  })

  it('honours a pagesDir override even when the meta has no displayName at all', () => {
    // A hand-written meta.json carrying ONLY pagesDir must not silently lose
    // the override just because it never set a display name.
    const metaFile = path.join(tmpDir, '.studio', 'meta.json')
    fs.mkdirSync(path.dirname(metaFile), { recursive: true })
    fs.writeFileSync(metaFile, JSON.stringify({ pagesDir: 'app/screens' }))
    expect(projectPagesDir(tmpDir)).toBe(path.join(tmpDir, 'app', 'screens'))
  })

  it('ignores a pagesDir override containing a ".." segment, falling back to the default', () => {
    writeProjectMeta(tmpDir, { displayName: 'Evil', pagesDir: '../../etc' })
    expect(projectPagesDir(tmpDir)).toBe(path.join(tmpDir, 'pages'))
  })

  it('ignores a pagesDir override that is an absolute path, falling back to the default', () => {
    const absoluteElsewhere = path.join(os.tmpdir(), 'somewhere-else')
    writeProjectMeta(tmpDir, { displayName: 'Evil', pagesDir: absoluteElsewhere })
    expect(projectPagesDir(tmpDir)).toBe(path.join(tmpDir, 'pages'))
  })

  it('ignores an empty-string pagesDir override, falling back to the default', () => {
    const metaFile = path.join(tmpDir, '.studio', 'meta.json')
    fs.mkdirSync(path.dirname(metaFile), { recursive: true })
    fs.writeFileSync(metaFile, JSON.stringify({ displayName: 'Blank', pagesDir: '   ' }))
    expect(projectPagesDir(tmpDir)).toBe(path.join(tmpDir, 'pages'))
  })

  it("falls back to the cached probe profile's pagesDir when there is no explicit override — WS-1.3's next-app case", () => {
    const metaFile = path.join(tmpDir, '.studio', 'meta.json')
    fs.mkdirSync(path.dirname(metaFile), { recursive: true })
    fs.writeFileSync(
      metaFile,
      JSON.stringify({
        profile: {
          framework: 'next-app',
          pagesDir: 'app',
          routeStyle: 'file-router',
          entryFiles: [],
          packageManager: 'bun',
          styleToolchain: { tailwind: null, cssModules: false, sass: false, postcssConfigPath: null, cssInJs: null },
          componentPackages: [],
          aliases: {},
          warnings: [],
        },
      }),
    )
    expect(projectPagesDir(tmpDir)).toBe(path.join(tmpDir, 'app'))
  })

  it('prefers an explicit pagesDir override over the cached probe profile', () => {
    const metaFile = path.join(tmpDir, '.studio', 'meta.json')
    fs.mkdirSync(path.dirname(metaFile), { recursive: true })
    fs.writeFileSync(
      metaFile,
      JSON.stringify({
        pagesDir: 'src/screens',
        profile: {
          framework: 'next-app',
          pagesDir: 'app',
          routeStyle: 'file-router',
          entryFiles: [],
          packageManager: 'bun',
          styleToolchain: { tailwind: null, cssModules: false, sass: false, postcssConfigPath: null, cssInJs: null },
          componentPackages: [],
          aliases: {},
          warnings: [],
        },
      }),
    )
    expect(projectPagesDir(tmpDir)).toBe(path.join(tmpDir, 'src', 'screens'))
  })
})

/**
 * discoverPageFiles — widened to `.tsx` AND `.jsx` (§1.2), same recursive
 * walk/exclusion policy as before.
 */
describe('discoverPageFiles — .jsx/.tsx discovery', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-discover-jsx-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function write(relPath: string): void {
    const full = path.join(tmpDir, ...relPath.split('/'))
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, 'export default function X() { return null }', 'utf8')
  }

  it('finds a flat top-level .jsx file', () => {
    write('HomepageScreen.jsx')
    expect(discoverPageFiles(tmpDir)).toEqual(['HomepageScreen.jsx'])
  })

  it('finds both .tsx and .jsx files, recursively, in sorted order', () => {
    write('src/screens/HomepageScreen.jsx')
    write('src/screens/esim/QrCodeScreen.jsx')
    write('pages/About.tsx')
    expect(discoverPageFiles(tmpDir)).toEqual([
      'pages/About.tsx',
      'src/screens/HomepageScreen.jsx',
      'src/screens/esim/QrCodeScreen.jsx',
    ])
  })

  it('still ignores non-page files sitting alongside .jsx files', () => {
    write('Home.jsx')
    write('Home.module.css')
    write('README.md')
    expect(discoverPageFiles(tmpDir)).toEqual(['Home.jsx'])
  })
})

describe('renameProjectDisplayName', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-rename-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('changes the display name without disturbing an existing pagesDir override', () => {
    writeProjectMeta(tmpDir, { displayName: 'eSIM Journey', pagesDir: 'src/screens' })

    renameProjectDisplayName(tmpDir, 'eSIM Journey (renamed)')

    const metaFile = path.join(tmpDir, '.studio', 'meta.json')
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) as { displayName: string; pagesDir?: string }
    expect(meta.displayName).toBe('eSIM Journey (renamed)')
    expect(meta.pagesDir).toBe('src/screens')
    expect(projectPagesDir(tmpDir)).toBe(path.join(tmpDir, 'src', 'screens'))
  })

  it('sets the display name on a project with no prior meta.json at all', () => {
    renameProjectDisplayName(tmpDir, 'Untitled Renamed')
    const metaFile = path.join(tmpDir, '.studio', 'meta.json')
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) as { displayName: string }
    expect(meta.displayName).toBe('Untitled Renamed')
  })
})

describe('mergeProjectFrameDefaults — WS-7.2 "apply to all pages"', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-frame-defaults-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function readMeta(): Record<string, unknown> {
    const metaFile = path.join(tmpDir, '.studio', 'meta.json')
    return JSON.parse(fs.readFileSync(metaFile, 'utf8')) as Record<string, unknown>
  }

  it('writes a width-only default on a project with no prior meta.json', () => {
    const result = mergeProjectFrameDefaults(tmpDir, { width: 390 })
    expect(result).toEqual({ width: 390 })
    expect(readMeta().frameDefaults).toEqual({ width: 390 })
  })

  it('does not clobber displayName/pagesDir already saved on the project', () => {
    writeProjectMeta(tmpDir, { displayName: 'eSIM Journey', pagesDir: 'src/screens' })

    mergeProjectFrameDefaults(tmpDir, { width: 390 })

    const meta = readMeta()
    expect(meta.displayName).toBe('eSIM Journey')
    expect(meta.pagesDir).toBe('src/screens')
    expect(meta.frameDefaults).toEqual({ width: 390 })
  })

  it('a width-only merge preserves a previously-saved height', () => {
    mergeProjectFrameDefaults(tmpDir, { width: 390, height: 844 })
    const result = mergeProjectFrameDefaults(tmpDir, { width: 402 })
    expect(result).toEqual({ width: 402, height: 844 })
    expect(readMeta().frameDefaults).toEqual({ width: 402, height: 844 })
  })

  it('a height-only merge preserves a previously-saved width', () => {
    mergeProjectFrameDefaults(tmpDir, { width: 390, height: 844 })
    const result = mergeProjectFrameDefaults(tmpDir, { height: 852 })
    expect(result).toEqual({ width: 390, height: 852 })
  })
})

describe('pageIdFromRelPath — widened .jsx extension strip', () => {
  it('strips a nested .jsx path the same way it strips .tsx', () => {
    expect(pageIdFromRelPath('screens/esim/QrCodeScreen.jsx')).toBe('screens-esim-qr-code-screen')
  })

  it('still strips .tsx (non-regression)', () => {
    expect(pageIdFromRelPath('screens/esim/QrCodeScreen.tsx')).toBe('screens-esim-qr-code-screen')
  })
})

/**
 * WS-1.3 — the App Router route-derivation transform: `routeFromAppPageRelPath`.
 * Pure, so no fixture tree needed.
 */
describe('routeFromAppPageRelPath', () => {
  it('derives the root route for a page.tsx sitting directly in app/', () => {
    expect(routeFromAppPageRelPath('page.tsx')).toBe('/')
  })

  it('derives a plain nested route', () => {
    expect(routeFromAppPageRelPath('pricing/page.tsx')).toBe('/pricing')
  })

  it('strips a route group, which never appears in the URL', () => {
    expect(routeFromAppPageRelPath('(marketing)/pricing/page.tsx')).toBe('/pricing')
  })

  it('strips several route groups in the same path', () => {
    expect(routeFromAppPageRelPath('(marketing)/(shop)/products/page.tsx')).toBe('/products')
  })

  it('reduces an all-route-group path to the root route', () => {
    expect(routeFromAppPageRelPath('(marketing)/page.tsx')).toBe('/')
  })

  it('keeps a dynamic segment in a readable, non-bracketed form', () => {
    expect(routeFromAppPageRelPath('blog/[slug]/page.tsx')).toBe('/blog/:slug')
  })

  it('keeps a catch-all segment in a readable, non-bracketed form', () => {
    expect(routeFromAppPageRelPath('docs/[...slug]/page.tsx')).toBe('/docs/*slug')
  })

  it('keeps an optional catch-all segment in a readable, non-bracketed form', () => {
    expect(routeFromAppPageRelPath('docs/[[...slug]]/page.tsx')).toBe('/docs/*slug')
  })

  it('strips a parallel-route slot segment', () => {
    expect(routeFromAppPageRelPath('@modal/settings/page.tsx')).toBe('/settings')
  })

  it('handles a .jsx page file the same way as .tsx', () => {
    expect(routeFromAppPageRelPath('(marketing)/pricing/page.jsx')).toBe('/pricing')
  })
})

/**
 * WS-1.3 — `discoverAppRouterRoutes` on a fixture App Router tree combining
 * every shape the work order calls out: a route group, a nested layout, a
 * dynamic segment, and a `template.tsx` (present, but NOT a route of its
 * own — `template.tsx`/`layout.tsx` compose AROUND a route, `discoverPageFiles`
 * proves in the sibling describe block below that this fixture would NOT be
 * read this way for a non-Next project).
 */
describe('discoverAppRouterRoutes', () => {
  let tmpDir: string
  let appDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-app-router-discover-'))
    appDir = path.join(tmpDir, 'app')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function write(relPath: string): void {
    const full = path.join(appDir, ...relPath.split('/'))
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, 'export default function X() { return null }', 'utf8')
  }

  it('finds only page.tsx files as routes — layout/template/route/loading files are not routes of their own', () => {
    write('layout.tsx')
    write('page.tsx')
    write('(marketing)/layout.tsx')
    write('(marketing)/pricing/page.tsx')
    write('(marketing)/blog/[slug]/page.tsx')
    write('(marketing)/blog/[slug]/template.tsx')
    write('dashboard/page.tsx')
    write('dashboard/loading.tsx')
    write('api/hello/route.ts')

    const routes = discoverAppRouterRoutes(appDir)
    expect(routes.map((r) => r.route).sort()).toEqual(['/', '/blog/:slug', '/dashboard', '/pricing'].sort())
    // Every discovered route's relPath really is a page.tsx/page.jsx file.
    for (const r of routes) expect(/(^|\/)page\.(tsx|jsx)$/.test(r.relPath)).toBe(true)
  })

  it('returns an empty list for a directory with no page.tsx anywhere', () => {
    write('layout.tsx')
    write('components/Button.tsx')
    expect(discoverAppRouterRoutes(appDir)).toEqual([])
  })
})

/**
 * WS-1.3 — `collectAppRouterLayoutChain`: outermost layout first, down to
 * (not including) the page's own file.
 */
describe('collectAppRouterLayoutChain', () => {
  let tmpDir: string
  let appDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-app-router-layout-chain-'))
    appDir = path.join(tmpDir, 'app')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function write(relPath: string): void {
    const full = path.join(appDir, ...relPath.split('/'))
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, 'export default function X() { return null }', 'utf8')
  }

  it('collects a root layout plus a segment layout, outermost first, for a route inside a route group', () => {
    write('layout.tsx')
    write('(marketing)/layout.tsx')
    write('(marketing)/pricing/page.tsx')

    expect(collectAppRouterLayoutChain(appDir, '(marketing)/pricing/page.tsx')).toEqual([
      'layout.tsx',
      '(marketing)/layout.tsx',
    ])
  })

  it('skips a directory level with no layout.tsx/jsx of its own', () => {
    write('layout.tsx')
    // No (marketing)/layout.tsx this time.
    write('(marketing)/pricing/page.tsx')

    expect(collectAppRouterLayoutChain(appDir, '(marketing)/pricing/page.tsx')).toEqual(['layout.tsx'])
  })

  it('returns an empty chain when there is no layout anywhere in the route', () => {
    write('pricing/page.tsx')
    expect(collectAppRouterLayoutChain(appDir, 'pricing/page.tsx')).toEqual([])
  })

  it('honours a .jsx layout the same way as .tsx', () => {
    write('layout.jsx')
    write('pricing/page.tsx')
    expect(collectAppRouterLayoutChain(appDir, 'pricing/page.tsx')).toEqual(['layout.jsx'])
  })
})

/**
 * REGRESSION — `discoverPageFiles` (every non-`next-app` project's page
 * discovery) must not have grown any App-Router awareness. Feeding it the
 * exact filenames App Router uses proves `discoverPageFiles` still just globs
 * `.tsx`/`.jsx` — it has no notion of `page.tsx` being special, because
 * WS-1.3 branches at the CALLER (`loadStudioPages`/`pageCountFor`), never
 * inside this function.
 */
describe('discoverPageFiles — unaffected by App Router filenames (regression)', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-discover-not-next-app-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function write(relPath: string): void {
    const full = path.join(tmpDir, ...relPath.split('/'))
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, 'export default function X() { return null }', 'utf8')
  }

  it('returns every .tsx/.jsx file, including ones literally named page/layout/template, for a plain (non-Next) project', () => {
    write('page.tsx')
    write('layout.tsx')
    write('(marketing)/page.tsx')
    write('template.tsx')

    // A generic React repo could genuinely have files with these names —
    // discoverPageFiles has no framework awareness and must treat them the
    // same as any other .tsx file: everything comes back.
    expect(discoverPageFiles(tmpDir).sort()).toEqual(
      ['(marketing)/page.tsx', 'layout.tsx', 'page.tsx', 'template.tsx'].sort(),
    )
  })
})
