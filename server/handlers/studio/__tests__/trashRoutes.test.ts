/**
 * trashRoutes — the wire-level half of the workspace trash.
 *
 * `projectTrash.test.ts` already proves the verbs themselves (containment,
 * the slug-collision refusal, what purge erases). What is only true at this
 * level is the mapping: which failures become which status, that the listing
 * reads the REAL projects root rather than a caller-supplied one, and — the
 * property worth a test more than any other here — that the two destructive
 * routes refuse an unauthenticated caller before they touch the filesystem.
 *
 * `STUDIO_WORKSPACE_DIR` points `projectsRootDir()` at a temp directory for
 * the duration of each case, exactly as the containment guards' own tests do,
 * so nothing here can see or move a real project.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { DbClient } from '../../../db/client'
import { PROJECTS_TRASH_DIR_NAME, trashStudioProject } from '../projectTrash'
import { tryServeStudioTrashRoutes } from '../trashRoutes'

let root: string
let previousWorkspaceDir: string | undefined

/**
 * The gated routes reject an unauthenticated request inside
 * `requireAuthenticatedUser` before the `DbClient` is ever consulted, so a
 * stub that throws on use proves the gate ran rather than merely passing one.
 */
const unusedDb = new Proxy({} as DbClient, {
  get() {
    throw new Error('the capability gate must reject before the database is touched')
  },
})

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'trash-routes-'))
  previousWorkspaceDir = process.env.STUDIO_WORKSPACE_DIR
  process.env.STUDIO_WORKSPACE_DIR = root
})

afterEach(() => {
  if (previousWorkspaceDir === undefined) delete process.env.STUDIO_WORKSPACE_DIR
  else process.env.STUDIO_WORKSPACE_DIR = previousWorkspaceDir
  fs.rmSync(root, { recursive: true, force: true })
})

function makeProject(folder: string): string {
  const dir = path.join(root, folder)
  fs.mkdirSync(path.join(dir, 'pages'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'pages', 'Home.tsx'), 'export default function P() { return <div /> }\n')
  return dir
}

function serve(method: 'GET' | 'POST', pathname: string, body?: unknown) {
  const url = new URL(`http://localhost${pathname}`)
  const req =
    method === 'GET'
      ? new Request(url)
      : new Request(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body ?? {}),
        })
  return tryServeStudioTrashRoutes(req, { db: unusedDb }, url, url.pathname)
}

describe('GET /admin/api/studio/trash', () => {
  it('is empty before anything has been deleted', async () => {
    const res = await serve('GET', '/admin/api/studio/trash')

    expect(res!.status).toBe(200)
    expect((await res!.json()) as { projects: unknown[] }).toEqual({ projects: [] })
  })

  it('lists a deleted project with the three facts the panel renders', async () => {
    trashStudioProject(root, makeProject('acme'))

    const res = await serve('GET', '/admin/api/studio/trash')
    const body = (await res!.json()) as {
      projects: Array<{ entry: string; name: string; trashedAt: number; sizeBytes: number }>
    }

    expect(body.projects).toHaveLength(1)
    expect(body.projects[0]!.name).toBe('acme')
    expect(body.projects[0]!.trashedAt).toBeGreaterThan(0)
    expect(body.projects[0]!.sizeBytes).toBeGreaterThan(0)
  })

  it('claims no other path', async () => {
    expect(await serve('GET', '/admin/api/studio/projects')).toBeNull()
  })
})

/**
 * Both write routes are gated on `studio.write`. An unauthenticated request
 * must be refused BEFORE anything on disk moves — a restore that ran first and
 * checked afterwards would already have overwritten whatever was in its way.
 */
describe('the capability gate on the write routes', () => {
  it('refuses an unauthenticated restore without moving the project out of the trash', async () => {
    const entry = path.basename(trashStudioProject(root, makeProject('acme')))

    const res = await serve('POST', '/admin/api/studio/trash/restore', { entry })

    expect(res!.status).toBe(401)
    expect(fs.existsSync(path.join(root, PROJECTS_TRASH_DIR_NAME, entry))).toBe(true)
    expect(fs.existsSync(path.join(root, 'acme'))).toBe(false)
  })

  it('refuses an unauthenticated purge without erasing anything', async () => {
    const entry = path.basename(trashStudioProject(root, makeProject('acme')))

    const res = await serve('POST', '/admin/api/studio/trash/purge', { entry })

    expect(res!.status).toBe(401)
    expect(fs.existsSync(path.join(root, PROJECTS_TRASH_DIR_NAME, entry, 'pages', 'Home.tsx'))).toBe(true)
  })
})
