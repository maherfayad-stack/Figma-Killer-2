/**
 * previewAxes — WS-10 Phase 1 coverage for `GET/POST /admin/api/studio/preview-axes`.
 * Same fixture posture as `trustTier.test.ts`: a temp dir created INSIDE
 * `projectsRootDir()` so the route's own `isRealpathContained` guard passes.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { readStudioMeta } from '../studio/studioMeta'
import { projectsRootDir } from '../studioProjects'
import { tryServeStudioPreviewAxes } from '../studio/previewAxes'

function makeRequest(pathAndQuery: string, init?: RequestInit): { req: Request; url: URL; pathname: string } {
  const url = new URL(`http://localhost${pathAndQuery}`)
  const req = new Request(url, init)
  return { req, url, pathname: url.pathname }
}

function postBody(body: unknown) {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
}

describe('tryServeStudioPreviewAxes', () => {
  let wsDir: string

  beforeEach(() => {
    const root = projectsRootDir()
    fs.mkdirSync(root, { recursive: true })
    wsDir = fs.mkdtempSync(path.join(root, '__preview_axes_test_'))
  })

  afterEach(() => {
    fs.rmSync(wsDir, { recursive: true, force: true })
  })

  it('returns null for an unrelated path', async () => {
    const { req, url, pathname } = makeRequest('/admin/api/studio/other')
    expect(await tryServeStudioPreviewAxes(req, url, pathname)).toBeNull()
  })

  it('GET defaults to ltr/light when nothing is persisted', async () => {
    const { req, url, pathname } = makeRequest(`/admin/api/studio/preview-axes?dir=${encodeURIComponent(wsDir)}`)
    const res = await tryServeStudioPreviewAxes(req, url, pathname)
    const body = (await res!.json()) as { previewAxes: { direction: string; colorScheme: string } }
    expect(body.previewAxes).toEqual({ direction: 'ltr', colorScheme: 'light' })
  })

  it('GET rejects a dir outside studio-workspace/', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-axes-outside-'))
    try {
      const { req, url, pathname } = makeRequest(`/admin/api/studio/preview-axes?dir=${encodeURIComponent(outside)}`)
      const res = await tryServeStudioPreviewAxes(req, url, pathname)
      expect(res!.status).toBe(404)
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it('POST persists a partial patch and preserves other meta.json fields', async () => {
    fs.mkdirSync(path.join(wsDir, '.studio'), { recursive: true })
    fs.writeFileSync(path.join(wsDir, '.studio', 'meta.json'), JSON.stringify({ displayName: 'Fixture Project' }))

    const { req, url, pathname } = makeRequest(
      '/admin/api/studio/preview-axes',
      postBody({ dir: wsDir, previewAxes: { direction: 'rtl' } }),
    )
    const res = await tryServeStudioPreviewAxes(req, url, pathname)
    const body = (await res!.json()) as { ok: boolean; previewAxes: { direction: string; colorScheme: string } }
    expect(body.ok).toBe(true)
    expect(body.previewAxes).toEqual({ direction: 'rtl', colorScheme: 'light' })

    const meta = readStudioMeta(wsDir)
    expect(meta.previewAxes).toEqual({ direction: 'rtl' })
    expect(meta.displayName).toBe('Fixture Project') // untouched by the merge
  })

  it('a second partial patch merges onto the first instead of clobbering it', async () => {
    const first = makeRequest('/admin/api/studio/preview-axes', postBody({ dir: wsDir, previewAxes: { direction: 'rtl' } }))
    await tryServeStudioPreviewAxes(first.req, first.url, first.pathname)

    const { req, url, pathname } = makeRequest(
      '/admin/api/studio/preview-axes',
      postBody({ dir: wsDir, previewAxes: { colorScheme: 'dark' } }),
    )
    const res = await tryServeStudioPreviewAxes(req, url, pathname)
    const body = (await res!.json()) as { previewAxes: { direction: string; colorScheme: string } }
    // Both fields survive — direction from the first POST, colorScheme from the second.
    expect(body.previewAxes).toEqual({ direction: 'rtl', colorScheme: 'dark' })
  })

  it('POST rejects an invalid direction value', async () => {
    const { req, url, pathname } = makeRequest(
      '/admin/api/studio/preview-axes',
      postBody({ dir: wsDir, previewAxes: { direction: 'sideways' } }),
    )
    const res = await tryServeStudioPreviewAxes(req, url, pathname)
    expect(res!.status).toBe(400)
  })

  it('POST rejects a dir outside studio-workspace/ without writing anything', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-axes-outside-'))
    try {
      const { req, url, pathname } = makeRequest(
        '/admin/api/studio/preview-axes',
        postBody({ dir: outside, previewAxes: { direction: 'rtl' } }),
      )
      const res = await tryServeStudioPreviewAxes(req, url, pathname)
      expect(res!.status).toBe(404)
      expect(fs.existsSync(path.join(outside, '.studio'))).toBe(false)
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })
})
