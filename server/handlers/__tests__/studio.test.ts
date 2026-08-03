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
import { INLINE_ID_SEPARATOR, checkCanonicalJsx, parsePageFile } from '@core/page-parser'
import { tryServeStudio } from '../studio'
import { applyStudioEdit, dedupeStudioEdits, orderStudioEditsForApply } from '../studioWriteback'
import { assignPageIds, pageIdFromRelPath } from '../studioPageLoad'
import { discoverPageFiles, listStudioProjects, pageComponentNameFromInput } from '../studioProjects'
import { collectWorkspaceFiles } from '../studioDownload'
import { probeProject } from '../studio/projectProbe'
import { mergeStudioMeta } from '../studio/studioMeta'

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

  // §2.4 — a composite (inlined) node id encodes TWO source locations
  // (`callSiteId${INLINE_ID_SEPARATOR}componentNodeId`). It sorts by the TAIL
  // one, because that is the location it writes to. Here the tail is line 3,
  // so it sorts after the plain edit at line 11.
  it('sorts a composite (inlined) node id by its TAIL location', () => {
    const edits = [
      { nodeId: `Home.tsx:5:6${INLINE_ID_SEPARATOR}components/Icon.tsx:3:5` },
      { nodeId: 'Home.tsx:11:8' },
    ]
    expect(orderStudioEditsForApply(edits).map((e) => e.nodeId)).toEqual([
      'Home.tsx:11:8',
      `Home.tsx:5:6${INLINE_ID_SEPARATOR}components/Icon.tsx:3:5`,
    ])
  })

  it('ranks a composite id ahead of a plain edit when its tail line is higher', () => {
    const edits = [
      { nodeId: 'Home.tsx:4:1' },
      { nodeId: `Home.tsx:5:6${INLINE_ID_SEPARATOR}components/Icon.tsx:30:5` },
    ]
    expect(orderStudioEditsForApply(edits).map((e) => e.nodeId)).toEqual([
      `Home.tsx:5:6${INLINE_ID_SEPARATOR}components/Icon.tsx:30:5`,
      'Home.tsx:4:1',
    ])
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
    const filePath = path.join(tmpDir, ...name.split('/'))
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
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

    expect(result.applied).toBe(true)
    expect(fs.readFileSync(file, 'utf8')).toContain('label="New"')
  })

  it('dispatches a kind: "text" edit to setJsxText', () => {
    const source = ['export default function App() {', '  return <p>Hello</p>', '}', ''].join('\n')
    const file = writeFixture('text.tsx', source)
    const { line, col } = locateTag(source, 'p')

    const result = applyStudioEdit(tmpDir, { kind: 'text', nodeId: `text.tsx:${line}:${col}`, text: 'Bye' })

    expect(result.applied).toBe(true)
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

    expect(result.applied).toBe(true)
    const written = fs.readFileSync(file, 'utf8')
    expect(written).toContain('color: "blue"')
    expect(written).toContain('boxShadow: "0 0 1px"')
  })

  it('returns false (no throw) for a synthetic node id with no source location', () => {
    const result = applyStudioEdit(tmpDir, { kind: 'prop', nodeId: 'home:body', prop: 'x', value: 'y' })
    expect(result.applied).toBe(false)
  })

  // §2.4 — the risk register's specifically-named test: a composite (inlined)
  // node id must be a NO-OP, and critically must never write to ANY file —
  // NODE_LOC_ID's greedy `.*` would otherwise happily match past the
  // separator, deriving `join(dir, 'prop.tsx:5:6~components/Icon.tsx')` as a
  // "file" to write `setJsxProp` against, silently corrupting whatever that
  // garbage path happens to resolve to (or creating it).
  it('writes a composite (inlined) node id to the COMPONENT file, never to a path built from the prefix', () => {
    // An inlined node's markup lives in the component's own file, so that is
    // where an edit belongs — the tail of the composite id. What must never
    // happen is `NODE_LOC_ID`'s greedy `.*` matching straight through the
    // separator and yielding `join(dir, 'page.tsx:2:11~components/Icon.tsx')`
    // as a "file", silently corrupting whatever that resolves to (or creating
    // it). `studioEditLocation` splits on the separator before matching.
    const pageSource = ['export default function App() {', '  return <Icon label="Old" />', '}', ''].join('\n')
    const pageFile = writeFixture('page.tsx', pageSource)
    const componentSource = ['export default function Icon({ label }) {', '  return <span title="Old" />', '}', ''].join('\n')
    const componentFile = writeFixture('components/Icon.tsx', componentSource)

    const callSite = locateTag(pageSource, 'Icon')
    const inner = locateTag(componentSource, 'span')
    const compositeNodeId =
      `page.tsx:${callSite.line}:${callSite.col}${INLINE_ID_SEPARATOR}components/Icon.tsx:${inner.line}:${inner.col}`

    const result = applyStudioEdit(tmpDir, { kind: 'prop', nodeId: compositeNodeId, prop: 'title', value: 'New' })

    expect(result.applied).toBe(true)
    expect(fs.readFileSync(componentFile, 'utf8')).toContain('title="New"')
    // The call-site file — the composite id's PREFIX — is untouched.
    expect(fs.readFileSync(pageFile, 'utf8')).toBe(pageSource)
    // And no path was ever derived from the prefix itself.
    expect(fs.existsSync(path.join(tmpDir, `page.tsx:${callSite.line}:${callSite.col}~components`))).toBe(false)
  })

  it('collapses two edits that resolve to the same component source location', () => {
    // Every instance of an inlined component maps back to the same lines in
    // that component's file, so a batch can legitimately contain two edits with
    // one target. Applying both would make the second read a file the first
    // already rewrote.
    const nodeA = `a.tsx:2:11${INLINE_ID_SEPARATOR}components/Icon.tsx:2:11`
    const nodeB = `b.tsx:9:4${INLINE_ID_SEPARATOR}components/Icon.tsx:2:11`
    const deduped = dedupeStudioEdits([
      { kind: 'prop', nodeId: nodeA, prop: 'title', value: 'First' },
      { kind: 'prop', nodeId: nodeB, prop: 'title', value: 'Second' },
    ])

    expect(deduped).toHaveLength(1)
    expect(deduped[0]).toMatchObject({ value: 'Second' }) // last edit wins
  })

  it('keeps edits to DIFFERENT props on the same location', () => {
    const nodeId = `a.tsx:2:11${INLINE_ID_SEPARATOR}components/Icon.tsx:2:11`
    const deduped = dedupeStudioEdits([
      { kind: 'prop', nodeId, prop: 'title', value: 'T' },
      { kind: 'prop', nodeId, prop: 'alt', value: 'A' },
    ])

    expect(deduped).toHaveLength(2)
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
    const body = (await res.json()) as { ok: boolean; relPath: string; pageId: string; title: string; rootNodeId?: string }
    expect(body).toMatchObject({ ok: true, relPath: 'ContactUs.tsx', pageId: 'contact-us', title: 'ContactUs' })
    // Trap #2 — the id must be a real source location the server derived by
    // parsing the file it just wrote, never a constructed string.
    expect(body.rootNodeId).toMatch(/^pages\/ContactUs\.tsx:\d+:\d+$/)

    const file = path.join(tmpDir, 'pages', 'ContactUs.tsx')
    expect(fs.existsSync(file)).toBe(true)
    const source = fs.readFileSync(file, 'utf8')
    expect(source).toContain('export default function ContactUs()')
  })

  it('the scaffolded page passes checkCanonicalJsx with zero violations', async () => {
    const res = await post({ dir: tmpDir, name: 'Contact Us' })
    const body = (await res.json()) as { relPath: string }
    const file = path.join(tmpDir, 'pages', body.relPath)
    const parsed = parsePageFile(file, tmpDir)
    const findings = checkCanonicalJsx({ page: parsed })
    const violations = findings.filter((f) => f.tier === 'violation')
    expect(violations).toEqual([])
  })

  it('auto-places the new page as a board frame in .studio/boards.json', async () => {
    const res = await post({ dir: tmpDir, name: 'Home' })
    const body = (await res.json()) as { pageId: string }

    const boardsFile = path.join(tmpDir, '.studio', 'boards.json')
    expect(fs.existsSync(boardsFile)).toBe(true)
    const boards = JSON.parse(fs.readFileSync(boardsFile, 'utf8')) as {
      boards: { frames: { id: string; pageId: string; x: number; y: number }[] }[]
    }
    expect(boards.boards).toHaveLength(1)
    const frame = boards.boards[0]!.frames.find((f) => f.pageId === body.pageId)
    // WS-10 Phase 2 — every frame carries its own `id` now; assert its
    // presence without pinning the random value.
    expect(typeof frame?.id).toBe('string')
    expect(frame).toMatchObject({ pageId: body.pageId, x: 0, y: 0 })
  })

  it('a second page lands at the next free grid slot, not on top of the first', async () => {
    await post({ dir: tmpDir, name: 'First' })
    const second = (await (await post({ dir: tmpDir, name: 'Second' })).json()) as { pageId: string }

    const boardsFile = path.join(tmpDir, '.studio', 'boards.json')
    const boards = JSON.parse(fs.readFileSync(boardsFile, 'utf8')) as {
      boards: { frames: { pageId: string; x: number; y: number }[] }[]
    }
    const frame = boards.boards[0]!.frames.find((f) => f.pageId === second.pageId)
    expect(frame).toMatchObject({ x: 1024 + 80, y: 0 }) // FRAME_WIDTH + FRAME_GAP, column 2
  })

  it('matches the project convention: an all-.jsx project gets a new .jsx page', async () => {
    const pagesDir = path.join(tmpDir, 'pages')
    fs.mkdirSync(pagesDir, { recursive: true })
    fs.writeFileSync(path.join(pagesDir, 'Existing.jsx'), 'export default function Existing() { return <div /> }\n')

    const res = await post({ dir: tmpDir, name: 'Second Page' })
    const body = (await res.json()) as { relPath: string }
    expect(body.relPath).toBe('SecondPage.jsx')
    expect(fs.existsSync(path.join(pagesDir, 'SecondPage.jsx'))).toBe(true)
  })

  it('defaults to .tsx when the project has no pages yet, or a mix', async () => {
    const noPages = (await (await post({ dir: tmpDir, name: 'Fresh' })).json()) as { relPath: string }
    expect(noPages.relPath).toBe('Fresh.tsx')

    const pagesDir = path.join(tmpDir, 'pages')
    fs.writeFileSync(path.join(pagesDir, 'AlreadyTs.tsx'), 'export default function AlreadyTs() { return <div /> }\n')
    const mixed = (await (await post({ dir: tmpDir, name: 'Mixed' })).json()) as { relPath: string }
    expect(mixed.relPath).toBe('Mixed.tsx')
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
    write('components/Header.tsx', 'export default function Header() { return <span>Header</span> }')
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
    // `resolveComponentSources` classifies against the PRE-inline tree (§2.6),
    // so it still reports the call site under the call site's own id — and
    // (WS-4.2) that node is now KEPT, as the "instance" fragment
    // (`moduleId: 'studio.instance'`, zero DOM at render time): `<Header/>`
    // renders Header's own JSX as the instance's CHILDREN rather than
    // replacing the call site (§2.5's old design). Header's own <span> is
    // still reachable, under a composite id, as that instance's child.
    const headerNodeId = Object.keys(body.componentSources).find(
      (id) => body.componentSources[id]?.file === 'components/Header.tsx',
    )!
    expect(body.componentSources[headerNodeId]).toEqual({ kind: 'local', file: 'components/Header.tsx' })
    expect(Object.values(landing.nodes).some((n) => n.moduleId === 'alm.Header')).toBe(false)
    const headerInstance = landing.nodes[headerNodeId]
    expect(headerInstance).toBeDefined()
    expect(headerInstance!.moduleId).toBe('studio.instance')
    const headerSpan = Object.values(landing.nodes).find((n) => n.moduleId === 'base.text' && n.id.includes('~'))
    expect(headerSpan).toBeDefined() // Header's own <span> — inlined, composite id
    expect(headerSpan!.id.startsWith(`${headerNodeId}~`)).toBe(true)

    // Package component: bare specifier, stays a read-only prop surface.
    const buttonNodeId = nodeByModule('alm.Button')
    expect(body.componentSources[buttonNodeId]).toEqual({
      kind: 'package',
      specifier: '@alm-design/design-system',
    })

    // Node identity stays file-scoped: the OUTER div's id is namespaced by
    // the NESTED file's workspace-relative path, not a flattened basename —
    // distinguished from the (also `base.container`) Header call site by not
    // being a component call site itself.
    const divNodeId = Object.values(landing.nodes).find(
      (n) => n.moduleId === 'base.container' && !(n.id in body.componentSources),
    )!.id
    expect(divNodeId.startsWith('pages/marketing/Landing.tsx:')).toBe(true)

    // Round trip: applying an edit against that node id must write to the
    // exact nested file `relFile:line:col` encodes.
    const wrote = applyStudioEdit(tmpDir, { kind: 'prop', nodeId: divNodeId, prop: 'data-test', value: 'ok' })
    expect(wrote.applied).toBe(true)
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

  // WS-5.5 — the page-level parse cache (`pageParseCache.ts`) must never
  // serve stale content: reloading twice with no changes must be stable, and
  // reloading after an edit must reflect it. A caching bug here would look
  // exactly like "the editor shows an old version of the page" — silent, and
  // among the worst kinds of regression a perf change can introduce.
  it('reflects a page edit on the very next load, and does not resurrect stale content once cached', async () => {
    write('pages/Home.tsx', 'export default function Home() { return <p>First</p> }')

    const load = async () => {
      const url = new URL(`http://localhost/admin/api/studio/load?dir=${encodeURIComponent(tmpDir)}`)
      const res = await tryServeStudio(new Request(url), undefined, url, url.pathname)
      // Probe the raw response text rather than a specific node field — this
      // test cares only about "did the served content change", not which
      // exact `PageNode` field carries a `<div>`'s literal text.
      return await res!.text()
    }

    // Cold load, then an immediate repeat with nothing changed — must stay
    // identical (a cache hit reusing the same parse, not a corrupted reuse).
    expect(await load()).toContain('First')
    expect(await load()).toContain('First')

    // Bump the mtime explicitly — successive writes within the same
    // filesystem-clock tick could otherwise land on an unchanged stat().
    const homeFile = path.join(tmpDir, 'pages', 'Home.tsx')
    fs.writeFileSync(homeFile, 'export default function Home() { return <p>Second</p> }', 'utf8')
    const bumped = new Date(fs.statSync(homeFile).mtime.getTime() + 5000)
    fs.utimesSync(homeFile, bumped, bumped)

    const afterEdit = await load()
    expect(afterEdit).toContain('Second')
    expect(afterEdit).not.toContain('First')
  })

  // WS-5.5 — `?stream=1` is a different WIRE FORMAT for the identical
  // computed result, not a different computation: this proves the NDJSON
  // path reports the same dir/pages/componentSources as the buffered-JSON
  // default, just split across lines.
  it('?stream=1 serves the identical content as one NDJSON line per page, preceded by a meta line', async () => {
    write('pages/Home.tsx', 'export default function Home() { return <p>Hello</p> }')
    write('pages/About.tsx', 'export default function About() { return <p>About us</p> }')

    const plainUrl = new URL(`http://localhost/admin/api/studio/load?dir=${encodeURIComponent(tmpDir)}`)
    const plainRes = await tryServeStudio(new Request(plainUrl), undefined, plainUrl, plainUrl.pathname)
    const plainBody = (await plainRes!.json()) as { dir: string; pages: Array<{ id: string }> }

    const streamUrl = new URL(
      `http://localhost/admin/api/studio/load?dir=${encodeURIComponent(tmpDir)}&stream=1`,
    )
    const streamRes = await tryServeStudio(new Request(streamUrl), undefined, streamUrl, streamUrl.pathname)
    expect(streamRes!.headers.get('content-type')).toBe('application/x-ndjson')
    const lines = (await streamRes!.text())
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { kind: string; [k: string]: unknown })

    const metaLine = lines.find((l) => l.kind === 'meta') as
      | { kind: 'meta'; dir: string; pageCount: number }
      | undefined
    expect(metaLine).toBeDefined()
    expect(metaLine!.dir).toBe(plainBody.dir)
    expect(metaLine!.pageCount).toBe(plainBody.pages.length)

    const pageLines = lines.filter((l) => l.kind === 'page') as Array<{ kind: 'page'; page: { id: string } }>
    expect(pageLines.map((l) => l.page.id).sort()).toEqual(plainBody.pages.map((p) => p.id).sort())
  })
})

/**
 * GET /admin/api/studio/load?pageIds= — the targeted live-reload filter
 * (server-engineer, this change). Reuses the same fixture shape as the
 * describe block above; kept separate so the byte-identity assertions can
 * diff a filtered call against a genuinely unfiltered one from the same run.
 */
describe('GET /admin/api/studio/load — ?pageIds= filter', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-load-filter-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function write(relPath: string, contents: string): void {
    const full = path.join(tmpDir, ...relPath.split('/'))
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, contents, 'utf8')
  }

  function loadUrl(query: string): URL {
    return new URL(`http://localhost/admin/api/studio/load?dir=${encodeURIComponent(tmpDir)}${query}`)
  }

  it('omitting pageIds is byte-identical to the response before this filter existed — no missingPageIds key present', async () => {
    write('pages/Home.tsx', 'export default function Home() { return <p>Hello</p> }')
    write('pages/About.tsx', 'export default function About() { return <p>About us</p> }')

    const url = loadUrl('')
    const res = await tryServeStudio(new Request(url), undefined, url, url.pathname)
    const raw = await res!.text()
    // JSON.stringify drops an undefined-valued key entirely — assert the key
    // is genuinely ABSENT from the wire bytes, not merely `undefined` once
    // parsed (which every object would satisfy trivially).
    expect(raw.includes('missingPageIds')).toBe(false)

    const body = JSON.parse(raw) as { pages: Array<{ id: string }> }
    expect(body.pages.map((p) => p.id).sort()).toEqual(['about', 'home'])
  })

  it('returns only the requested page in the buffered JSON response', async () => {
    write('pages/Home.tsx', 'export default function Home() { return <p>Hello</p> }')
    write('pages/About.tsx', 'export default function About() { return <p>About us</p> }')

    const url = loadUrl('&pageIds=about')
    const res = await tryServeStudio(new Request(url), undefined, url, url.pathname)
    const body = (await res!.json()) as { pages: Array<{ id: string }>; missingPageIds: string[] }

    expect(body.pages.map((p) => p.id)).toEqual(['about'])
    expect(body.missingPageIds).toEqual([])
  })

  it('accepts multiple comma-separated ids', async () => {
    write('pages/Home.tsx', 'export default function Home() { return <p>Hello</p> }')
    write('pages/About.tsx', 'export default function About() { return <p>About us</p> }')
    write('pages/Contact.tsx', 'export default function Contact() { return <p>Contact us</p> }')

    const url = loadUrl('&pageIds=home,contact')
    const res = await tryServeStudio(new Request(url), undefined, url, url.pathname)
    const body = (await res!.json()) as { pages: Array<{ id: string }> }

    expect(body.pages.map((p) => p.id).sort()).toEqual(['contact', 'home'])
  })

  it('a stale/deleted id is reported via missingPageIds instead of failing the request', async () => {
    write('pages/Home.tsx', 'export default function Home() { return <p>Hello</p> }')

    const url = loadUrl('&pageIds=home,deleted-page')
    const res = await tryServeStudio(new Request(url), undefined, url, url.pathname)
    expect(res!.status).toBe(200)
    const body = (await res!.json()) as { pages: Array<{ id: string }>; missingPageIds: string[] }

    expect(body.pages.map((p) => p.id)).toEqual(['home'])
    expect(body.missingPageIds).toEqual(['deleted-page'])
  })

  it('every requested id stale still returns 200 with an empty pages array, not an error', async () => {
    write('pages/Home.tsx', 'export default function Home() { return <p>Hello</p> }')

    const url = loadUrl('&pageIds=ghost-1,ghost-2')
    const res = await tryServeStudio(new Request(url), undefined, url, url.pathname)
    expect(res!.status).toBe(200)
    const body = (await res!.json()) as { pages: unknown[]; missingPageIds: string[] }

    expect(body.pages).toEqual([])
    expect(body.missingPageIds).toEqual(['ghost-1', 'ghost-2'])
  })

  it('a brand-new page (studio_create_page) is reachable in a filtered load with no prior unfiltered load', async () => {
    write('pages/Home.tsx', 'export default function Home() { return <p>Hello</p> }')
    // Simulates the file `studio_create_page` writes AFTER the client's last
    // load — nothing has parsed this project since it landed on disk.
    write('pages/Pricing.tsx', 'export default function Pricing() { return <p>Pricing</p> }')

    const url = loadUrl('&pageIds=pricing')
    const res = await tryServeStudio(new Request(url), undefined, url, url.pathname)
    const body = (await res!.json()) as { pages: Array<{ id: string }>; missingPageIds: string[] }

    expect(body.pages.map((p) => p.id)).toEqual(['pricing'])
    expect(body.missingPageIds).toEqual([])
  })

  it('meta stays project-wide even when filtered: componentSources for the UNREQUESTED page is still present', async () => {
    write('pages/Home.tsx', 'export default function Home() { return <p>Hello</p> }')
    write(
      'pages/About.tsx',
      [
        "import { Button } from '@alm-design/design-system'",
        'export default function About() {',
        '  return <Button label="Go" />',
        '}',
        '',
      ].join('\n'),
    )

    const url = loadUrl('&pageIds=home')
    const res = await tryServeStudio(new Request(url), undefined, url, url.pathname)
    const body = (await res!.json()) as {
      pages: Array<{ id: string }>
      componentSources: Record<string, { kind: string; specifier?: string }>
    }

    // Only "home" was requested and streamed back...
    expect(body.pages.map((p) => p.id)).toEqual(['home'])
    // ...but the About page's package-component classification still shows
    // up in the meta line, because componentSources is genuinely
    // project-wide and a filtered load never skips recomputing it.
    const values = Object.values(body.componentSources)
    expect(values.some((s) => s.kind === 'package' && s.specifier === '@alm-design/design-system')).toBe(true)
  })

  it('an empty pageIds value is a 400, not "no filter"', async () => {
    write('pages/Home.tsx', 'export default function Home() { return <p>Hello</p> }')

    const url = loadUrl('&pageIds=')
    const res = await tryServeStudio(new Request(url), undefined, url, url.pathname)
    expect(res!.status).toBe(400)
  })

  it('a whitespace/empty-segments-only pageIds value is a 400', async () => {
    write('pages/Home.tsx', 'export default function Home() { return <p>Hello</p> }')

    const url = loadUrl(`&pageIds=${encodeURIComponent(' , , ')}`)
    const res = await tryServeStudio(new Request(url), undefined, url, url.pathname)
    expect(res!.status).toBe(400)
  })

  it('?stream=1&pageIds= streams only the requested page, with a meta line carrying missingPageIds', async () => {
    write('pages/Home.tsx', 'export default function Home() { return <p>Hello</p> }')
    write('pages/About.tsx', 'export default function About() { return <p>About us</p> }')

    const url = loadUrl('&pageIds=home,ghost&stream=1')
    const res = await tryServeStudio(new Request(url), undefined, url, url.pathname)
    expect(res!.headers.get('content-type')).toBe('application/x-ndjson')
    const lines = (await res!.text())
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { kind: string; [k: string]: unknown })

    const metaLine = lines.find((l) => l.kind === 'meta') as
      | { kind: 'meta'; pageCount: number; missingPageIds: string[] }
      | undefined
    expect(metaLine).toBeDefined()
    expect(metaLine!.pageCount).toBe(1)
    expect(metaLine!.missingPageIds).toEqual(['ghost'])

    const pageLines = lines.filter((l) => l.kind === 'page') as Array<{ kind: 'page'; page: { id: string } }>
    expect(pageLines.map((l) => l.page.id)).toEqual(['home'])
  })
})

describe('GET /admin/api/studio/load — Next.js App Router (WS-1.3)', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-load-next-app-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function write(relPath: string, contents: string): void {
    const full = path.join(tmpDir, ...relPath.split('/'))
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, contents, 'utf8')
  }

  /** Probes the fixture for real (same as the ingest pipeline would) and persists the profile, so `loadStudioPages` branches on a genuine `ProjectProfile`, not a hand-typed stand-in. */
  function persistNextAppProfile(): void {
    const profile = probeProject(tmpDir)
    expect(profile.framework).toBe('next-app') // guards the fixture itself, not the thing under test
    mergeStudioMeta(tmpDir, { profile })
  }

  async function load(): Promise<{
    pages: Array<{ id: string; slug: string; title: string; nodes: Record<string, { id: string; moduleId: string; props: Record<string, unknown> }> }>
  }> {
    const url = new URL(`http://localhost/admin/api/studio/load?dir=${encodeURIComponent(tmpDir)}`)
    const req = new Request(url)
    const res = await tryServeStudio(req, undefined, url, url.pathname)
    expect(res).not.toBeNull()
    return res!.json()
  }

  it('names the frame after the ROUTE, not "page"/"page (2)"', async () => {
    write('next.config.js', 'module.exports = {}\n')
    write(
      'app/layout.tsx',
      ['export default function RootLayout({ children }) {', '  return <html><body>{children}</body></html>', '}', ''].join('\n'),
    )
    write(
      'app/(marketing)/pricing/page.tsx',
      ['export default function PricingPage() {', '  return <main>Pricing</main>', '}', ''].join('\n'),
    )
    write(
      'app/dashboard/page.tsx',
      ['export default function DashboardPage() {', '  return <main>Dashboard</main>', '}', ''].join('\n'),
    )
    persistNextAppProfile()

    const { pages } = await load()

    expect(pages.map((p) => p.id).sort()).toEqual(['/dashboard', '/pricing'])
    expect(pages.map((p) => p.title).sort()).toEqual(['/dashboard', '/pricing'])
    expect(pages.every((p) => p.slug !== 'page')).toBe(true)
  })

  it('composes the root layout around the page, and a node from each file writes back to that file', async () => {
    write('next.config.js', 'module.exports = {}\n')
    write(
      'app/layout.tsx',
      [
        'export default function RootLayout({ children }) {',
        '  return <html><body className="shell">{children}</body></html>',
        '}',
        '',
      ].join('\n'),
    )
    write(
      'app/pricing/page.tsx',
      ['export default function PricingPage() {', '  return <main className="pricing">Pricing</main>', '}', ''].join('\n'),
    )
    persistNextAppProfile()

    const { pages } = await load()
    const pricing = pages.find((p) => p.id === '/pricing')!
    const nodes = Object.values(pricing.nodes)

    // The composed tree includes BOTH the layout's own element (<body>) and
    // the page's own element (<main>) — nothing was dropped or fabricated.
    const body = nodes.find((n) => n.id.startsWith('app/layout.tsx:'))
    const main = nodes.find((n) => n.id.startsWith('app/pricing/page.tsx:'))
    expect(body).toBeDefined()
    expect(main).toBeDefined()
    expect(body!.id.startsWith('app/layout.tsx:')).toBe(true)
    expect(main!.id.startsWith('app/pricing/page.tsx:')).toBe(true)

    // Writeback: an edit to the LAYOUT node lands in app/layout.tsx...
    const wroteLayout = applyStudioEdit(tmpDir, { kind: 'prop', nodeId: body!.id, prop: 'data-chrome', value: 'ok' })
    expect(wroteLayout.applied).toBe(true)
    expect(fs.readFileSync(path.join(tmpDir, 'app', 'layout.tsx'), 'utf8')).toContain('data-chrome="ok"')

    // ...and an edit to the PAGE node lands in app/pricing/page.tsx — never
    // the other file.
    const wrotePage = applyStudioEdit(tmpDir, { kind: 'prop', nodeId: main!.id, prop: 'data-content', value: 'ok' })
    expect(wrotePage.applied).toBe(true)
    const pageSource = fs.readFileSync(path.join(tmpDir, 'app', 'pricing', 'page.tsx'), 'utf8')
    expect(pageSource).toContain('data-content="ok"')
    expect(pageSource).not.toContain('data-chrome')
    const layoutSource = fs.readFileSync(path.join(tmpDir, 'app', 'layout.tsx'), 'utf8')
    expect(layoutSource).not.toContain('data-content')
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
