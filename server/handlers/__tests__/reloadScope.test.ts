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
import * as os from 'node:os'
import * as path from 'node:path'
import { clearPageParseCache } from '../studio/pageParseCache'
import { probeProject } from '../studio/projectProbe'
import { mergeStudioMeta } from '../studio/studioMeta'
import { projectsRootDir } from '../studioProjects'
import { loadStudioPages } from '../studioPageLoad'
import { tryServeStudioReloadScope } from '../studio/reloadScope'
import { tryServeStudio } from '../studio'

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

  it('rejects a dir outside studio-workspace/ with 404', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'reload-scope-outside-'))
    try {
      const { req, url, pathname } = makeRequest('/admin/api/studio/reload-scope', postBody({ dir: outside, files: ['pages/Home.tsx'] }))
      const res = await tryServeStudioReloadScope(req, url, pathname)
      expect(res!.status).toBe(404)
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
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

    it('widens for a file that is NOT any page\'s own file — a locally-inlined shared component', async () => {
      const { body } = await reloadScope(wsDir, ['components/Card.tsx'])
      expect(body).toEqual({ ok: true, narrow: false })
    })

    it('widens when editing About.tsx\'s own file even though About depends on Card.tsx — About IS the reparsed route, not a sharing OTHER route', async () => {
      const { body } = await reloadScope(wsDir, ['pages/About.tsx'])
      expect(body).toEqual({ ok: true, narrow: true, pageIds: ['about'] })
    })

    it('widens the WHOLE batch when even one touched file in it is not narrow-safe', async () => {
      const { body } = await reloadScope(wsDir, ['pages/Home.tsx', 'components/Card.tsx'])
      expect(body.narrow).toBe(false)
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

  it('widens unconditionally for an App Router project, even for its own page.tsx', async () => {
    write('next.config.js', 'module.exports = {}\n')
    write('app/page.tsx', 'export default function Page() { return <div>Home</div> }')
    // Persist the probe — same step `import-github`'s route takes, and the
    // one `loadStudioPages`/this route both actually consult.
    mergeStudioMeta(wsDir, { profile: probeProject(wsDir) })
    await loadStudioPages(wsDir)

    const { body } = await reloadScope(wsDir, ['app/page.tsx'])
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
