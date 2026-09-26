/**
 * WB-2 — the parse cache must invalidate on every file the §7 evaluator read a
 * VALUE out of, not only on the files the parse's STRUCTURE came from.
 *
 * `pageParseCache.ts` keys each route on the mtimes of its dependency set. That
 * set used to be the route's own file plus its inlined local components — so a
 * page rendering `{COPY.title}` from `src/copy.ts` cached text read out of a
 * file nobody watched. The outer `studioLoadMemo` fingerprint covered
 * `src/copy.ts` and correctly recomputed; the inner per-route cache then hit,
 * because none of ITS recorded files had moved. A resolved-text edit — a
 * `literal` edit at the text's `textOrigin`, exactly what the canvas sends —
 * therefore reverted itself on every later load. The same held for a Tier B
 * provider's `value` and for a `?raw` icon's markup.
 *
 * The fixture shares nothing with the eSIM corpus (per `genericRepoShapes.test.ts`'s
 * discipline): a small recipe app with a copy module, a theme context and an
 * inline SVG icon. Two pages read the same dictionary key, so the SECOND page
 * resolves it through the evaluator's module-const memo — which must replay
 * the file it read, or only the first page to parse would ever record it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Page, PageNode } from '@core/page-tree'
import { cachedRouteDependencies, clearPageParseCache } from '../studio/pageParseCache'
import { tryServeStudioReloadScope } from '../studio/reloadScope'
import { clearStudioLoadMemo } from '../studio/studioLoadMemo'
import { clearWorkspaceProjects } from '../studio/workspaceProject'
import { projectsRootDir } from '../studioProjects'
import { loadStudioPages } from '../studioPageLoad'
import { applyStudioEditBatch } from '../studioWriteback'

let wsDir: string

function write(relPath: string, contents: string): void {
  const full = path.join(wsDir, ...relPath.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents, 'utf8')
}

/** Move a file's mtime past anything a same-millisecond write could collide with — a real edit's stamp always moves. */
function bump(relPath: string): void {
  const abs = path.join(wsDir, ...relPath.split('/'))
  const later = new Date(fs.statSync(abs).mtime.getTime() + 5000)
  fs.utimesSync(abs, later, later)
}

function pageTitled(pages: readonly Page[], title: string): Page {
  const page = pages.find((candidate) => candidate.title === title)
  if (!page) throw new Error(`no page titled ${title}`)
  return page
}

function nodeWithText(page: Page, text: string): PageNode | undefined {
  return Object.values(page.nodes).find((node) => node.props?.text === text)
}

beforeEach(() => {
  clearPageParseCache()
  clearStudioLoadMemo()
  clearWorkspaceProjects()
  const root = projectsRootDir()
  fs.mkdirSync(root, { recursive: true })
  wsDir = fs.mkdtempSync(path.join(root, '__evaluator_deps_test_'))

  // Two hops: the pages import `COPY`, and `COPY` reads its strings from a
  // second module. The literal the edit rewrites lives in `strings.ts`, which
  // no page imports — only the evaluator ever sees it.
  write('src/strings.ts', "export const STRINGS = { hello: 'Hello original' }\n")
  write('src/copy.ts', [
    "import { STRINGS } from './strings'",
    "export const COPY = { title: STRINGS.hello, tagline: 'Fresh recipes' }",
    '',
  ].join('\n'))
  write('pages/Home.tsx', [
    "import { COPY } from '../src/copy'",
    'export default function Home() {',
    '  return <main><h1>{COPY.title}</h1></main>',
    '}',
    '',
  ].join('\n'))
  write('pages/About.tsx', [
    "import { COPY } from '../src/copy'",
    'export default function About() {',
    '  return <section><h2>{COPY.title}</h2></section>',
    '}',
    '',
  ].join('\n'))
  write('pages/Contact.tsx', [
    'export default function Contact() {',
    '  return <div><p>Write to us</p></div>',
    '}',
    '',
  ].join('\n'))
})

afterEach(() => {
  fs.rmSync(wsDir, { recursive: true, force: true })
  clearPageParseCache()
  clearStudioLoadMemo()
  clearWorkspaceProjects()
})

describe('WB-2 — a resolved-text edit survives the next load', () => {
  it('a literal edit at the textOrigin reaches EVERY page that reads it, on the very next load', async () => {
    const first = await loadStudioPages(wsDir)
    const heading = nodeWithText(pageTitled(first.pages, 'Home'), 'Hello original')
    expect(heading?.textOrigin).toBeDefined()
    expect(nodeWithText(pageTitled(first.pages, 'About'), 'Hello original')).toBeDefined()

    const { rel, line, col } = heading!.textOrigin!
    const result = applyStudioEditBatch(wsDir, [{ kind: 'literal', nodeId: `${rel}:${line}:${col}`, text: 'Hello edited' }])
    expect(result.written).toBe(1)
    expect(rel).toBe('src/strings.ts')
    expect(fs.readFileSync(path.join(wsDir, 'src', 'strings.ts'), 'utf8')).toContain('Hello edited')

    const second = await loadStudioPages(wsDir)
    for (const title of ['Home', 'About']) {
      expect(nodeWithText(pageTitled(second.pages, title), 'Hello edited')).toBeDefined()
      expect(nodeWithText(pageTitled(second.pages, title), 'Hello original')).toBeUndefined()
    }
  })

  it('records both dictionary modules as dependencies of both readers — and of nothing else', async () => {
    await loadStudioPages(wsDir)
    const deps = cachedRouteDependencies(wsDir)!
    for (const file of [path.join(wsDir, 'src', 'copy.ts'), path.join(wsDir, 'src', 'strings.ts')]) {
      expect(deps.get('Home.tsx')?.has(file)).toBe(true)
      // About resolves `COPY` through the module-const memo Home filled, so it
      // never walks into `strings.ts` itself — the memo must replay it.
      expect(deps.get('About.tsx')?.has(file)).toBe(true)
      expect(deps.get('Contact.tsx')?.has(file)).toBe(false)
    }
  })

  it('reports the literal edit as shared, and the resync it triggers narrows to exactly the readers', async () => {
    const first = await loadStudioPages(wsDir)
    const { rel, line, col } = nodeWithText(pageTitled(first.pages, 'Home'), 'Hello original')!.textOrigin!
    const result = applyStudioEditBatch(wsDir, [{ kind: 'literal', nodeId: `${rel}:${line}:${col}`, text: 'Hello edited' }])
    // Siblings update immediately: the client resyncs on `sharedComponents`.
    expect(result.sharedComponents).toBe(true)

    const url = new URL('http://localhost/admin/api/studio/reload-scope')
    const req = new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dir: wsDir, files: [rel] }),
    })
    const res = await tryServeStudioReloadScope(req, url, url.pathname)
    const body = (await res!.json()) as { narrow: boolean; pageIds?: string[] }
    expect(body.narrow).toBe(true)
    const expected = ['Home', 'About'].map((title) => pageTitled(first.pages, title).id).sort()
    expect([...(body.pageIds ?? [])].sort()).toEqual(expected)
  })
})

describe('WB-2 — the other files a value is read out of', () => {
  it('a Tier B provider value edited on disk shows on the next load', async () => {
    write('src/theme.tsx', [
      "import { createContext, useContext } from 'react'",
      'const ThemeCtx = createContext(null)',
      'export function ThemeProvider({ children }) {',
      "  const value = { label: 'Light mode' }",
      '  return <ThemeCtx.Provider value={value}>{children}</ThemeCtx.Provider>',
      '}',
      'export function useTheme() {',
      '  return useContext(ThemeCtx)',
      '}',
      '',
    ].join('\n'))
    write('pages/Settings.tsx', [
      "import { useTheme } from '../src/theme'",
      'export default function Settings() {',
      '  const { label } = useTheme()',
      '  return <div><p>{label}</p></div>',
      '}',
      '',
    ].join('\n'))

    const first = await loadStudioPages(wsDir)
    expect(nodeWithText(pageTitled(first.pages, 'Settings'), 'Light mode')).toBeDefined()

    write('src/theme.tsx', fs.readFileSync(path.join(wsDir, 'src', 'theme.tsx'), 'utf8').replace('Light mode', 'Night mode'))
    bump('src/theme.tsx')

    const second = await loadStudioPages(wsDir)
    expect(nodeWithText(pageTitled(second.pages, 'Settings'), 'Night mode')).toBeDefined()
  })

  it('a ?raw icon edited on disk shows its new markup on the next load', async () => {
    write('src/icons/leaf.svg', '<svg viewBox="0 0 8 8"><circle r="1"/></svg>\n')
    write('pages/Garden.tsx', [
      "import leaf from '../src/icons/leaf.svg?raw'",
      'export default function Garden() {',
      '  return <div><span className="icon" dangerouslySetInnerHTML={{ __html: leaf }} /></div>',
      '}',
      '',
    ].join('\n'))

    const first = await loadStudioPages(wsDir)
    expect(JSON.stringify(pageTitled(first.pages, 'Garden').nodes)).toContain('r=\\"1\\"')

    write('src/icons/leaf.svg', '<svg viewBox="0 0 8 8"><circle r="3"/></svg>\n')
    bump('src/icons/leaf.svg')

    const second = await loadStudioPages(wsDir)
    const garden = JSON.stringify(pageTitled(second.pages, 'Garden').nodes)
    expect(garden).toContain('r=\\"3\\"')
    expect(garden).not.toContain('r=\\"1\\"')
  })
})
