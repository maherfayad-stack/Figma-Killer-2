/**
 * studio.ts — unit tests for the pure pageId-derivation helper, the
 * recursive page-discovery walk (Phase 7A — multi-file workspace backend),
 * and the typed studio-edit dispatch helper.
 *
 * `pageIdFromRelPath`/`assignPageIds` turn a page file's path (relative to
 * the workspace's `pages/` dir) into the stable, unique `pageId`/`slug` the
 * multi-page `/admin/api/studio/load` scan uses.
 *
 * `applyStudioEdit` is the pure dir+edit→codemod dispatch the POST
 * /admin/api/studio/save handler runs per edit (Phase 3, Slice B) — tested
 * directly against temp fixture files rather than through a full
 * Request/Response cycle.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { zipSync, strToU8 } from 'fflate'
import {
  applyStudioEdit,
  assignPageIds,
  orderStudioEditsForApply,
  pageIdFromRelPath,
  tryServeStudio,
} from '../studio'
import { discoverPageFiles, listStudioProjects, pageComponentNameFromInput } from '../studioProjects'
import { collectWorkspaceFiles } from '../studioDownload'

describe('orderStudioEditsForApply', () => {
  it('sorts bottom-to-top: descending line, then descending column', () => {
    const edits = [
      { nodeId: 'Home.tsx:5:6' },
      { nodeId: 'Home.tsx:11:8' },
      { nodeId: 'Home.tsx:5:20' },
      { nodeId: 'Home.tsx:12:8' },
    ]
    expect(orderStudioEditsForApply(edits).map((e) => e.nodeId)).toEqual([
      'Home.tsx:12:8',
      'Home.tsx:11:8',
      'Home.tsx:5:20',
      'Home.tsx:5:6',
    ])
  })

  it('sorts synthetic-location nodes (no line:col) last', () => {
    const edits = [{ nodeId: 'index:body' }, { nodeId: 'Home.tsx:3:4' }]
    expect(orderStudioEditsForApply(edits).map((e) => e.nodeId)).toEqual([
      'Home.tsx:3:4',
      'index:body',
    ])
  })

  it('does not mutate the input array', () => {
    const edits = [{ nodeId: 'Home.tsx:1:1' }, { nodeId: 'Home.tsx:9:1' }]
    const before = [...edits]
    orderStudioEditsForApply(edits)
    expect(edits).toEqual(before)
  })
})

describe('pageIdFromRelPath', () => {
  it('lowercases a simple basename', () => {
    expect(pageIdFromRelPath('Home.tsx')).toBe('home')
  })

  it('lowercases another simple basename', () => {
    expect(pageIdFromRelPath('About.tsx')).toBe('about')
  })

  it('kebab-cases a multi-word PascalCase basename', () => {
    expect(pageIdFromRelPath('MyPage.tsx')).toBe('my-page')
  })

  it('collapses non-alphanumeric separators to a single dash', () => {
    expect(pageIdFromRelPath('Contact Us.tsx')).toBe('contact-us')
  })

  it('strips leading/trailing dashes produced by punctuation at the edges', () => {
    expect(pageIdFromRelPath('_Home_.tsx')).toBe('home')
  })

  it('falls back to "page" for a basename with no alphanumeric characters', () => {
    expect(pageIdFromRelPath('___.tsx')).toBe('page')
  })

  it('kebab-cases a nested PascalCase path, joining segments with a dash', () => {
    expect(pageIdFromRelPath('marketing/Landing.tsx')).toBe('marketing-landing')
  })

  it('kebab-cases every segment of a deeply-nested path', () => {
    expect(pageIdFromRelPath('MarketingSite/subPages/ContactUs.tsx')).toBe('marketing-site-sub-pages-contact-us')
  })

  it('is stable regardless of which OS-style separators produced the POSIX relPath', () => {
    // discoverPageFiles always hands relPath as POSIX ('/'), never '\\' — this
    // just pins that the function itself only ever splits on '/'.
    expect(pageIdFromRelPath('a/b/Home.tsx')).toBe('a-b-home')
  })
})

describe('assignPageIds', () => {
  it('assigns each distinct relPath its own pageIdFromRelPath result when there is no collision', () => {
    const ids = assignPageIds(['Home.tsx', 'About.tsx', 'marketing/Landing.tsx'])
    expect(ids.get('Home.tsx')).toBe('home')
    expect(ids.get('About.tsx')).toBe('about')
    expect(ids.get('marketing/Landing.tsx')).toBe('marketing-landing')
  })

  it('disambiguates a collision with a numeric suffix, in input order', () => {
    // Both slugify to "marketing-landing".
    const ids = assignPageIds(['Marketing/Landing.tsx', 'marketing-landing.tsx'])
    expect(ids.get('Marketing/Landing.tsx')).toBe('marketing-landing')
    expect(ids.get('marketing-landing.tsx')).toBe('marketing-landing-2')
  })

  it('is deterministic for a given input ordering — same input, same output', () => {
    const relPaths = ['a.tsx', 'A.tsx', 'a/a.tsx']
    const first = assignPageIds(relPaths)
    const second = assignPageIds(relPaths)
    expect([...first.entries()]).toEqual([...second.entries()])
  })

  it('never produces duplicate ids across the whole assigned set', () => {
    const ids = assignPageIds(['x.tsx', 'X.tsx', 'x/x.tsx', 'x-x.tsx'])
    const values = [...ids.values()]
    expect(new Set(values).size).toBe(values.length)
  })
})

/**
 * discoverPageFiles — recursive page discovery (Phase 7A). Tested against a
 * temp fixture tree, same pattern as `collectWorkspaceFiles`.
 */
describe('discoverPageFiles', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-discover-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function write(relPath: string, contents: string): void {
    const full = path.join(tmpDir, ...relPath.split('/'))
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, contents, 'utf8')
  }

  it('finds a flat top-level page file', () => {
    write('Home.tsx', 'x')
    expect(discoverPageFiles(tmpDir)).toEqual(['Home.tsx'])
  })

  it('finds a nested page file inside a route/page subdirectory', () => {
    write('Home.tsx', 'x')
    write('marketing/Landing.tsx', 'x')
    expect(discoverPageFiles(tmpDir)).toEqual(['Home.tsx', 'marketing/Landing.tsx'])
  })

  it('finds arbitrarily deep nesting', () => {
    write('a/b/c/Deep.tsx', 'x')
    expect(discoverPageFiles(tmpDir)).toEqual(['a/b/c/Deep.tsx'])
  })

  it('ignores non-.tsx files sitting alongside page files', () => {
    write('Home.tsx', 'x')
    write('Home.module.css', 'x')
    write('README.md', 'x')
    expect(discoverPageFiles(tmpDir)).toEqual(['Home.tsx'])
  })

  it('excludes node_modules/, .git/, dist/, .next/, .turbo/, .studio/', () => {
    write('Home.tsx', 'x')
    write('node_modules/some-dep/Fake.tsx', 'x')
    write('.git/HEAD', 'x')
    write('dist/Fake.tsx', 'x')
    write('.next/Fake.tsx', 'x')
    write('.turbo/Fake.tsx', 'x')
    write('.studio/Fake.tsx', 'x')
    expect(discoverPageFiles(tmpDir)).toEqual(['Home.tsx'])
  })

  it('returns an empty list when the pages dir has no .tsx files', () => {
    write('README.md', 'x')
    expect(discoverPageFiles(tmpDir)).toEqual([])
  })
})

describe('applyStudioEdit', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-handler-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function writeFixture(name: string, source: string): string {
    const filePath = path.join(tmpDir, name)
    fs.writeFileSync(filePath, source, 'utf8')
    return filePath
  }

  /** Locates the 1-based (line, col) of the char right after `<Tag` in `source`. */
  function locateTag(source: string, tag: string): { line: number; col: number } {
    const re = new RegExp(`<${tag}(?=[\\s/>])`)
    const match = re.exec(source)
    if (!match) throw new Error(`locateTag: "<${tag}" not found in fixture source`)
    const nameStart = match.index + 1 // char right after '<'
    const before = source.slice(0, nameStart)
    const lines = before.split('\n')
    return { line: lines.length, col: lines[lines.length - 1]!.length + 1 }
  }

  it('dispatches a kind: "prop" edit to setJsxProp', () => {
    const source = ['export default function App() {', '  return <Button label="Old" />', '}', ''].join('\n')
    const file = writeFixture('prop.tsx', source)
    const { line, col } = locateTag(source, 'Button')

    const result = applyStudioEdit(tmpDir, { kind: 'prop', nodeId: `prop.tsx:${line}:${col}`, prop: 'label', value: 'New' })

    expect(result).toBe(true)
    expect(fs.readFileSync(file, 'utf8')).toContain('label="New"')
  })

  it('dispatches a kind: "text" edit to setJsxText', () => {
    const source = ['export default function App() {', '  return <p>Hello</p>', '}', ''].join('\n')
    const file = writeFixture('text.tsx', source)
    const { line, col } = locateTag(source, 'p')

    const result = applyStudioEdit(tmpDir, { kind: 'text', nodeId: `text.tsx:${line}:${col}`, text: 'Bye' })

    expect(result).toBe(true)
    expect(fs.readFileSync(file, 'utf8')).toContain('<p>{"Bye"}</p>')
  })

  it('dispatches a kind: "style" edit to setJsxStyle, merging into an existing style object', () => {
    const source = [
      'export default function App() {',
      '  return <div style={{ color: "red" }} />',
      '}',
      '',
    ].join('\n')
    const file = writeFixture('style.tsx', source)
    const { line, col } = locateTag(source, 'div')

    const result = applyStudioEdit(tmpDir, {
      kind: 'style',
      nodeId: `style.tsx:${line}:${col}`,
      style: { color: 'blue', boxShadow: '0 0 1px' },
    })

    expect(result).toBe(true)
    const written = fs.readFileSync(file, 'utf8')
    expect(written).toContain('color: "blue"')
    expect(written).toContain('boxShadow: "0 0 1px"')
  })

  it('returns false (no throw) for a synthetic node id with no source location', () => {
    const result = applyStudioEdit(tmpDir, { kind: 'prop', nodeId: 'home:body', prop: 'x', value: 'y' })
    expect(result).toBe(false)
  })

  it('propagates JsxTextTargetError for a mixed-content text target, leaving the file untouched', () => {
    const source = ['export default function App() {', '  return <div><span/>x</div>', '}', ''].join('\n')
    const file = writeFixture('mixed.tsx', source)
    const { line, col } = locateTag(source, 'div')

    expect(() =>
      applyStudioEdit(tmpDir, { kind: 'text', nodeId: `mixed.tsx:${line}:${col}`, text: 'Bye' }),
    ).toThrow()
    expect(fs.readFileSync(file, 'utf8')).toBe(source)
  })
})

/**
 * collectWorkspaceFiles — pure(ish) dir-in/file-list-out walk that backs
 * GET /admin/api/studio/download (Phase 6D — "Download the code"). Tested
 * directly against a temp fixture tree, same pattern as `applyStudioEdit`.
 */
describe('collectWorkspaceFiles', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-download-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function write(relPath: string, contents: string): void {
    const full = path.join(tmpDir, ...relPath.split('/'))
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, contents, 'utf8')
  }

  function relPaths(files: { relPath: string }[]): string[] {
    return files.map((f) => f.relPath).sort()
  }

  it('includes real source files, preserving relative paths and contents', () => {
    write('pages/Home.tsx', 'export default function Home() { return null }')
    write('components/Button.tsx', 'export function Button() { return null }')
    write('components/Button.module.css', '.btn { color: red; }')

    const files = collectWorkspaceFiles(tmpDir)

    expect(relPaths(files)).toEqual([
      'components/Button.module.css',
      'components/Button.tsx',
      'pages/Home.tsx',
    ])
    const home = files.find((f) => f.relPath === 'pages/Home.tsx')
    expect(home?.contents.toString('utf8')).toBe('export default function Home() { return null }')
  })

  it('excludes .studio/ (editor-owned spatial metadata, not app code)', () => {
    write('pages/Home.tsx', 'x')
    write('.studio/boards.json', '{}')

    const files = collectWorkspaceFiles(tmpDir)

    expect(relPaths(files)).toEqual(['pages/Home.tsx'])
  })

  it('excludes node_modules/, .git/, dist/, .next/, .turbo/', () => {
    write('pages/Home.tsx', 'x')
    write('node_modules/some-dep/index.js', 'x')
    write('.git/HEAD', 'x')
    write('dist/bundle.js', 'x')
    write('.next/build-manifest.json', 'x')
    write('.turbo/cache/entry', 'x')

    const files = collectWorkspaceFiles(tmpDir)

    expect(relPaths(files)).toEqual(['pages/Home.tsx'])
  })

  it('skips a file over the maxFileBytes cap whole, rather than truncating it', () => {
    write('pages/Home.tsx', 'x')
    write('assets/huge.bin', 'y'.repeat(2048))

    const files = collectWorkspaceFiles(tmpDir, { maxFileBytes: 1024 })

    expect(relPaths(files)).toEqual(['pages/Home.tsx'])
  })

  it('stops collecting once maxFiles is reached, without throwing', () => {
    write('pages/A.tsx', 'a')
    write('pages/B.tsx', 'b')
    write('pages/C.tsx', 'c')

    const files = collectWorkspaceFiles(tmpDir, { maxFiles: 2 })

    expect(files.length).toBe(2)
  })

  it('returns an empty list for an empty directory (no crash)', () => {
    expect(collectWorkspaceFiles(tmpDir)).toEqual([])
  })
})

/**
 * listStudioProjects — pure(ish) dir-in/project-list-out helper backing
 * GET /admin/api/studio/projects (the dashboard Projects widget). Tested
 * against a temp fixture tree, same pattern as `collectWorkspaceFiles`.
 */
describe('listStudioProjects', () => {
  let tmpDir: string
  let projectsRoot: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-projects-'))
    projectsRoot = path.join(tmpDir, 'studio-workspace')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function write(relPath: string, contents: string): void {
    const full = path.join(tmpDir, ...relPath.split('/'))
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, contents, 'utf8')
  }

  it('returns an empty list when the root does not exist', () => {
    expect(listStudioProjects(projectsRoot)).toEqual([])
  })

  it('lists one entry per immediate subfolder, with its page count, sorted by name', () => {
    write('studio-workspace/my-workspace/pages/Home.tsx', 'x')
    write('studio-workspace/my-workspace/pages/About.tsx', 'x')
    write('studio-workspace/acme-widgets/pages/Home.tsx', 'x')

    const projects = listStudioProjects(projectsRoot)

    expect(projects).toEqual([
      { dir: path.join(projectsRoot, 'acme-widgets'), name: 'acme-widgets', pageCount: 1 },
      { dir: path.join(projectsRoot, 'my-workspace'), name: 'my-workspace', pageCount: 2 },
    ])
  })

  it('reports pageCount 0 for a project folder with no pages/ dir', () => {
    fs.mkdirSync(path.join(projectsRoot, 'empty'), { recursive: true })

    const projects = listStudioProjects(projectsRoot)

    expect(projects).toEqual([
      { dir: path.join(projectsRoot, 'empty'), name: 'empty', pageCount: 0 },
    ])
  })

  it('skips a stray file sitting directly in the root', () => {
    write('studio-workspace/acme-widgets/pages/Home.tsx', 'x')
    write('studio-workspace/README.md', 'not a project')

    const projects = listStudioProjects(projectsRoot)

    expect(projects.map((p) => p.name)).toEqual(['acme-widgets'])
  })

  it('never treats an excluded directory name as a project (e.g. .git)', () => {
    write('studio-workspace/.git/HEAD', 'x')
    write('studio-workspace/acme-widgets/pages/Home.tsx', 'x')

    const projects = listStudioProjects(projectsRoot)

    expect(projects.map((p) => p.name)).toEqual(['acme-widgets'])
  })
})

/**
 * GET /admin/api/studio/projects — route wiring over `listStudioProjects`.
 */
describe('GET /admin/api/studio/projects', () => {
  it('returns { projects: [] } when running against a cwd with no studio directories', async () => {
    // The route derives its root from process.cwd()/studio-workspace — this
    // repo's actual cwd during `bun test` may or may not have project folders
    // there (that's user dogfooding data), so this just exercises the route
    // returning valid JSON without asserting exact repo state.
    const url = new URL('http://localhost/admin/api/studio/projects')
    const req = new Request(url)
    const res = await tryServeStudio(req, undefined, url, url.pathname)

    expect(res).not.toBeNull()
    expect(res!.status).toBe(200)
    const body = (await res!.json()) as { projects: Array<{ dir: string; name: string; pageCount: number }> }
    expect(Array.isArray(body.projects)).toBe(true)
  })
})

/**
 * pageComponentNameFromInput — user page name → PascalCase component/file name.
 */
describe('pageComponentNameFromInput', () => {
  it('PascalCases multi-word names', () => {
    expect(pageComponentNameFromInput('contact us')).toBe('ContactUs')
    expect(pageComponentNameFromInput('  pricing-page ')).toBe('PricingPage')
  })

  it('preserves internal capitals of a single token', () => {
    expect(pageComponentNameFromInput('MyPage')).toBe('MyPage')
  })

  it('prefixes a leading digit so the result is a valid identifier', () => {
    expect(pageComponentNameFromInput('404 not found')).toBe('Page404NotFound')
  })

  it('returns empty string when nothing usable remains', () => {
    expect(pageComponentNameFromInput('  !!! ')).toBe('')
    expect(pageComponentNameFromInput('')).toBe('')
  })
})

/**
 * POST /admin/api/studio/page — scaffolds a new page file in a project.
 * Driven against a temp `dir` so the repo's real studio-workspace is untouched.
 */
describe('POST /admin/api/studio/page', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-newpage-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  async function post(body: unknown): Promise<Response> {
    const url = new URL('http://localhost/admin/api/studio/page')
    const req = new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const res = await tryServeStudio(req, undefined, url, url.pathname)
    expect(res).not.toBeNull()
    return res!
  }

  it('writes pages/<Component>.tsx and returns the derived pageId for a supplied name', async () => {
    const res = await post({ dir: tmpDir, name: 'contact us' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; relPath: string; pageId: string; title: string }
    expect(body).toEqual({ ok: true, relPath: 'ContactUs.tsx', pageId: 'contact-us', title: 'ContactUs' })

    const file = path.join(tmpDir, 'pages', 'ContactUs.tsx')
    expect(fs.existsSync(file)).toBe(true)
    const source = fs.readFileSync(file, 'utf8')
    expect(source).toContain('export default function ContactUs()')
  })

  it('auto-names Page, Page2, Page3, … when no name is supplied', async () => {
    const first = (await (await post({ dir: tmpDir })).json()) as { title: string; pageId: string }
    expect(first).toMatchObject({ title: 'Page', pageId: 'page' })
    const second = (await (await post({ dir: tmpDir })).json()) as { title: string; pageId: string }
    expect(second).toMatchObject({ title: 'Page2', pageId: 'page2' })
    const third = (await (await post({ dir: tmpDir })).json()) as { title: string }
    expect(third.title).toBe('Page3')

    expect(fs.existsSync(path.join(tmpDir, 'pages', 'Page.tsx'))).toBe(true)
    expect(fs.existsSync(path.join(tmpDir, 'pages', 'Page2.tsx'))).toBe(true)
    expect(fs.existsSync(path.join(tmpDir, 'pages', 'Page3.tsx'))).toBe(true)
  })

  it('auto-names when the supplied name is empty/punctuation-only', async () => {
    const res = await post({ dir: tmpDir, name: '   ' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { title: string }
    expect(body.title).toBe('Page')
  })

  it('refuses to overwrite an existing page with 409', async () => {
    await post({ dir: tmpDir, name: 'Home' })
    const res = await post({ dir: tmpDir, name: 'home' })
    expect(res.status).toBe(409)
  })
})

/**
 * GET /admin/api/studio/load — end-to-end over a real temp workspace tree
 * (Phase 7A): recursive nested-page discovery, collision-free page ids,
 * local-vs-package component classification, and the node-id round trip
 * (`relFile:line:col` for a NESTED file resolves back to that exact file).
 */
describe('GET /admin/api/studio/load — Phase 7A multi-file workspace', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-load-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function write(relPath: string, contents: string): void {
    const full = path.join(tmpDir, ...relPath.split('/'))
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, contents, 'utf8')
  }

  it('discovers a nested page, classifies its local/package components, and node ids round-trip to the nested file', async () => {
    write(
      'pages/Home.tsx',
      ['export default function Home() {', '  return <div>Home</div>', '}', ''].join('\n'),
    )
    write('components/Header.tsx', 'export default function Header() { return null }')
    write(
      'pages/marketing/Landing.tsx',
      [
        "import Header from '../../components/Header'",
        "import { Button } from '@alm-design/design-system'",
        'export default function Landing() {',
        '  return (',
        '    <div>',
        '      <Header />',
        '      <Button label="Go" />',
        '    </div>',
        '  )',
        '}',
        '',
      ].join('\n'),
    )

    const url = new URL(`http://localhost/admin/api/studio/load?dir=${encodeURIComponent(tmpDir)}`)
    const req = new Request(url)
    const res = await tryServeStudio(req, undefined, url, url.pathname)
    expect(res).not.toBeNull()

    const body = (await res!.json()) as {
      dir: string
      pages: Array<{ id: string; nodes: Record<string, { id: string; moduleId: string }> }>
      componentSources: Record<string, { kind: string; file?: string; specifier?: string }>
    }

    // Collision-free, path-aware page ids — "Home.tsx" -> "home",
    // "marketing/Landing.tsx" -> "marketing-landing".
    expect(body.pages.map((p) => p.id).sort()).toEqual(['home', 'marketing-landing'])

    const landing = body.pages.find((p) => p.id === 'marketing-landing')!
    const nodeByModule = (moduleId: string) =>
      Object.values(landing.nodes).find((n) => n.moduleId === moduleId)!.id

    // Local component: import resolves inside the workspace.
    const headerNodeId = nodeByModule('alm.Header')
    expect(body.componentSources[headerNodeId]).toEqual({ kind: 'local', file: 'components/Header.tsx' })

    // Package component: bare specifier, stays a read-only prop surface.
    const buttonNodeId = nodeByModule('alm.Button')
    expect(body.componentSources[buttonNodeId]).toEqual({
      kind: 'package',
      specifier: '@alm-design/design-system',
    })

    // Node identity stays file-scoped: the div's id is namespaced by the
    // NESTED file's workspace-relative path, not a flattened basename.
    const divNodeId = nodeByModule('base.container')
    expect(divNodeId.startsWith('pages/marketing/Landing.tsx:')).toBe(true)

    // Round trip: applying an edit against that node id must write to the
    // exact nested file `relFile:line:col` encodes.
    const wrote = applyStudioEdit(tmpDir, { kind: 'prop', nodeId: divNodeId, prop: 'data-test', value: 'ok' })
    expect(wrote).toBe(true)
    const written = fs.readFileSync(path.join(tmpDir, 'pages', 'marketing', 'Landing.tsx'), 'utf8')
    expect(written).toContain('data-test="ok"')
  })

  it('returns an empty page list and empty componentSources when the workspace has no pages/ dir', async () => {
    const url = new URL(`http://localhost/admin/api/studio/load?dir=${encodeURIComponent(tmpDir)}`)
    const req = new Request(url)
    const res = await tryServeStudio(req, undefined, url, url.pathname)
    const body = (await res!.json()) as { dir: string; pages: unknown[]; componentSources: Record<string, unknown> }

    expect(body.pages).toEqual([])
    expect(body.componentSources).toEqual({})
  })
})

describe('POST /admin/api/studio/import-github — Phase 7B route wiring', () => {
  let tmpDir: string
  let originalFetch: typeof fetch

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-import-route-'))
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    globalThis.fetch = originalFetch
  })

  it('returns 400 with an { error } envelope for a non-GitHub URL, without touching the network', async () => {
    let fetchCalled = false
    globalThis.fetch = (async () => {
      fetchCalled = true
      throw new Error('should not be called')
    }) as typeof fetch

    const url = new URL('http://localhost/admin/api/studio/import-github')
    const req = new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/not/github' }),
    })
    const res = await tryServeStudio(req, undefined, url, url.pathname)

    expect(res!.status).toBe(400)
    const body = (await res!.json()) as { error: string }
    expect(body.error).toContain('GitHub')
    expect(fetchCalled).toBe(false)
  })

  it('imports a fake zipball end to end, deriving the target server-side and IGNORING a caller-supplied dir', async () => {
    // Security regression: the import clears its target before repopulating,
    // so honouring a request-body `dir` would be an arbitrary recursive-delete
    // primitive. The target must always be derived from the parsed repo.
    const zip = zipSync({
      'acme-widgets-abc1/pages/Home.tsx': strToU8('export default function Home() { return null }'),
    })
    globalThis.fetch = (async () =>
      new Response(zip, { status: 200, headers: { 'content-length': String(zip.byteLength) } })) as typeof fetch

    const url = new URL('http://localhost/admin/api/studio/import-github')
    const req = new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://github.com/acme/widgets', dir: tmpDir }),
    })
    const res = await tryServeStudio(req, undefined, url, url.pathname)

    expect(res!.status).toBe(200)
    const body = (await res!.json()) as { ok: boolean; dir: string; files: number; skipped: number }
    try {
      expect(body.ok).toBe(true)
      expect(body.files).toBe(1)
      expect(body.skipped).toBe(0)
      // Server-derived target, NOT the caller's tmpDir.
      expect(body.dir).not.toBe(tmpDir)
      expect(body.dir.split(path.sep).join('/')).toContain('studio-workspace/acme-widgets')
      expect(fs.existsSync(path.join(body.dir, 'pages', 'Home.tsx'))).toBe(true)
      // The caller-supplied directory was never touched.
      expect(fs.existsSync(path.join(tmpDir, 'pages'))).toBe(false)
    } finally {
      fs.rmSync(body.dir, { recursive: true, force: true })
    }
  })
})
