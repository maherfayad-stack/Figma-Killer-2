/**
 * asset-drop-url — P5-B3 (IMG-5, OD-13): an image dragged out of another tab,
 * fetched by the SERVER and landed exactly where a dropped file lands.
 *
 * The route is SSRF-sensitive (it turns a one-gesture browser action into an
 * outbound request from the server), so most of this file is the refusals —
 * each asserts that NOTHING was written, not only that the status is an error:
 *
 *  - a private, loopback or metadata address — loopback even when the
 *    operator's loopback escape hatch is set, which this route never honours;
 *  - a redirect (never followed);
 *  - a non-http(s) scheme (`file:`, `javascript:`, `data:`);
 *  - a body over the drop's 25 MB cap;
 *  - a response that is not an image, by header and by bytes;
 *  - a forged cross-origin POST, and an anonymous one, at the GATE.
 *
 * DNS and the transport are stubbed through the route's own seam, so no test
 * ever resolves or connects to anything.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { MAX_ASSET_DROP_BYTES } from '../studio/assetDrop'
import { tryServeStudioAssetDropUrl, type AssetDropUrlDeps } from '../studio/assetDropUrl'
import { createStudioRouteTestHarness, type StudioRouteTestHarness } from './helpers/studioRouteHarness'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-asset-drop-url-'))
  write('package.json', JSON.stringify({ name: 'app', devDependencies: { vite: '^5.0.0' } }))
  write('vite.config.ts', 'export default {}\n')
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const PUBLIC_IP = '93.184.216.34'

function write(rel: string, contents: string): void {
  const full = path.join(tmpDir, ...rel.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents, 'utf8')
}

/** Every file under the project's `public/` and `src/assets/` — what a refusal must leave empty. */
function landedFiles(): string[] {
  const out: string[] = []
  for (const rel of ['public', 'src/assets']) {
    const full = path.join(tmpDir, rel)
    if (fs.existsSync(full)) for (const name of fs.readdirSync(full)) out.push(`${rel}/${name}`)
  }
  return out
}

interface Stub {
  fetched: string[]
  deps: AssetDropUrlDeps
}

function stub(options: { addresses?: string[]; respond?: (url: string) => Response | Promise<Response> } = {}): Stub {
  const fetched: string[] = []
  return {
    fetched,
    deps: {
      resolveDir: () => tmpDir,
      fetch: {
        resolveHostAddresses: async () => options.addresses ?? [PUBLIC_IP],
        fetchImpl: (async (input: RequestInfo | URL) => {
          const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
          fetched.push(url)
          return options.respond ? options.respond(url) : new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'image/png' } })
        }) as typeof fetch,
      },
    },
  }
}

function urlRequest(body: unknown): Request {
  return new Request('http://localhost/admin/api/studio/asset-drop-url', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function serve(body: unknown, s: Stub): Promise<Response> {
  const req = urlRequest(body)
  const res = await tryServeStudioAssetDropUrl(req, new URL(req.url), '/admin/api/studio/asset-drop-url', s.deps)
  if (!res) throw new Error('the route did not answer')
  return res
}

describe('asset-drop-url — the happy path', () => {
  it('fetches the image server-side and lands it in public/ with the literal src a drop gets', async () => {
    const s = stub()
    const res = await serve({ url: 'https://images.example.com/photos/hero.png' }, s)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      ok: true,
      mode: 'public',
      src: '/hero.png',
      relPath: 'public/hero.png',
      width: null,
      height: null,
      deduped: false,
    })
    expect(fs.readFileSync(path.join(tmpDir, 'public', 'hero.png'))).toEqual(Buffer.from(PNG_BYTES))
    // Pinned to the validated address, never the hostname.
    expect(s.fetched).toHaveLength(1)
    expect(s.fetched[0]).toContain(PUBLIC_IP)
  })

  it('follows the page convention: a page that imports its images gets the file beside them (IMG-10)', async () => {
    write('src/assets/logo.png', 'x')
    write('src/pages/Home.tsx', [
      "import logo from '../assets/logo.png'",
      "import badge from '../assets/badge.png'",
      'export default function Home() { return <main><img src={logo} /><img src={badge} /></main> }',
      '',
    ].join('\n'))
    const res = await serve({ url: 'https://images.example.com/hero.png', pageRel: 'src/pages/Home.tsx' }, stub())
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.mode).toBe('import')
    expect(body.relPath).toBe('src/assets/hero.png')
    expect(body).not.toHaveProperty('src')
  })
})

describe('asset-drop-url — SSRF refusals write nothing', () => {
  const blocked: [string, string][] = [
    ['a private RFC1918 address', '10.0.0.7'],
    ['loopback', '127.0.0.1'],
    ['IPv6 loopback', '::1'],
    ['cloud metadata (link-local)', '169.254.169.254'],
  ]
  for (const [label, address] of blocked) {
    it(`refuses a host that resolves to ${label}, before connecting`, async () => {
      const s = stub({ addresses: [address] })
      const res = await serve({ url: 'https://looks-public.example.com/cat.png' }, s)
      expect(res.status).toBe(422)
      expect(s.fetched).toEqual([])
      expect(landedFiles()).toEqual([])
      // The resolved address is never echoed back.
      expect(((await res.json()) as { error: string }).error).not.toContain(address)
    })
  }

  it('refuses loopback even when the operator enabled loopback asset fetches', async () => {
    const previous = process.env.STUDIO_ALLOW_LOOPBACK_ASSET_FETCH
    process.env.STUDIO_ALLOW_LOOPBACK_ASSET_FETCH = '1'
    try {
      const s = stub({ addresses: ['127.0.0.1'] })
      const res = await serve({ url: 'http://localhost:3845/assets/icon.png' }, s)
      expect(res.status).toBe(422)
      expect(s.fetched).toEqual([])
      expect(landedFiles()).toEqual([])
    } finally {
      if (previous === undefined) delete process.env.STUDIO_ALLOW_LOOPBACK_ASSET_FETCH
      else process.env.STUDIO_ALLOW_LOOPBACK_ASSET_FETCH = previous
    }
  })

  it('refuses a literal private IP in the URL itself', async () => {
    const s = stub()
    const res = await serve({ url: 'http://192.168.1.1/router.png' }, s)
    expect(res.status).toBe(422)
    expect(s.fetched).toEqual([])
    expect(landedFiles()).toEqual([])
  })

  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:image/png;base64,iVBORw0KGgo=', 'ftp://example.com/a.png']) {
    it(`refuses the scheme of ${url.slice(0, url.indexOf(':') + 1)} without a request`, async () => {
      const s = stub()
      const res = await serve({ url }, s)
      expect(res.status).toBe(422)
      expect(s.fetched).toEqual([])
      expect(landedFiles()).toEqual([])
    })
  }

  it('never follows a redirect', async () => {
    // `redirect: 'error'` makes the platform fetch REJECT on a 3xx; the stub
    // does what the platform does, and asserts it was asked to.
    let redirectMode: RequestRedirect | undefined
    const s = stub()
    s.deps.fetch!.fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      redirectMode = init?.redirect
      throw new TypeError('unexpected redirect')
    }) as typeof fetch
    const res = await serve({ url: 'https://images.example.com/moved.png' }, s)
    expect(redirectMode).toBe('error')
    expect(res.status).toBe(422)
    expect(landedFiles()).toEqual([])
  })
})

describe('asset-drop-url — size and type refusals write nothing', () => {
  it('refuses a body over the drop cap by streamed count', async () => {
    const huge = new Uint8Array(MAX_ASSET_DROP_BYTES + 1)
    huge.set(PNG_BYTES)
    // No content-length: the cap has to be enforced by counting, not by trust.
    const s = stub({ respond: () => new Response(new Blob([huge]).stream(), { status: 200, headers: { 'content-type': 'image/png' } }) })
    const res = await serve({ url: 'https://images.example.com/huge.png' }, s)
    expect(res.status).toBe(422)
    expect(landedFiles()).toEqual([])
  })

  it('refuses a page served as text/html before reading it', async () => {
    const s = stub({ respond: () => new Response('<html>not an image</html>', { status: 200, headers: { 'content-type': 'text/html' } }) })
    const res = await serve({ url: 'https://example.com/gallery.png' }, s)
    expect(res.status).toBe(422)
    expect(landedFiles()).toEqual([])
  })

  it('refuses bytes that are not the image they claim to be', async () => {
    const s = stub({ respond: () => new Response('%PDF-1.7', { status: 200, headers: { 'content-type': 'image/png' } }) })
    const res = await serve({ url: 'https://example.com/fake.png' }, s)
    expect(res.status).toBe(422)
    expect(landedFiles()).toEqual([])
  })

  it('refuses a malformed body', async () => {
    const res = await serve({ url: 42 }, stub())
    expect(res.status).toBe(400)
  })
})

describe('asset-drop-url — authorization (the gate)', () => {
  let routes: StudioRouteTestHarness

  beforeAll(async () => {
    routes = await createStudioRouteTestHarness()
  })

  afterAll(async () => {
    await routes.cleanup()
  })

  it('refuses a forged cross-origin POST before anything is fetched', async () => {
    const req = urlRequest({ url: 'https://images.example.com/hero.png', dir: tmpDir })
    req.headers.set('origin', 'https://evil.test')
    const res = await routes.serve(req, new URL(req.url))
    expect(res!.status).toBe(403)
    expect(landedFiles()).toEqual([])
  })

  it('refuses an anonymous POST', async () => {
    const req = urlRequest({ url: 'https://images.example.com/hero.png', dir: tmpDir })
    const res = await routes.serveAnonymous(req, new URL(req.url))
    expect(res!.status).toBe(401)
    expect(landedFiles()).toEqual([])
  })
})
