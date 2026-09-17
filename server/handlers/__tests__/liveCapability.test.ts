/**
 * liveCapability — can this project's real app be run, and if not, in which of
 * two words (P8).
 *
 * The `Static · Live` pill renders this answer verbatim, so a wrong one is a
 * button that fails or a capability silently hidden. Same fixture posture as
 * `trustTier.test.ts`: a temp dir created INSIDE `projectsRootDir()` so the
 * route's own containment guard passes.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { resolveLiveCapability } from '../studio/liveCapability'
import { projectsRootDir } from '../studioProjects'
import { tryServeStudioTrustTier } from '../studio/trustTier'

function makeRequest(pathAndQuery: string) {
  const url = new URL(`http://localhost${pathAndQuery}`)
  return { req: new Request(url), url, pathname: url.pathname }
}

async function get(dir: string) {
  const { req, url, pathname } = makeRequest(`/admin/api/studio/trust-tier?dir=${encodeURIComponent(dir)}`)
  const res = (await tryServeStudioTrustTier(req, url, pathname))!
  return (await res.json()) as { trust: string; live: { capable: boolean; reason?: string } }
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
  })
})
