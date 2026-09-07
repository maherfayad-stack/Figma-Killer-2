/**
 * reloadScope — `POST /admin/api/studio/reload-scope` (Track C5, reload
 * surgery). See `server/handlers/studio/reloadScope.ts`'s own doc for the
 * full "when is a single-file reload sufficient" contract this exercises.
 *
 * Fixture posture matches `previewAxes.test.ts`/`trustTier.test.ts`: a temp
 * dir created INSIDE `projectsRootDir()` so the route's own
 * `isRealpathContained` guard passes. Unlike those routes, most tests here
 * also warm `pageParseCache.ts` first via a real `loadStudioPages(dir)` call
 * — exactly the sequencing a real session always has (the browser always
 * loads the project before it can edit it), and the ONE piece of state this
 * route's safety check actually depends on.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { clearPageParseCache } from '../studio/pageParseCache'
import { probeProject } from '../studio/projectProbe'
import { mergeStudioMeta } from '../studio/studioMeta'
import { projectsRootDir } from '../studioProjects'
import { loadStudioPages } from '../studioPageLoad'
import { tryServeStudioReloadScope } from '../studio/reloadScope'
import { tryServeStudio } from '../studio'
import { ProjectDirOutsideWorkspaceError } from '../studioProjects'
import { withOutsideWorkspaceDir } from './outsideWorkspaceDir'

function makeRequest(pathAndQuery: string, init?: RequestInit): { req: Request; url: URL; pathname: string } {
  const url = new URL(`http://localhost${pathAndQuery}`)
  const req = new Request(url, init)
  return { req, url, pathname: url.pathname }
}

function postBody(body: unknown) {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
}

async function reloadScope(dir: string, files: string[]) {
  const { req, url, pathname } = makeRequest('/admin/api/studio/reload-scope', postBody({ dir, files }))
  const res = await tryServeStudioReloadScope(req, url, pathname)
  return { status: res!.status, body: (await res!.json()) as { ok?: boolean; narrow: boolean; pageIds?: string[]; error?: string } }
}

describe('tryServeStudioReloadScope', () => {
  let wsDir: string

  beforeEach(() => {
    clearPageParseCache()
    const root = projectsRootDir()
    fs.mkdirSync(root, { recursive: true })
    wsDir = fs.mkdtempSync(path.join(root, '__reload_scope_test_'))
  })

  afterEach(() => {
    fs.rmSync(wsDir, { recursive: true, force: true })
    clearPageParseCache()
  })

  function write(relPath: string, contents: string): void {
    const full = path.join(wsDir, ...relPath.split('/'))
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, contents, 'utf8')
  }

  it('returns null for an unrelated path', async () => {
    const { req, url, pathname } = makeRequest('/admin/api/studio/other')
    expect(await tryServeStudioReloadScope(req, url, pathname)).toBeNull()
  })

  it('rejects a dir outside studio-workspace/', async () => {
    await withOutsideWorkspaceDir('reload-scope-outside', async (outside) => {
      const { req, url, pathname } = makeRequest('/admin/api/studio/reload-scope', postBody({ dir: outside, files: ['pages/Home.tsx'] }))
      await expect(tryServeStudioReloadScope(req, url, pathname)).rejects.toThrow(ProjectDirOutsideWorkspaceError)
    })
  })

  it('is not-narrow (widens) with an empty files list', async () => {
    const { body } = await reloadScope(wsDir, [])
    expect(body.narrow).toBe(false)
  })

  describe('a standard-framework project, cache warmed by a real load', () => {
    beforeEach(async () => {
      write('pages/Home.tsx', ['export default function Home() {', '  return <div>Home</div>', '}', ''].join('\n'))
      write('pages/About.tsx', [
        "import Card from '../components/Card'",
        'export default function About() {',
        '  return <Card />',
        '}',
        '',
      ].join('\n'))
      write('components/Card.tsx', 'export default function Card() { return <div>Card</div> }')
      await loadStudioPages(wsDir) // warms pageParseCache for every route above
    })

    it('narrow: true for a page\'s own file with no other route depending on it', async () => {
      const { body } = await reloadScope(wsDir, ['pages/Home.tsx'])
      expect(body).toEqual({ ok: true, narrow: true, pageIds: ['home'] })
    })

    it('narrow: true, both pageIds, for a batch touching two independent pages\' own files', async () => {
      const { body } = await reloadScope(wsDir, ['pages/Home.tsx', 'pages/About.tsx'])
      expect(body.narrow).toBe(true)
      expect(new Set(body.pageIds)).toEqual(new Set(['home', 'about']))
    })

    it('narrows a SHARED local component to exactly the pages that inline it — not the whole board', async () => {
      // The case this route used to refuse outright, and the one that matters:
      // `components/Card.tsx` is inlined into About only, so About is the
      // honest scope. Home is untouched and must not be reloaded.
      const { body } = await reloadScope(wsDir, ['components/Card.tsx'])
      expect(body).toEqual({ ok: true, narrow: true, pageIds: ['about'] })
    })

    it('a page\'s own file names that page, even when that page also depends on a shared component', async () => {
      const { body } = await reloadScope(wsDir, ['pages/About.tsx'])
      expect(body).toEqual({ ok: true, narrow: true, pageIds: ['about'] })
    })

    it('a batch of a page file AND a shared component unions their dependents', async () => {
      const { body } = await reloadScope(wsDir, ['pages/Home.tsx', 'components/Card.tsx'])
      expect(body.narrow).toBe(true)
      expect(new Set(body.pageIds)).toEqual(new Set(['home', 'about']))
    })

    it('widens for a path outside the workspace (adversarial input), never touches the filesystem with it', async () => {
      const { body } = await reloadScope(wsDir, ['../../../../etc/passwd'])
      expect(body.narrow).toBe(false)
    })

    it('widens for an absolute path (adversarial input)', async () => {
      const { body } = await reloadScope(wsDir, [path.join(wsDir, 'pages', 'Home.tsx')])
      expect(body.narrow).toBe(false)
    })

    it('widens for a file that does not exist at all', async () => {
      const { body } = await reloadScope(wsDir, ['pages/Nope.tsx'])
      expect(body.narrow).toBe(false)
    })
  })

  it('widens on a COLD cache — nothing has been loaded for this project in this process yet', async () => {
    write('pages/Home.tsx', ['export default function Home() {', '  return <div>Home</div>', '}', ''].join('\n'))
    // Deliberately no `loadStudioPages(wsDir)` call — the cache has no
    // entries for this dir, so there is no dependency data to consult.
    const { body } = await reloadScope(wsDir, ['pages/Home.tsx'])
    expect(body.narrow).toBe(false)
  })

  describe('an App Router project — route-derived page ids, layout chains', () => {
    beforeEach(async () => {
      write('next.config.js', 'module.exports = {}\n')
      write('app/layout.tsx', [
        'export default function RootLayout({ children }: { children: React.ReactNode }) {',
        '  return <div className="shell">{children}</div>',
        '}',
        '',
      ].join('\n'))
      write('app/page.tsx', 'export default function Page() { return <div>Home</div> }')
      write('app/about/page.tsx', 'export default function About() { return <div>About</div> }')
      // Persist the probe — same step `import-github`'s route takes, and the
      // one `loadStudioPages`/this route both actually consult.
      mergeStudioMeta(wsDir, { profile: probeProject(wsDir) })
      await loadStudioPages(wsDir)
    })

    it('narrows a route\'s own page.tsx to that route\'s id', async () => {
      const { body } = await reloadScope(wsDir, ['app/about/page.tsx'])
      expect(body).toEqual({ ok: true, narrow: true, pageIds: ['/about'] })
    })

    it('NEVER under-reloads a shared layout: a layout.tsx edit names EVERY route beneath it', async () => {
      // The `sharedComponents` shape that fires on nearly every App Router
      // save. Both routes compose this layout, so both are stale.
      const { body } = await reloadScope(wsDir, ['app/layout.tsx'])
      expect(body.narrow).toBe(true)
      expect(new Set(body.pageIds)).toEqual(new Set(['/', '/about']))
    })
  })

  it('widens when a discovered route has NO cache entry — it could depend on the touched file unseen', async () => {
    write('pages/Home.tsx', ['export default function Home() {', '  return <div>Home</div>', '}', ''].join('\n'))
    await loadStudioPages(wsDir) // warms Home only
    // A page created after the load, which nothing has parsed yet. Home's own
    // dependency set is complete and would happily narrow — but this route's
    // is unknown, so the whole request must widen.
    write('pages/Late.tsx', 'export default function Late() { return <div>Late</div> }')

    const { body } = await reloadScope(wsDir, ['pages/Home.tsx'])
    expect(body.narrow).toBe(false)
  })

  describe('a project with Storybook stories — story routes record their own dependencies', () => {
    beforeEach(async () => {
      write('pages/Home.tsx', ['export default function Home() {', '  return <div>Home</div>', '}', ''].join('\n'))
      write('components/Card.stories.tsx', [
        "import Card from './Card'",
        'export default { title: "Card", component: Card }',
        'export const Basic = { args: { label: "Hi" } }',
        '',
      ].join('\n'))
      write('components/Card.tsx', 'export default function Card({ label }: { label: string }) { return <div>{label}</div> }')
      await loadStudioPages(wsDir)
    })

    it('narrows an ordinary page edit — merely HAVING stories no longer widens the board', async () => {
      const { body } = await reloadScope(wsDir, ['pages/Home.tsx'])
      expect(body).toEqual({ ok: true, narrow: true, pageIds: ['home'] })
    })

    it('names the STORY\'s page for a component only a story renders', async () => {
      // The case the blanket rule could not express: `Card.tsx` is rendered by
      // the story and by no page, so the story's own frame is the honest —
      // and complete — scope.
      const { body } = await reloadScope(wsDir, ['components/Card.tsx'])
      expect(body.narrow).toBe(true)
      expect(body.pageIds).toEqual(['components-card-stories-basic'])
    })

    it('widens for an edit to the story FILE itself — a story frame can disappear', async () => {
      const { body } = await reloadScope(wsDir, ['components/Card.stories.tsx'])
      expect(body.narrow).toBe(false)
    })

    it('widens when a story file exists that no cached story route claims', async () => {
      // Written after the load, so nothing has parsed it: the story-shaped
      // version of "a discovered route with no cache entry".
      write('components/Late.stories.tsx', [
        "import Card from './Card'",
        'export default { title: "Late", component: Card }',
        'export const Basic = { args: { label: "Late" } }',
        '',
      ].join('\n'))
      const { body } = await reloadScope(wsDir, ['pages/Home.tsx'])
      expect(body.narrow).toBe(false)
    })
  })

  it('widens for a file no cached route claims — deeper than one-level dependency tracking can see', async () => {
    write('pages/Home.tsx', [
      "import Card from '../components/Card'",
      'export default function Home() { return <Card /> }',
      '',
    ].join('\n'))
    write('components/Card.tsx', [
      "import Badge from './Badge'",
      'export default function Card() { return <Badge /> }',
      '',
    ].join('\n'))
    write('components/Badge.tsx', 'export default function Badge() { return <span>B</span> }')
    await loadStudioPages(wsDir)

    // `pageParseCache.ts` tracks the route's own file plus its DIRECT local
    // component sources. `Badge.tsx` is one level further down, so no route
    // records it — and "nothing claims it" must widen, never reload nothing.
    const { body } = await reloadScope(wsDir, ['components/Badge.tsx'])
    expect(body.narrow).toBe(false)
  })

  // ---------------------------------------------------------------------
  // The safety argument itself: a narrow reload (via this route's decision,
  // then the EXISTING `?pageIds=` filter) must produce the SAME page content
  // a full, unfiltered reload would for the identical on-disk state.
  // ---------------------------------------------------------------------
  it('EQUIVALENCE — the narrow-reload path (reload-scope -> /load?pageIds=) returns byte-identical page content to a full reload', async () => {
    write('pages/Home.tsx', ['export default function Home() {', '  return <p>Original</p>', '}', ''].join('\n'))
    write('pages/About.tsx', ['export default function About() {', '  return <p>About</p>', '}', ''].join('\n'))
    await loadStudioPages(wsDir)

    // Simulate the codemod write a structural edit would have just made.
    write('pages/Home.tsx', ['export default function Home() {', '  return <p>Edited</p>', '}', ''].join('\n'))

    const scope = await reloadScope(wsDir, ['pages/Home.tsx'])
    expect(scope.body).toEqual({ ok: true, narrow: true, pageIds: ['home'] })

    const narrowUrl = new URL(`http://localhost/admin/api/studio/load?dir=${encodeURIComponent(wsDir)}&pageIds=home`)
    const narrowRes = await tryServeStudio(new Request(narrowUrl), undefined, narrowUrl, narrowUrl.pathname)
    const narrowBody = (await narrowRes!.json()) as { pages: Array<{ id: string; nodes: Record<string, { props: Record<string, unknown> }> }> }

    const fullUrl = new URL(`http://localhost/admin/api/studio/load?dir=${encodeURIComponent(wsDir)}`)
    const fullRes = await tryServeStudio(new Request(fullUrl), undefined, fullUrl, fullUrl.pathname)
    const fullBody = (await fullRes!.json()) as { pages: Array<{ id: string; nodes: Record<string, { props: Record<string, unknown> }> }> }

    expect(narrowBody.pages).toHaveLength(1)
    const narrowHome = narrowBody.pages[0]!
    const fullHome = fullBody.pages.find((p) => p.id === 'home')!
    expect(narrowHome).toEqual(fullHome)
    // And it genuinely picked up the edit, not stale cached content.
    expect(JSON.stringify(narrowHome)).toContain('Edited')
  })
})
