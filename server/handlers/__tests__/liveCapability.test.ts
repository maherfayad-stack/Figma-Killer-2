/**
 * liveCapability + the auto-promotion gate (P8, §6 decision 2).
 *
 * The owner's override is narrow — "a Vite project with a lockfile, on first
 * open" — and every word of it is a clause the SERVER has to enforce, because
 * the client that asks for an automatic promotion is requesting a gate, not
 * passing one. These tests are the gate.
 *
 * Same fixture posture as `trustTier.test.ts`: a temp dir created INSIDE
 * `projectsRootDir()` so the route's own containment guard passes.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { resolveLiveCapability } from '../studio/liveCapability'
import { readStudioMeta } from '../studio/studioMeta'
import { projectsRootDir } from '../studioProjects'
import { tryServeStudioTrustTier } from '../studio/trustTier'

function makeRequest(pathAndQuery: string, init?: RequestInit) {
  const url = new URL(`http://localhost${pathAndQuery}`)
  return { req: new Request(url, init), url, pathname: url.pathname }
}

function postBody(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
}

async function post(body: unknown) {
  const { req, url, pathname } = makeRequest('/admin/api/studio/trust-tier', postBody(body))
  return (await tryServeStudioTrustTier(req, url, pathname))!
}

async function get(dir: string) {
  const { req, url, pathname } = makeRequest(`/admin/api/studio/trust-tier?dir=${encodeURIComponent(dir)}`)
  const res = (await tryServeStudioTrustTier(req, url, pathname))!
  return (await res.json()) as { trust: string; live: { capable: boolean; reason?: string }; autoPromoted: boolean }
}

describe('resolveLiveCapability', () => {
  let wsDir: string

  beforeEach(() => {
    const root = projectsRootDir()
    fs.mkdirSync(root, { recursive: true })
    wsDir = fs.mkdtempSync(path.join(root, '__live_capability_test_'))
    fs.writeFileSync(path.join(wsDir, 'package.json'), JSON.stringify({ name: 'fixture', dependencies: { react: '19.0.0' } }))
  })

  afterEach(() => {
    fs.rmSync(wsDir, { recursive: true, force: true })
  })

  function makeVite(): void {
    fs.writeFileSync(path.join(wsDir, 'vite.config.js'), 'export default {}\n')
    fs.mkdirSync(path.join(wsDir, 'src'), { recursive: true })
    fs.writeFileSync(path.join(wsDir, 'src', 'main.jsx'), 'export {}\n')
  }

  function makeLockfile(name = 'bun.lock'): void {
    fs.writeFileSync(path.join(wsDir, name), '')
  }

  it('refuses a project with no Vite config — "Live needs Vite", not a button that would fail', () => {
    makeLockfile()
    expect(resolveLiveCapability(wsDir)).toEqual({ capable: false, reason: 'not-vite' })
  })

  it('refuses a Vite project that has never been installed', () => {
    makeVite()
    expect(resolveLiveCapability(wsDir)).toEqual({ capable: false, reason: 'no-lockfile' })
  })

  it('accepts a Vite project with a lockfile, from any package manager', () => {
    makeVite()
    for (const lockfile of ['bun.lock', 'bun.lockb', 'pnpm-lock.yaml', 'yarn.lock', 'package-lock.json']) {
      fs.rmSync(path.join(wsDir, 'bun.lock'), { force: true })
      fs.rmSync(path.join(wsDir, 'bun.lockb'), { force: true })
      fs.rmSync(path.join(wsDir, 'pnpm-lock.yaml'), { force: true })
      fs.rmSync(path.join(wsDir, 'yarn.lock'), { force: true })
      fs.rmSync(path.join(wsDir, 'package-lock.json'), { force: true })
      makeLockfile(lockfile)
      expect(resolveLiveCapability(wsDir)).toEqual({ capable: true })
    }
  })

  it('GET reports the capability alongside the tier, so the pill never has to guess', async () => {
    makeVite()
    makeLockfile()
    const body = await get(wsDir)
    expect(body.trust).toBe('static')
    expect(body.live).toEqual({ capable: true })
    expect(body.autoPromoted).toBe(false)
  })
})

describe('trust-tier — the automatic Tier 2 promotion gate', () => {
  let wsDir: string

  beforeEach(() => {
    const root = projectsRootDir()
    fs.mkdirSync(root, { recursive: true })
    wsDir = fs.mkdtempSync(path.join(root, '__auto_promote_test_'))
    fs.writeFileSync(path.join(wsDir, 'package.json'), JSON.stringify({ name: 'fixture' }))
  })

  afterEach(() => {
    fs.rmSync(wsDir, { recursive: true, force: true })
  })

  function makeEligible(): void {
    fs.writeFileSync(path.join(wsDir, 'vite.config.js'), 'export default {}\n')
    fs.mkdirSync(path.join(wsDir, 'src'), { recursive: true })
    fs.writeFileSync(path.join(wsDir, 'src', 'main.jsx'), 'export {}\n')
    fs.writeFileSync(path.join(wsDir, 'bun.lock'), '')
  }

  it('promotes an eligible project once, and records the origin and the latch', async () => {
    makeEligible()
    const res = await post({ dir: wsDir, trust: 'run-project', autoPromoted: true })
    expect(res.status).toBe(200)

    const meta = readStudioMeta(wsDir)
    expect(meta.trust).toBe('run-project')
    expect(meta.trustAutoPromoted).toBe(true)
    expect(typeof meta.trustAutoPromotedAt).toBe('number')
    expect((await get(wsDir)).autoPromoted).toBe(true)
  })

  it('refuses a second automatic promotion — the Undo must not be a no-op with extra steps', async () => {
    makeEligible()
    expect((await post({ dir: wsDir, trust: 'run-project', autoPromoted: true })).status).toBe(200)

    // The owner clicks Undo: an EXPLICIT write, which leaves the latch alone.
    expect((await post({ dir: wsDir, trust: 'static' })).status).toBe(200)
    expect(readStudioMeta(wsDir).trustAutoPromotedAt).toBeDefined()

    const second = await post({ dir: wsDir, trust: 'run-project', autoPromoted: true })
    expect(second.status).toBe(409)
    expect(readStudioMeta(wsDir).trust).toBe('static')
  })

  it('refuses a non-Vite project outright — the override never covered it', async () => {
    fs.writeFileSync(path.join(wsDir, 'bun.lock'), '')
    const res = await post({ dir: wsDir, trust: 'run-project', autoPromoted: true })
    expect(res.status).toBe(409)
    expect(readStudioMeta(wsDir).trust).toBeUndefined()
  })

  it('refuses a Vite project with no lockfile', async () => {
    fs.writeFileSync(path.join(wsDir, 'vite.config.js'), 'export default {}\n')
    fs.mkdirSync(path.join(wsDir, 'src'), { recursive: true })
    fs.writeFileSync(path.join(wsDir, 'src', 'main.jsx'), 'export {}\n')
    const res = await post({ dir: wsDir, trust: 'run-project', autoPromoted: true })
    expect(res.status).toBe(409)
    expect(readStudioMeta(wsDir).trust).toBeUndefined()
  })

  it('refuses to auto-promote to any tier other than run-project', async () => {
    makeEligible()
    const res = await post({ dir: wsDir, trust: 'render-packages', autoPromoted: true })
    expect(res.status).toBe(409)
    expect(readStudioMeta(wsDir).trust).toBeUndefined()
  })

  it('leaves the auto-promotion fields untouched for an explicit click, so the two origins stay distinguishable', async () => {
    makeEligible()
    expect((await post({ dir: wsDir, trust: 'run-project' })).status).toBe(200)

    const meta = readStudioMeta(wsDir)
    expect(meta.trust).toBe('run-project')
    expect(meta.trustAutoPromoted).toBeUndefined()
    expect(meta.trustAutoPromotedAt).toBeUndefined()
    // …and because the latch was never set, the automatic path is still open.
    expect((await get(wsDir)).autoPromoted).toBe(false)
  })
})
