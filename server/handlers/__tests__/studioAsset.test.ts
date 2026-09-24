/**
 * `GET /admin/api/studio/asset?dir=<project>&path=<workspace-rel>` (§5.3) —
 * serves one workspace-relative asset file (an imported page's local images,
 * §5) through the existing static-file pipeline.
 *
 * `path` is attacker-controlled (straight off the query string), so most of
 * this file is adversarial: every traversal shape the plan calls out
 * (`..` on both separators, an encoded `..`, a decoy segment that merely
 * *looks* suspicious, an absolute POSIX/Windows/UNC path, `node_modules/…`,
 * and — where the host permits creating one — a symlink escape) must be
 * rejected with a 404, never leak the target file's bytes.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createStudioRouteTestHarness, type StudioRouteTestHarness } from './helpers/studioRouteHarness'
import { INERT_FILE_CSP } from '../../static'
import { applySecurityHeaders } from '../../securityHeaders'

/**
 * Every Studio route is capability-gated at dispatch, so these tests drive the
 * surface as the signed-in Owner. See `helpers/studioRouteHarness.ts`.
 */
let studioRoutes: StudioRouteTestHarness

beforeAll(async () => {
  studioRoutes = await createStudioRouteTestHarness()
})

afterAll(async () => {
  await studioRoutes.cleanup()
})

/** `tryServeStudio` with the Owner's session cookie attached. */
function serveStudio(req: Request, url: URL): Promise<Response | null> {
  return studioRoutes.serve(req, url)
}


let tmpDir: string
/** A sibling directory OUTSIDE tmpDir — the traversal target. */
let outsideDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-asset-'))
  outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-asset-outside-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  fs.rmSync(outsideDir, { recursive: true, force: true })
})

function write(dir: string, relPath: string, contents: string | Buffer): string {
  const full = path.join(dir, ...relPath.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents)
  return full
}

async function requestAsset(dir: string, rawPathQuery: string): Promise<Response> {
  const url = new URL(
    `http://localhost/admin/api/studio/asset?dir=${encodeURIComponent(dir)}&${rawPathQuery}`,
  )
  const req = new Request(url)
  const res = await serveStudio(req, url)
  expect(res).not.toBeNull()
  return res!
}

describe('GET /admin/api/studio/asset — a project file never acts as a document on the admin origin (review of #248, F1)', () => {
  const SCRIPTED_SVG = '<svg xmlns="http://www.w3.org/2000/svg"><x:script xmlns:x="http://www.w3.org/2000/svg">alert(1)</x:script></svg>'

  it('serves a project SVG with the inert CSP and nosniff', async () => {
    write(tmpDir, 'src/assets/logo.svg', SCRIPTED_SVG)
    const res = await requestAsset(tmpDir, `path=${encodeURIComponent('src/assets/logo.svg')}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-security-policy')).toBe(INERT_FILE_CSP)
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('the admin security layer keeps that policy and appends its own, never replacing it', async () => {
    write(tmpDir, 'page.html', '<script>alert(1)</script>')
    const res = applySecurityHeaders(await requestAsset(tmpDir, 'path=page.html'), '/admin/api/studio/asset')
    const csp = res.headers.get('content-security-policy') ?? ''
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain('sandbox')
    expect(csp).toContain("frame-ancestors 'none'")
  })
})

describe('GET /admin/api/studio/asset', () => {
  it('serves a real fixture file with the right bytes and content-type', async () => {
    write(tmpDir, 'assets/logo.png', 'not-really-png-bytes')

    const res = await requestAsset(tmpDir, `path=${encodeURIComponent('assets/logo.png')}`)

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('image/png')
    expect(await res.text()).toBe('not-really-png-bytes')
  })

  it('serves a nested asset path', async () => {
    write(tmpDir, 'assets/esim-flow/figma/esim-chip.png', 'chip-bytes')

    const res = await requestAsset(tmpDir, `path=${encodeURIComponent('assets/esim-flow/figma/esim-chip.png')}`)

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('chip-bytes')
  })

  it('404s a missing file', async () => {
    const res = await requestAsset(tmpDir, `path=${encodeURIComponent('assets/missing.png')}`)
    expect(res.status).toBe(404)
  })

  it('404s when no path query param is given', async () => {
    const url = new URL(`http://localhost/admin/api/studio/asset?dir=${encodeURIComponent(tmpDir)}`)
    const req = new Request(url)
    const res = await serveStudio(req, url)
    expect(res!.status).toBe(404)
  })

  it('rejects a `..` traversal (POSIX separators) that escapes the project dir', async () => {
    write(outsideDir, 'secret.txt', 'top secret')

    const res = await requestAsset(tmpDir, `path=${encodeURIComponent('../' + path.basename(outsideDir) + '/secret.txt')}`)

    expect(res.status).toBe(404)
  })

  it('rejects a `..` traversal using BACKSLASH separators (Windows-shaped)', async () => {
    write(outsideDir, 'secret.txt', 'top secret')

    const traversal = `..\\${path.basename(outsideDir)}\\secret.txt`
    const res = await requestAsset(tmpDir, `path=${encodeURIComponent(traversal)}`)

    expect(res.status).toBe(404)
  })

  it('rejects an encoded `..` (`..%2f`) traversal', async () => {
    write(outsideDir, 'secret.txt', 'top secret')

    // Construct the query string by hand so `%2f` reaches the server still
    // encoded — URLSearchParams.get() decodes it to a literal "/" for us,
    // exactly like a real `..%2f` attack payload would after one decode.
    const encodedTraversal = `..%2f${encodeURIComponent(path.basename(outsideDir))}%2fsecret.txt`
    const res = await requestAsset(tmpDir, `path=${encodedTraversal}`)

    expect(res.status).toBe(404)
  })

  it('does not let a decoy segment ("....") bypass containment (it just 404s, not a traversal)', async () => {
    const res = await requestAsset(tmpDir, `path=${encodeURIComponent('..../..../etc/passwd')}`)
    expect(res.status).toBe(404)
  })

  it('rejects an absolute POSIX path', async () => {
    write(outsideDir, 'secret.txt', 'top secret')
    const absolute = path.join(outsideDir, 'secret.txt').split(path.sep).join('/')
    const res = await requestAsset(tmpDir, `path=${encodeURIComponent('/' + absolute.replace(/^[A-Za-z]:/, ''))}`)
    expect(res.status).toBe(404)
  })

  it('rejects an absolute Windows drive path', async () => {
    const res = await requestAsset(tmpDir, `path=${encodeURIComponent('C:\\Windows\\win.ini')}`)
    expect(res.status).toBe(404)
  })

  it('rejects a UNC path', async () => {
    const res = await requestAsset(tmpDir, `path=${encodeURIComponent('\\\\attacker-host\\share\\file.png')}`)
    expect(res.status).toBe(404)
  })

  it('rejects a path with a node_modules segment even when the file really exists', async () => {
    write(tmpDir, 'node_modules/some-pkg/asset.png', 'pkg-bytes')

    const res = await requestAsset(tmpDir, `path=${encodeURIComponent('node_modules/some-pkg/asset.png')}`)

    expect(res.status).toBe(404)
  })

  it('rejects a path with a .git segment', async () => {
    write(tmpDir, '.git/hooks/asset.png', 'git-bytes')

    const res = await requestAsset(tmpDir, `path=${encodeURIComponent('.git/hooks/asset.png')}`)

    expect(res.status).toBe(404)
  })

  it('rejects a symlink inside the project dir that escapes to a file outside it, when the host permits creating one', async () => {
    const secretFile = write(outsideDir, 'secret.png', 'top secret bytes')
    const linkPath = path.join(tmpDir, 'escape.png')

    try {
      fs.symlinkSync(secretFile, linkPath, 'file')
    } catch {
      // Some hosts (notably Windows without Developer Mode / elevation)
      // refuse to create symlinks at all — nothing to test there, the
      // vector simply doesn't exist on that host.
      return
    }

    const res = await requestAsset(tmpDir, `path=${encodeURIComponent('escape.png')}`)
    expect(res.status).toBe(404)
  })
})
