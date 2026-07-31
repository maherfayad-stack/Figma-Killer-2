/**
 * trustTier — WS-3.3 coverage for `GET/POST /admin/api/studio/trust-tier`.
 * Same fixture posture as `componentBundle.test.ts`'s own route tests: a
 * temp dir created INSIDE `projectsRootDir()` so the route's own
 * `isRealpathContained(dir, projectsRootDir())` containment guard passes.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { readStudioMeta } from '../studio/studioMeta'
import { projectsRootDir } from '../studioProjects'
import { tryServeStudioTrustTier } from '../studio/trustTier'

function makeRequest(pathAndQuery: string, init?: RequestInit): { req: Request; url: URL; pathname: string } {
  const url = new URL(`http://localhost${pathAndQuery}`)
  const req = new Request(url, init)
  return { req, url, pathname: url.pathname }
}

function postBody(body: unknown) {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
}

describe('tryServeStudioTrustTier', () => {
  let wsDir: string

  beforeEach(() => {
    const root = projectsRootDir()
    fs.mkdirSync(root, { recursive: true })
    wsDir = fs.mkdtempSync(path.join(root, '__trust_tier_test_'))
  })

  afterEach(() => {
    fs.rmSync(wsDir, { recursive: true, force: true })
  })

  it('returns null for an unrelated path', async () => {
    const { req, url, pathname } = makeRequest('/admin/api/studio/other')
    expect(await tryServeStudioTrustTier(req, url, pathname)).toBeNull()
  })

  it('GET defaults to static (Tier 0) when nothing is persisted', async () => {
    const { req, url, pathname } = makeRequest(`/admin/api/studio/trust-tier?dir=${encodeURIComponent(wsDir)}`)
    const res = await tryServeStudioTrustTier(req, url, pathname)
    const body = (await res!.json()) as { trust: string }
    expect(body.trust).toBe('static')
  })

  it('GET rejects a dir outside studio-workspace/', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'trust-tier-outside-'))
    try {
      const { req, url, pathname } = makeRequest(`/admin/api/studio/trust-tier?dir=${encodeURIComponent(outside)}`)
      const res = await tryServeStudioTrustTier(req, url, pathname)
      expect(res!.status).toBe(404)
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it('POST persists the requested tier and preserves other meta.json fields', async () => {
    fs.mkdirSync(path.join(wsDir, '.studio'), { recursive: true })
    fs.writeFileSync(path.join(wsDir, '.studio', 'meta.json'), JSON.stringify({ displayName: 'Fixture Project' }))

    const { req, url, pathname } = makeRequest(
      '/admin/api/studio/trust-tier',
      postBody({ dir: wsDir, trust: 'render-packages' }),
    )
    const res = await tryServeStudioTrustTier(req, url, pathname)
    const body = (await res!.json()) as { ok: boolean; trust: string }
    expect(body.ok).toBe(true)
    expect(body.trust).toBe('render-packages')

    const meta = readStudioMeta(wsDir)
    expect(meta.trust).toBe('render-packages')
    expect(meta.displayName).toBe('Fixture Project') // untouched by the merge

    // GET now reflects the persisted value.
    const getReq = makeRequest(`/admin/api/studio/trust-tier?dir=${encodeURIComponent(wsDir)}`)
    const getRes = await tryServeStudioTrustTier(getReq.req, getReq.url, getReq.pathname)
    expect(((await getRes!.json()) as { trust: string }).trust).toBe('render-packages')
  })

  it('POST rejects an invalid trust value', async () => {
    const { req, url, pathname } = makeRequest(
      '/admin/api/studio/trust-tier',
      postBody({ dir: wsDir, trust: 'not-a-real-tier' }),
    )
    const res = await tryServeStudioTrustTier(req, url, pathname)
    expect(res!.status).toBe(400)
  })

  it('POST rejects a dir outside studio-workspace/ without writing anything', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'trust-tier-outside-'))
    try {
      const { req, url, pathname } = makeRequest(
        '/admin/api/studio/trust-tier',
        postBody({ dir: outside, trust: 'render-packages' }),
      )
      const res = await tryServeStudioTrustTier(req, url, pathname)
      expect(res!.status).toBe(404)
      expect(fs.existsSync(path.join(outside, '.studio'))).toBe(false)
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })
})
