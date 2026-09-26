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
    write(tmpDir, 'logo.svg', SCRIPTED_SVG)
    const res = applySecurityHeaders(await requestAsset(tmpDir, 'path=logo.svg'), '/admin/api/studio/asset')
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

/**
 * P5-B2 — the MIME gate. The route exists for files a page EMBEDS; it is not
 * a way to read a project's source, config or HTML on the admin origin.
 */
describe('GET /admin/api/studio/asset — images, fonts and media only', () => {
  it('refuses source, config and HTML even when the file exists', async () => {
    write(tmpDir, 'package.json', '{"name":"x"}')
    write(tmpDir, 'src/App.tsx', 'export default 1')
    write(tmpDir, 'index.html', '<script>alert(1)</script>')
    write(tmpDir, 'public/data.json', '{}')
    for (const query of ['path=package.json', 'path=src%2FApp.tsx', 'path=index.html', 'url=%2Fdata.json', 'url=%2Findex.html']) {
      expect((await requestAsset(tmpDir, query)).status).toBe(404)
    }
  })

  it('serves a font and a video with their media types', async () => {
    write(tmpDir, 'public/fonts/a.woff2', 'font-bytes')
    write(tmpDir, 'public/clip.mp4', 'video-bytes')
    const font = await requestAsset(tmpDir, 'url=%2Ffonts%2Fa.woff2')
    expect(font.status).toBe(200)
    expect(font.headers.get('content-type')).toBe('font/woff2')
    const video = await requestAsset(tmpDir, 'url=%2Fclip.mp4')
    expect(video.status).toBe(200)
    expect(video.headers.get('content-type')).toBe('video/mp4')
  })

  it('refuses a link named like an image that resolves to source, when the host permits creating one', async () => {
    write(tmpDir, 'src/secret.ts', 'export const key = "k"')
    fs.mkdirSync(path.join(tmpDir, 'public'), { recursive: true })
    try {
      fs.symlinkSync(path.join(tmpDir, 'src', 'secret.ts'), path.join(tmpDir, 'public', 'logo.png'), 'file')
    } catch {
      return // no file symlinks on this host (Windows without Developer Mode)
    }
    expect((await requestAsset(tmpDir, 'url=%2Flogo.png')).status).toBe(404)
    expect((await requestAsset(tmpDir, `path=${encodeURIComponent('public/logo.png')}`)).status).toBe(404)
  })

  it('404s a request that names both a path and a url, or an empty one', async () => {
    write(tmpDir, 'public/hero.png', 'png')
    expect((await requestAsset(tmpDir, 'path=public%2Fhero.png&url=%2Fhero.png')).status).toBe(404)
    expect((await requestAsset(tmpDir, 'url=')).status).toBe(404)
  })
})

/**
 * P5-B2 — `url=<site-root URL>`: what a design frame asks for when the page's
 * source says `<img src="/hero.png">`. The admin origin has nothing at
 * `/hero.png`; the project's `public/` does.
 */
describe('GET /admin/api/studio/asset?url= — a site-root URL, resolved like the project serves it', () => {
  it('serves public/<path> for a site-root URL, inert', async () => {
    write(tmpDir, 'public/hero.png', 'hero-bytes')
    const res = await requestAsset(tmpDir, 'url=%2Fhero.png')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('content-security-policy')).toBe(INERT_FILE_CSP)
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await res.text()).toBe('hero-bytes')
  })

  it('serves an SVG inert: the sandboxing CSP rides every response', async () => {
    write(tmpDir, 'public/icon.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
    const res = await requestAsset(tmpDir, 'url=%2Ficon.svg')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/svg+xml')
    expect(res.headers.get('content-security-policy')).toBe(INERT_FILE_CSP)
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('decodes the percent-encoding the site-URL rule writes', async () => {
    write(tmpDir, 'public/my photo (1).png', 'spaced')
    const res = await requestAsset(tmpDir, `url=${encodeURIComponent('/my%20photo%20%281%29.png')}`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('spaced')
  })

  it('prefers public/ over the source tree, then falls back to the dev-only source path', async () => {
    write(tmpDir, 'public/a.png', 'from-public')
    write(tmpDir, 'a.png', 'from-root')
    write(tmpDir, 'src/assets/b.png', 'from-src')
    expect(await (await requestAsset(tmpDir, 'url=%2Fa.png')).text()).toBe('from-public')
    expect(await (await requestAsset(tmpDir, 'url=%2Fsrc%2Fassets%2Fb.png')).text()).toBe('from-src')
  })

  it('does not serve /public/<path>: no framework serves the directory under its own name', async () => {
    write(tmpDir, 'public/hero.png', 'hero-bytes')
    expect((await requestAsset(tmpDir, 'url=%2Fpublic%2Fhero.png')).status).toBe(404)
  })

  it('ignores a cache-busting query on the URL', async () => {
    write(tmpDir, 'public/hero.png', 'hero-bytes')
    expect((await requestAsset(tmpDir, `url=${encodeURIComponent('/hero.png?v=3')}`)).status).toBe(200)
  })

  it('404s a missing file', async () => {
    expect((await requestAsset(tmpDir, 'url=%2Fnope.png')).status).toBe(404)
  })

  it('refuses every traversal spelling out of the project', async () => {
    write(outsideDir, 'secret.png', 'top secret')
    const out = path.basename(outsideDir)
    const spellings = [
      `/../${out}/secret.png`,
      `/../../${out}/secret.png`,
      `/%2E%2E/${out}/secret.png`,
      `/..%2F${out}%2Fsecret.png`,
      `/..%5C${out}%5Csecret.png`,
      `/..\\${out}\\secret.png`,
    ]
    for (const spelling of spellings) {
      // Encoded once more for the query string, so the server's single
      // `searchParams` decode hands the route exactly `spelling`.
      const res = await requestAsset(tmpDir, `url=${encodeURIComponent(spelling)}`)
      expect(res.status).toBe(404)
      expect(await res.text()).not.toContain('top secret')
    }
  })

  it('refuses absolute, drive, UNC and protocol-relative forms', async () => {
    const spellings = ['//evil.example/x.png', '/\\\\evil.example\\x.png', '/C:%5CWindows%5Cwin.ini', '/C:/Windows/win.ini', 'https://evil.example/x.png', 'hero.png']
    for (const spelling of spellings) {
      expect((await requestAsset(tmpDir, `url=${encodeURIComponent(spelling)}`)).status).toBe(404)
    }
  })

  it('refuses an excluded directory, in any case, even when the file exists', async () => {
    write(tmpDir, 'node_modules/pkg/logo.png', 'pkg')
    write(tmpDir, '.git/logo.png', 'git')
    write(tmpDir, 'public/node_modules/logo.png', 'pkg-in-public')
    const spellings = ['/node_modules/pkg/logo.png', '/.git/logo.png', '/node_modules/logo.png']
    if (process.platform === 'win32' || process.platform === 'darwin') {
      spellings.push('/NODE_MODULES/pkg/logo.png', '/.GIT/logo.png', '/.git./logo.png')
    }
    for (const spelling of spellings) {
      expect((await requestAsset(tmpDir, `url=${encodeURIComponent(spelling)}`)).status).toBe(404)
    }
  })

  it('refuses a directory link inside public/ that leads out of the project', async () => {
    write(outsideDir, 'secret.png', 'top secret')
    fs.mkdirSync(path.join(tmpDir, 'public'), { recursive: true })
    try {
      fs.symlinkSync(outsideDir, path.join(tmpDir, 'public', 'pics'), 'junction')
    } catch {
      return
    }
    const res = await requestAsset(tmpDir, 'url=%2Fpics%2Fsecret.png')
    expect(res.status).toBe(404)
    expect(await res.text()).not.toContain('top secret')
  })

  it('refuses a directory link named like source that lands in .git', async () => {
    write(tmpDir, '.git/logo.png', 'git')
    fs.mkdirSync(path.join(tmpDir, 'public'), { recursive: true })
    try {
      fs.symlinkSync(path.join(tmpDir, '.git'), path.join(tmpDir, 'public', 'pics'), 'junction')
    } catch {
      return
    }
    expect((await requestAsset(tmpDir, 'url=%2Fpics%2Flogo.png')).status).toBe(404)
  })
})
