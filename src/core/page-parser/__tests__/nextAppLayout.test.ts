/**
 * nextAppLayout — WS-1.3 of `STUDIO-IMPORT-V2-PLAN.md`: composing a Next.js
 * App Router route (`RootLayout(SegmentLayout(Page))`) and recording the
 * async-server-component finding. Fixture tree combines every shape the work
 * order calls out: a route group, a nested layout, a dynamic segment, and a
 * `template.tsx` — plus a generic-repo-shapes discipline check (this fixture
 * shares nothing with the eSIM corpus; it is a synthetic Next.js app).
 *
 * Real temp fixture trees, same convention as `inlineLocalComponents.test.ts`
 * — module resolution depends on real filesystem paths.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { decodeSourceNodeId } from '@core/page-tree'
import { parsePageFile } from '../parsePageFile'
import { createWorkspaceProject, resolveComponentSources } from '../componentSources'
import { inlineLocalComponents } from '../inlineLocalComponents'
import { composeAppRouterRoute, type ComposeAppRouterRouteResult } from '../nextAppLayout'
import type { ParsedNode } from '../types'

let tmpDir: string
let appDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'next-app-layout-'))
  appDir = path.join(tmpDir, 'app')
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function write(relPath: string, contents: string): string {
  const full = path.join(appDir, ...relPath.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents, 'utf8')
  return full
}

function byName(nodes: Record<string, ParsedNode>, name: string): ParsedNode {
  const node = Object.values(nodes).find((n) => n.name === name)
  if (!node) throw new Error(`no composed node named "${name}" (have: ${Object.values(nodes).map((n) => n.name).join(', ')})`)
  return node
}

/**
 * Full pipeline for one route: parse the page + inline its own local
 * components (exactly what `buildAppRouterPageEntries` in
 * `studioPageLoad.ts` does), then compose it with `layoutRelFiles` (outermost
 * first).
 */
function composeRoute(pageRelFile: string, layoutRelFiles: string[]): ComposeAppRouterRouteResult {
  const project = createWorkspaceProject(tmpDir)
  const pageAbsFile = path.join(appDir, ...pageRelFile.split('/'))
  const parsed = parsePageFile(pageAbsFile, tmpDir, project)
  const sources = resolveComponentSources(project, pageAbsFile, tmpDir, parsed)
  const pageExpanded = inlineLocalComponents(parsed, sources, project, tmpDir)

  return composeAppRouterRoute({
    page: pageExpanded,
    pageAbsFile,
    layoutAbsFiles: layoutRelFiles.map((rel) => path.join(appDir, ...rel.split('/'))),
    project,
    workspaceRoot: tmpDir,
    evalOptions: undefined,
  })
}

describe('composeAppRouterRoute — a route group + nested layout + dynamic segment + template.tsx fixture', () => {
  beforeEach(() => {
    write(
      'layout.tsx',
      [
        'export default function RootLayout({ children }) {',
        '  return (',
        '    <html>',
        '      <body className="root-shell">{children}</body>',
        '    </html>',
        '  )',
        '}',
        '',
      ].join('\n'),
    )
    write(
      '(marketing)/layout.tsx',
      [
        'export default function MarketingLayout({ children }) {',
        '  return <div className="marketing-shell">{children}</div>',
        '}',
        '',
      ].join('\n'),
    )
    write(
      '(marketing)/blog/[slug]/page.tsx',
      [
        'export default function BlogPostPage() {',
        '  return <main className="post"><h1>Hello</h1></main>',
        '}',
        '',
      ].join('\n'),
    )
    // Present in the fixture, per the work order — a template.tsx is
    // recognized as a real App Router file but is not composed (only
    // layout.tsx is, per this module's scope) and is never itself a route.
    write(
      '(marketing)/blog/[slug]/template.tsx',
      [
        'export default function BlogPostTemplate({ children }) {',
        '  return <section className="template">{children}</section>',
        '}',
        '',
      ].join('\n'),
    )
  })

  it('composes RootLayout(MarketingLayout(Page)), replacing nothing and dropping nothing', () => {
    const result = composeRoute('(marketing)/blog/[slug]/page.tsx', ['layout.tsx', '(marketing)/layout.tsx'])

    expect(result.composedLayoutFiles).toEqual(['app/layout.tsx', 'app/(marketing)/layout.tsx'])

    const html = byName(result.page.nodes, 'html')
    const body = byName(result.page.nodes, 'body')
    const marketingDiv = byName(result.page.nodes, 'div')
    const main = byName(result.page.nodes, 'main')
    const h1 = byName(result.page.nodes, 'h1')

    // The composed tree really does nest outer -> inner: html > body > div > main > h1.
    expect(result.page.rootIds).toEqual([html.id])
    expect(html.children).toContain(body.id)
    expect(body.children).toContain(marketingDiv.id)
    expect(marketingDiv.children).toContain(main.id)
    expect(main.children).toContain(h1.id)
    expect(h1.text).toBe('Hello')
  })

  it('every composed node still writes back to its OWN file — the layout/page boundary is honest', () => {
    const result = composeRoute('(marketing)/blog/[slug]/page.tsx', ['layout.tsx', '(marketing)/layout.tsx'])

    const html = byName(result.page.nodes, 'html')
    const marketingDiv = byName(result.page.nodes, 'div')
    const h1 = byName(result.page.nodes, 'h1')

    // A node that came from app/layout.tsx decodes back to app/layout.tsx —
    // never to the page, and never to a nonexistent composite path. Ids are
    // relative to the WORKSPACE root (`tmpDir`), so they carry the `app/`
    // prefix — same convention every other studio node id uses.
    expect(decodeSourceNodeId(html.id)?.rel).toBe('app/layout.tsx')
    expect(decodeSourceNodeId(marketingDiv.id)?.rel).toBe('app/(marketing)/layout.tsx')
    // The page's own node still writes back to the page's own file.
    expect(decodeSourceNodeId(h1.id)?.rel).toBe('app/(marketing)/blog/[slug]/page.tsx')
  })

  it('reports every layout-contributed node id as "chrome", and every page node as NOT chrome', () => {
    const result = composeRoute('(marketing)/blog/[slug]/page.tsx', ['layout.tsx', '(marketing)/layout.tsx'])

    const html = byName(result.page.nodes, 'html')
    const body = byName(result.page.nodes, 'body')
    const marketingDiv = byName(result.page.nodes, 'div')
    const main = byName(result.page.nodes, 'main')
    const h1 = byName(result.page.nodes, 'h1')

    expect(result.chromeNodeIds.sort()).toEqual([html.id, body.id, marketingDiv.id].sort())
    expect(result.chromeNodeIds).not.toContain(main.id)
    expect(result.chromeNodeIds).not.toContain(h1.id)
  })

  it('composes just the page when the layout chain is empty', () => {
    const result = composeRoute('(marketing)/blog/[slug]/page.tsx', [])
    expect(result.composedLayoutFiles).toEqual([])
    expect(result.chromeNodeIds).toEqual([])
    const main = byName(result.page.nodes, 'main')
    expect(result.page.rootIds).toEqual([main.id])
  })
})

describe('composeAppRouterRoute — a layout with no {children} slot declines rather than dropping the page', () => {
  it('falls back to the page alone when the layout never references its children param', () => {
    write(
      'layout.tsx',
      [
        'export default function RootLayout() {',
        '  return <html><body>static shell, no slot</body></html>',
        '}',
        '',
      ].join('\n'),
    )
    write(
      'dashboard/page.tsx',
      ['export default function DashboardPage() {', '  return <main>Dashboard</main>', '}', ''].join('\n'),
    )

    const result = composeRoute('dashboard/page.tsx', ['layout.tsx'])

    // Declined: the layout contributes NOTHING, and the page's own content is
    // still present, unmodified — never silently dropped.
    expect(result.composedLayoutFiles).toEqual([])
    expect(result.chromeNodeIds).toEqual([])
    const main = byName(result.page.nodes, 'main')
    expect(main.text).toBe('Dashboard')
    expect(result.page.rootIds).toEqual([main.id])
  })
})

describe('composeAppRouterRoute — async server component records a finding, not empty output', () => {
  it('marks the page root with a resolution note and still renders its static structure', () => {
    write(
      'dashboard/page.tsx',
      [
        'export default async function DashboardPage() {',
        '  const data = await fetchDashboardStats()',
        '  return (',
        '    <main className="dashboard">',
        '      <h1>Dashboard</h1>',
        '      <p>{data.summary}</p>',
        '    </main>',
        '  )',
        '}',
        '',
      ].join('\n'),
    )

    const result = composeRoute('dashboard/page.tsx', [])

    const main = byName(result.page.nodes, 'main')
    const h1 = byName(result.page.nodes, 'h1')
    const p = byName(result.page.nodes, 'p')

    // A finding, not silence: the root node explains WHY.
    expect(main.resolution?.note).toMatch(/async server component/i)
    expect(main.resolution?.source).toBe('app/dashboard/page.tsx')
    // Not locked for it — an async component's STRUCTURE is not a runtime
    // choice, only some of its VALUES are unreadable.
    expect(main.locked).toBeFalsy()

    // Not empty output: the literal, statically-derivable structure is still
    // there in full — `<h1>Dashboard</h1>` never depended on the awaited data.
    expect(h1.text).toBe('Dashboard')
    // The awaited value genuinely does not resolve (parse, never execute) —
    // it must not be fabricated. `data.summary` reads off a `const` bound to
    // an `await` expression, which the evaluator (correctly) cannot read.
    expect(p.text).toBeUndefined()
  })

  it('does not mark a sync component at all', () => {
    write('home/page.tsx', ['export default function HomePage() {', '  return <main>Home</main>', '}', ''].join('\n'))
    const result = composeRoute('home/page.tsx', [])
    const main = byName(result.page.nodes, 'main')
    expect(main.resolution).toBeUndefined()
  })
})

describe('composeAppRouterRoute — an async layout also gets its own finding', () => {
  it('marks the layout root, independent of the page', () => {
    write(
      'layout.tsx',
      [
        'export default async function RootLayout({ children }) {',
        '  const settings = await loadSiteSettings()',
        '  return <html><body className={settings.theme}>{children}</body></html>',
        '}',
        '',
      ].join('\n'),
    )
    write('page.tsx', ['export default function HomePage() {', '  return <main>Home</main>', '}', ''].join('\n'))

    const result = composeRoute('page.tsx', ['layout.tsx'])

    const html = byName(result.page.nodes, 'html')
    const main = byName(result.page.nodes, 'main')
    expect(html.resolution?.note).toMatch(/async server component/i)
    expect(main.resolution).toBeUndefined()
  })
})

describe('composeAppRouterRoute — one layout shared by sibling routes', () => {
  it('gives the same layout node the same id in every route that composes it', () => {
    write(
      'blog/layout.tsx',
      [
        'export default function BlogLayout({ children }) {',
        '  return (',
        '    <div>',
        '      <nav>Blog nav</nav>',
        '      {children}',
        '    </div>',
        '  )',
        '}',
        '',
      ].join('\n'),
    )
    write('blog/first/page.tsx', ['export default function First() {', '  return <article>First</article>', '}', ''].join('\n'))
    write('blog/second/page.tsx', ['export default function Second() {', '  return <article>Second</article>', '}', ''].join('\n'))

    const first = composeRoute('blog/first/page.tsx', ['blog/layout.tsx'])
    const second = composeRoute('blog/second/page.tsx', ['blog/layout.tsx'])

    const firstNavId = byName(first.page.nodes, 'nav').id
    const secondNavId = byName(second.page.nodes, 'nav').id

    // Both routes render the SAME `<nav>` from the SAME line of the SAME file,
    // so sharing an id is the honest outcome — it is one source location. What
    // matters is that callers know this id is not unique to one page.
    expect(firstNavId).toBe(secondNavId)
    expect(decodeSourceNodeId(firstNavId)?.rel).toBe('app/blog/layout.tsx')

    // The page's own node, by contrast, must stay distinct per route.
    expect(byName(first.page.nodes, 'article').id).not.toBe(byName(second.page.nodes, 'article').id)
  })
})
