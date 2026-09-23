/**
 * The correctness bug `pageParseCache.ts`'s one-level dependency limit used to
 * cause: a page imports a local component (`Level1`), which itself imports
 * ANOTHER local component (`Level2`) — a two-hop chain. Editing `Level2.tsx`
 * changes what `Level1` (and therefore the page) renders, but the OLD
 * dependency tracking only recorded the page's OWN file and its DIRECT local
 * imports (`Level1.tsx`) — `Level2.tsx` was never in the recorded set, so
 * `pageParseCache`'s per-route entry kept serving its pre-edit parse forever
 * (until the page's own file, or `Level1.tsx`, also happened to change).
 *
 * This is reachable through the ordinary `loadStudioPages` entry point: the
 * OUTER workspace-fingerprint memo (`studioLoadMemo.ts`) fingerprints every
 * file, including `Level2.tsx`, so it correctly forces a fresh
 * `computeStudioPages()` call — but INSIDE that fresh compute, the INNER
 * per-route cache (`pageParseCache.ts`) used to still answer with a stale hit
 * for the page's own cache key, because none of ITS recorded dependencies had
 * moved. Two real cache layers, and the inner one was the one with the wrong
 * boundary.
 *
 * Confirmed to fail without the fix: reverting `inlineLocalComponents.ts`'s
 * `dependencyFiles` tracking (or reverting `parseStandardRouteEntry`'s use of
 * it) makes the second assertion in the first test below fail — the page
 * keeps reporting `original`, never `changed`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { clearPageParseCache } from '../studio/pageParseCache'
import { clearStudioLoadMemo } from '../studio/studioLoadMemo'
import { clearWorkspaceProjects } from '../studio/workspaceProject'
import { projectsRootDir } from '../studioProjects'
import { loadStudioPages } from '../studioPageLoad'

describe('loadStudioPages — a component TWO hops deep from a page (deep-dependency cache invalidation)', () => {
  let wsDir: string

  function write(relPath: string, contents: string): void {
    const full = path.join(wsDir, ...relPath.split('/'))
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, contents, 'utf8')
  }

  function bump(absFile: string): void {
    const bumped = new Date(fs.statSync(absFile).mtime.getTime() + 5000)
    fs.utimesSync(absFile, bumped, bumped)
  }

  beforeEach(() => {
    clearPageParseCache()
    clearStudioLoadMemo()
    clearWorkspaceProjects()
    const root = projectsRootDir()
    fs.mkdirSync(root, { recursive: true })
    wsDir = fs.mkdtempSync(path.join(root, '__deep_dep_cache_test_'))

    // Home.tsx -> Level1.tsx -> Level2.tsx: a TWO-hop chain. Home.tsx's own
    // `sources` (resolveComponentSources at the page level) only ever names
    // Level1.tsx directly — Level2.tsx is discovered only while
    // `inlineLocalComponents` expands Level1's own returned JSX.
    write('components/Level2.tsx', [
      'export default function Level2() {',
      '  return <span>original</span>',
      '}',
      '',
    ].join('\n'))
    write('components/Level1.tsx', [
      "import Level2 from './Level2'",
      'export default function Level1() {',
      '  return <div><Level2 /></div>',
      '}',
      '',
    ].join('\n'))
    write('pages/Home.tsx', [
      "import Level1 from '../components/Level1'",
      'export default function Home() {',
      '  return <Level1 />',
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

  it('picks up an edit to the deeply-nested (2-hop) component on the very next load', async () => {
    const first = await loadStudioPages(wsDir)
    expect(JSON.stringify(first.pages)).toContain('original')

    const level2File = path.join(wsDir, 'components', 'Level2.tsx')
    fs.writeFileSync(level2File, [
      'export default function Level2() {',
      '  return <span>changed</span>',
      '}',
      '',
    ].join('\n'))
    bump(level2File)

    const second = await loadStudioPages(wsDir)
    expect(JSON.stringify(second.pages)).toContain('changed')
    expect(JSON.stringify(second.pages)).not.toContain('original')
  })

  it('keeps serving the SAME (correct) content when nothing changed — a repeat load is not just "always miss"', async () => {
    const first = await loadStudioPages(wsDir)
    const second = await loadStudioPages(wsDir)
    expect(second.pages).toEqual(first.pages)
  })

  it('still invalidates on an edit to the page\'s own file, unaffected by the deep-dependency change', async () => {
    const first = await loadStudioPages(wsDir)
    const homeFile = path.join(wsDir, 'pages', 'Home.tsx')
    fs.writeFileSync(homeFile, [
      "import Level1 from '../components/Level1'",
      'export default function Home() {',
      '  return <div><Level1 /><p>page-own-edit</p></div>',
      '}',
      '',
    ].join('\n'))
    bump(homeFile)

    const second = await loadStudioPages(wsDir)
    expect(JSON.stringify(second.pages)).toContain('page-own-edit')
    expect(second.pages).not.toEqual(first.pages)
  })
})
