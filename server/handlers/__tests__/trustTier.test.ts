/**
 * trustTier — WS-3.3 coverage for `GET/POST /admin/api/studio/trust-tier`.
 * Same fixture posture as `componentBundle.test.ts`'s own route tests: a
 * temp dir created INSIDE `projectsRootDir()` so the route's own
 * `isRealpathContained(dir, projectsRootDir())` containment guard passes.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { getDevServerStatus, startDevServer, stopDevServer, type DevServerOverrides } from '../studio/devServer'
import { readStudioMeta } from '../studio/studioMeta'
import { projectsRootDir } from '../studioProjects'
import { tryServeStudioTrustTier } from '../studio/trustTier'
import { ProjectDirOutsideWorkspaceError } from '../studioProjects'
import { withOutsideWorkspaceDir } from './outsideWorkspaceDir'
import type { SpawnedProcessLike } from '../studio/subprocessRunner'

/**
 * A dev-server process that never exits on its own — the shape a real one has
 * while it is serving. `startDevServer`'s `spawn` seam takes it, so no real
 * subprocess is ever created here (same posture as `devServer.test.ts`).
 */
function fakeDevServerProcess(): { proc: SpawnedProcessLike; wasKilled: () => boolean } {
  let killed = false
  let resolveExited!: (code: number) => void
  const exited = new Promise<number>((resolve) => {
    resolveExited = resolve
  })
  const never = () => new ReadableStream<Uint8Array>({ start() {} })
  return {
    proc: {
      stdout: never(),
      stderr: never(),
      exited,
      pid: 4242,
      kill: () => {
        killed = true
        resolveExited(-1)
      },
    },
    wasKilled: () => killed,
  }
}

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

  it('GET defaults to run-project (Tier 2) when nothing is persisted', async () => {
    const { req, url, pathname } = makeRequest(`/admin/api/studio/trust-tier?dir=${encodeURIComponent(wsDir)}`)
    const res = await tryServeStudioTrustTier(req, url, pathname)
    const body = (await res!.json()) as { trust: string }
    expect(body.trust).toBe('run-project')
  })

  it('GET rejects a dir outside studio-workspace/', async () => {
    await withOutsideWorkspaceDir('trust-tier-outside', async (outside) => {
      const { req, url, pathname } = makeRequest(`/admin/api/studio/trust-tier?dir=${encodeURIComponent(outside)}`)
      await expect(tryServeStudioTrustTier(req, url, pathname)).rejects.toThrow(ProjectDirOutsideWorkspaceError)
    })
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

  /**
   * The security half of a demotion. Writing `trust: 'static'` only closes the
   * Tier-2 ROUTES; the dev server `useDevServerPrewarm` already started keeps
   * executing the user's code, and `server/liveOrigin.ts`'s unauthenticated
   * `/p/<projectKey>/` proxy keeps serving it, because that listener
   * deliberately trusts the registry rather than re-reading `.studio/meta.json`.
   * So the route has to stop the process, not just record that it should not be
   * running — otherwise the pill's "Back to static" is cosmetic.
   */
  it('POST stops a running dev server when it demotes the project below run-project', async () => {
    fs.writeFileSync(path.join(wsDir, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { dev: 'vite' } }))
    const fake = fakeDevServerProcess()
    const overrides: DevServerOverrides = { spawn: () => fake.proc }
    startDevServer(wsDir, overrides)
    expect(getDevServerStatus(wsDir).phase).not.toBe('stopped')

    const { req, url, pathname } = makeRequest('/admin/api/studio/trust-tier', postBody({ dir: wsDir, trust: 'static' }))
    const res = await tryServeStudioTrustTier(req, url, pathname)

    expect(res!.status).toBe(200)
    expect(readStudioMeta(wsDir).trust).toBe('static')
    expect(fake.wasKilled()).toBe(true)
    expect(getDevServerStatus(wsDir).phase).toBe('stopped')
  })

  it('POST leaves a running dev server alone when the write keeps the project at run-project', async () => {
    fs.writeFileSync(path.join(wsDir, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { dev: 'vite' } }))
    const fake = fakeDevServerProcess()
    startDevServer(wsDir, { spawn: () => fake.proc })

    const { req, url, pathname } = makeRequest(
      '/admin/api/studio/trust-tier',
      postBody({ dir: wsDir, trust: 'run-project' }),
    )
    await tryServeStudioTrustTier(req, url, pathname)

    expect(fake.wasKilled()).toBe(false)
    stopDevServer(wsDir)
  })

  it('POST rejects a dir outside studio-workspace/ without writing anything', async () => {
    await withOutsideWorkspaceDir('trust-tier-outside', async (outside) => {
      const { req, url, pathname } = makeRequest(
        '/admin/api/studio/trust-tier',
        postBody({ dir: outside, trust: 'render-packages' }),
      )
      await expect(tryServeStudioTrustTier(req, url, pathname)).rejects.toThrow(ProjectDirOutsideWorkspaceError)
      expect(fs.existsSync(path.join(outside, '.studio'))).toBe(false)
    })
  })
})
