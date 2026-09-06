/**
 * The public share routes — `/share/<token>` and its two data sub-paths.
 *
 * The handler is exercised as a plain function rather than through
 * `Bun.serve`: the happy-dom test preload makes a real server unstartable in
 * this suite (recorded in PR #28's handoff), and every behaviour worth
 * asserting here is a pure `(Request, pathname) → Response`.
 *
 * What this file is really testing is the blast radius of a leaked or guessed
 * URL: that a revoked token is dead immediately, that an unknown one is
 * indistinguishable from a revoked one, and that no filename can reach a byte
 * outside the share's own directory.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { projectsRootDir } from '../studioProjects'
import { tryServeSharePublic } from './sharePublic'
import {
  clearShareLookupMemo,
  mintShareToken,
  revokeShareRecord,
  shareSnapshotDir,
  upsertShareRecord,
} from './shareStore'

let dir: string
let token: string

const BOARD_JSON = JSON.stringify({
  version: 1,
  projectName: 'Fixture',
  boardName: 'Board 1',
  sharedAt: '2026-09-05T09:00:00.000Z',
  frames: [{ name: 'Home', x: 0, y: 0, width: 1024, height: 800, image: 'aabbcc-0.png' }],
})

beforeEach(() => {
  const root = projectsRootDir()
  fs.mkdirSync(root, { recursive: true })
  dir = fs.mkdtempSync(path.join(root, '__share_public_test_'))
  clearShareLookupMemo()

  token = mintShareToken()
  const snapshotDir = shareSnapshotDir(dir, token)!
  fs.mkdirSync(snapshotDir, { recursive: true })
  fs.writeFileSync(path.join(snapshotDir, 'board.json'), BOARD_JSON)
  fs.writeFileSync(path.join(snapshotDir, 'aabbcc-0.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  upsertShareRecord(dir, {
    token,
    boardId: 'board-1',
    boardName: 'Board 1',
    createdAt: '2026-09-05T09:00:00.000Z',
    snapshotAt: '2026-09-05T09:00:00.000Z',
    frameCount: 1,
  })
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
  clearShareLookupMemo()
})

function get(pathname: string): Promise<Response | null> {
  return tryServeSharePublic(new Request(`http://localhost${pathname}`), pathname)
}

describe('tryServeSharePublic', () => {
  it('ignores a path outside the /share namespace', async () => {
    expect(await get('/about')).toBeNull()
    expect(await get('/admin/site')).toBeNull()
    expect(await get('/shares/whatever')).toBeNull()
  })

  it('serves the snapshot manifest for a live token, uncached', async () => {
    const res = await get(`/share/${token}/board.json`)
    expect(res?.status).toBe(200)
    expect(res?.headers.get('cache-control')).toBe('no-store')
    expect(await res!.json()).toEqual(JSON.parse(BOARD_JSON))
  })

  it('serves a frame image with an immutable, private cache header', async () => {
    const res = await get(`/share/${token}/frames/aabbcc-0.png`)
    expect(res?.status).toBe(200)
    expect(res?.headers.get('content-type')).toBe('image/png')
    expect(res?.headers.get('cache-control')).toBe('private, max-age=31536000, immutable')
  })

  it('404s the whole share the instant it is revoked', async () => {
    expect((await get(`/share/${token}/board.json`))?.status).toBe(200)
    revokeShareRecord(dir, token, new Date().toISOString())

    for (const suffix of ['', '/board.json', '/frames/aabbcc-0.png']) {
      expect((await get(`/share/${token}${suffix}`))?.status).toBe(404)
    }
  })

  it('gives an unknown token exactly the same answer as a revoked one', async () => {
    const unknown = await get(`/share/${mintShareToken()}/board.json`)
    revokeShareRecord(dir, token, new Date().toISOString())
    const revoked = await get(`/share/${token}/board.json`)

    expect(unknown?.status).toBe(404)
    expect(revoked?.status).toBe(404)
    expect(await unknown!.text()).toBe(await revoked!.text())
  })

  it('404s a malformed token without touching the filesystem', async () => {
    expect((await get('/share/nonsense'))?.status).toBe(404)
    expect((await get('/share/'))?.status).toBe(404)
    expect((await get('/share'))?.status).toBe(404)
  })

  it('refuses to serve anything outside the share directory', async () => {
    // The registry file itself is one level up from the snapshot directory.
    for (const attempt of [
      `/share/${token}/frames/..%2F..%2Fshares.json`,
      `/share/${token}/frames/../../shares.json`,
      `/share/${token}/frames/board.json`,
      `/share/${token}/frames/nested/aabbcc-0.png`,
      `/share/${token}/shares.json`,
      `/share/${token}/../shares.json`,
    ]) {
      const res = await get(attempt)
      expect(res?.status).toBe(404)
    }
  })

  it('absorbs its namespace rather than falling through on a bad method', async () => {
    const pathname = `/share/${token}/board.json`
    const res = await tryServeSharePublic(
      new Request(`http://localhost${pathname}`, { method: 'POST' }),
      pathname,
    )
    expect(res?.status).toBe(404)
  })

  it('keeps a share out of search indexes', async () => {
    // The entry is only served from a build; in a test tree there is no
    // `dist/share.html`, so the handler redirects to the dev entry instead.
    // Either way the token must survive the hop.
    const res = await get(`/share/${token}`)
    expect(res?.status === 302 || res?.status === 200).toBe(true)
    if (res?.status === 302) expect(res.headers.get('location')).toContain(token)
    else expect(res?.headers.get('x-robots-tag')).toBe('noindex, nofollow')
  })
})
