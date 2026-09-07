/**
 * POST /admin/api/studio/pages-dir — the post-import summary step's picker,
 * where the user settles a question the probe had to guess at.
 *
 * The property that matters is that the answer STICKS: it has to survive into
 * `.studio/meta.json` as the `pagesDir` override, outrank the cached probe's
 * own guess, and change the page count the launcher reports — otherwise the
 * picker is a control that appears to work and changes nothing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { DbClient } from '../../../db/client'
import { projectPagesDir, studioProjectSummary } from '../../studioProjects'
import { readStudioMeta } from '../studioMeta'
import { tryServeStudioProjectRoutes } from '../projectRoutes'

let root: string

/** This route is not capability-gated (it neither deletes nor copies), so the db is never consulted. */
const unusedDb = new Proxy({} as DbClient, {
  get() {
    throw new Error('the pages-dir route must not touch the database')
  },
})

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-dir-route-'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function write(relPath: string, contents: string): void {
  const full = path.join(root, ...relPath.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents, 'utf8')
}

function serve(body: unknown) {
  const url = new URL('http://localhost/admin/api/studio/pages-dir')
  const req = new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return tryServeStudioProjectRoutes(req, { db: unusedDb }, url, url.pathname)
}

/**
 * A repo the heuristic guessed wrong about: the probe cached `src/components`
 * (one file, no screens) while the real screens sit in `src/screens`. This is
 * exactly the shape that populates `pagesDirCandidates`.
 */
function makeAmbiguousProject(): string {
  const dir = path.join(root, 'acme')
  write('acme/src/components/Button.tsx', 'export default function Button() { return <button /> }\n')
  write('acme/src/screens/Home.tsx', 'export default function Home() { return <div /> }\n')
  write('acme/src/screens/About.tsx', 'export default function About() { return <div /> }\n')
  write(
    'acme/.studio/meta.json',
    JSON.stringify({
      displayName: 'Acme',
      profile: {
        framework: 'vite',
        appRoot: '',
        pagesDir: 'src/components',
        routeStyle: 'flat',
        entryFiles: [],
        styleToolchain: {
          tailwind: null,
          cssModules: false,
          sass: false,
          postcssConfigPath: null,
          cssInJs: null,
        },
        packageManager: 'bun',
        componentPackages: [],
        aliases: {},
        warnings: [],
        pagesDirCandidates: [
          { dir: 'src/components', score: 0.9 },
          { dir: 'src/screens', score: 0.8 },
        ],
      },
    }),
  )
  return dir
}

describe('POST /admin/api/studio/pages-dir', () => {
  it('persists the chosen directory as the override, overruling the cached probe', async () => {
    const dir = makeAmbiguousProject()
    expect(studioProjectSummary(dir).pageCount).toBe(1) // the probe's guess

    const res = await serve({ dir, pagesDir: 'src/screens' })

    expect(res!.status).toBe(200)
    const body = (await res!.json()) as { project: { pageCount: number } }
    // The refreshed count is the point: the summary step asked "how many pages
    // will this board open with", and the answer changed because of the pick.
    expect(body.project.pageCount).toBe(2)
    expect(readStudioMeta(dir).pagesDir).toBe('src/screens')
    expect(projectPagesDir(dir)).toBe(path.join(dir, 'src/screens'))
    // The cached probe is left alone — re-deriving it would risk overwriting
    // the answer the user just gave.
    expect(readStudioMeta(dir).profile?.pagesDir).toBe('src/components')
  })

  it('keeps the display name the import recorded', async () => {
    const dir = makeAmbiguousProject()

    await serve({ dir, pagesDir: 'src/screens' })

    // A plain write (rather than a merge) here would erase the name the import
    // had just persisted, and the launcher would fall back to the folder slug.
    expect(readStudioMeta(dir).displayName).toBe('Acme')
  })

  it('refuses a traversal, an absolute path, and an empty value', async () => {
    const dir = makeAmbiguousProject()

    for (const pagesDir of ['../../etc', path.join(root, 'elsewhere'), '   ']) {
      const res = await serve({ dir, pagesDir })
      expect(res!.status).toBe(400)
    }
    expect(readStudioMeta(dir).pagesDir).toBeUndefined()
  })

  it('requires an explicit project dir, never the first-project-on-disk fallback', async () => {
    const res = await serve({ dir: '  ', pagesDir: 'src/screens' })

    expect(res!.status).toBe(400)
  })

  it('404s for a project that is no longer there', async () => {
    const res = await serve({ dir: path.join(root, 'never-existed'), pagesDir: 'pages' })

    expect(res!.status).toBe(404)
  })
})
