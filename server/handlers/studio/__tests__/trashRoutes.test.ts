/**
 * trashRoutes — HTTP-level tests for `.studio/trash/`.
 *
 * `pageTrash.test.ts` covers the file moves themselves; these assert the wire
 * contract the explorer's Trash section depends on — status codes above all,
 * since a 409 (restore blocked by a real file) and a 404 (stale entry id) mean
 * completely different things to the user and only one of them is their
 * problem to fix.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { tryServeStudioTrash } from '../trashRoutes'
import { projectsRootDir } from '../../studioProjects'

let tmpDir: string
let pagesDir: string

beforeEach(() => {
  // Inside the real projects root: every route here refuses a `dir` that
  // resolves outside it, so a temp dir elsewhere would only ever get a 404.
  tmpDir = fs.mkdtempSync(path.join(projectsRootDir(), '.trash-routes-test-'))
  pagesDir = path.join(tmpDir, 'pages')
  fs.mkdirSync(pagesDir, { recursive: true })
  fs.writeFileSync(path.join(pagesDir, 'Home.tsx'), 'export default function Home() { return <div /> }\n')
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

async function send(method: string, routePath: string, body?: unknown): Promise<Response> {
  const url = new URL(`http://localhost${routePath}`)
  const init: RequestInit = { method }
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  const res = await tryServeStudioTrash(new Request(url, init), url, url.pathname)
  expect(res).not.toBeNull()
  return res!
}

async function trashHome(): Promise<string> {
  const res = await send('POST', '/admin/api/studio/trash', { dir: tmpDir, pageId: 'home', title: 'Home' })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { entry: { id: string } }
  return body.entry.id
}

describe('tryServeStudioTrash', () => {
  it('ignores a path it does not own', async () => {
    const url = new URL('http://localhost/admin/api/studio/page')
    expect(await tryServeStudioTrash(new Request(url), url, url.pathname)).toBeNull()
  })

  it('lists an empty trash for a fresh project', async () => {
    const res = await send('GET', `/admin/api/studio/trash?dir=${encodeURIComponent(tmpDir)}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, entries: [] })
  })

  it('moves a page in, then lists it', async () => {
    await trashHome()
    expect(fs.existsSync(path.join(pagesDir, 'Home.tsx'))).toBe(false)

    const res = await send('GET', `/admin/api/studio/trash?dir=${encodeURIComponent(tmpDir)}`)
    const body = (await res.json()) as { entries: { title: string; pageId: string }[] }
    expect(body.entries).toHaveLength(1)
    expect(body.entries[0]).toMatchObject({ title: 'Home', pageId: 'home' })
  })

  it('404s on trashing an id no page has', async () => {
    const res = await send('POST', '/admin/api/studio/trash', { dir: tmpDir, pageId: 'nope', title: 'Nope' })
    expect(res.status).toBe(404)
  })

  it('restores an entry, putting the file back', async () => {
    const entryId = await trashHome()

    const res = await send('POST', '/admin/api/studio/trash/restore', { dir: tmpDir, entryId })

    expect(res.status).toBe(200)
    expect(fs.existsSync(path.join(pagesDir, 'Home.tsx'))).toBe(true)
  })

  it('409s — not 404 — when a restore is blocked by a file that exists again', async () => {
    const entryId = await trashHome()
    fs.writeFileSync(path.join(pagesDir, 'Home.tsx'), 'export default function Home() { return <div>new</div> }\n')

    const res = await send('POST', '/admin/api/studio/trash/restore', { dir: tmpDir, entryId })

    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('pages/Home.tsx')
  })

  it('404s on restoring an unknown entry id', async () => {
    const res = await send('POST', '/admin/api/studio/trash/restore', { dir: tmpDir, entryId: 'nope' })
    expect(res.status).toBe(404)
  })

  it('purges one entry, and empties the trash when given no id', async () => {
    const first = await trashHome()
    const one = await send('DELETE', '/admin/api/studio/trash', { dir: tmpDir, entryId: first })
    expect(await one.json()).toEqual({ ok: true, purged: 1 })

    fs.writeFileSync(path.join(pagesDir, 'Home.tsx'), 'export default function Home() { return <div /> }\n')
    await trashHome()
    const all = await send('DELETE', '/admin/api/studio/trash', { dir: tmpDir })
    expect(await all.json()).toEqual({ ok: true, purged: 1 })
  })

  it('rejects a trash request with no pageId', async () => {
    const res = await send('POST', '/admin/api/studio/trash', { dir: tmpDir })
    expect(res.status).toBe(400)
  })
})
