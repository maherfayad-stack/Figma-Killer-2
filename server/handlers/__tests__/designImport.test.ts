/**
 * POST /admin/api/design-import/{preview,copy-css} — route wiring over
 * `githubSource.ts`/`npmSource.ts`/`parseCssTokens.ts`. The fetch itself is
 * unit-tested in `designImport/__tests__/`; this only exercises the HTTP
 * layer (body validation, response shape, error mapping), same split as
 * `studio.test.ts`'s "route wiring" describe blocks.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { tryServeDesignImport } from '../designImport'
import {
  createCapabilityTestHarness,
  type CapabilityTestHarness,
} from '../../../src/__tests__/helpers/capabilityHarness'
import { syncSystemRoles } from '../../repositories/roles'

/**
 * `sec-16` gated this namespace on `studio.write` + an acceptable `Origin`.
 * Every request below therefore carries a real Owner session, the way the
 * editor's own does — a bare `Request` now gets a 401 and proves nothing
 * about the route.
 */
let harness: CapabilityTestHarness
let ownerCookie: string
/** A real signed-in session that holds nothing this namespace accepts. */
let powerlessCookie: string

beforeAll(async () => {
  harness = await createCapabilityTestHarness()
  // `server/index.ts` runs this after the migrations on every boot; the test
  // DB stops at the migrations' seed, whose role rows are a snapshot of the
  // capability list as it stood when that migration was written.
  await syncSystemRoles(harness.db)
  ownerCookie = await harness.setupOwner()
  const powerless = await harness.createRoleUser({
    name: 'Design Import Nobody',
    slug: 'design-import-nobody',
    capabilities: ['dashboard.read'],
  })
  powerlessCookie = powerless.cookie
})

afterAll(async () => {
  await harness.cleanup()
})

/** Drive one request, with whatever cookie/headers the caller wants. */
async function serve(
  path: string,
  init: { method?: string; body?: unknown; cookie?: string; origin?: string } = {},
): Promise<Response> {
  const url = new URL(`http://localhost${path}`)
  const req = new Request(url, {
    method: init.method ?? 'POST',
    headers: { 'content-type': 'application/json' },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  })
  // `Origin` and `Cookie` are forbidden header names in the Request
  // constructor — they must be set on the Headers object afterwards.
  if (init.cookie) req.headers.set('cookie', init.cookie)
  if (init.origin) req.headers.set('origin', init.origin)
  const res = await tryServeDesignImport(req, { db: harness.db }, url, url.pathname)
  expect(res).not.toBeNull()
  return res!
}

function buildFakeZipball(files: Record<string, string>): Uint8Array {
  const input: Record<string, Uint8Array> = {}
  for (const [relPath, contents] of Object.entries(files)) {
    input[`acme-widgets-abcdef1/${relPath}`] = strToU8(contents)
  }
  return zipSync(input)
}

describe('POST /admin/api/design-import/preview', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  async function post(body: unknown): Promise<Response> {
    return await serve('/admin/api/design-import/preview', { body, cookie: ownerCookie })
  }

  it('previews a GitHub source end to end, returning classified candidates', async () => {
    const zip = buildFakeZipball({ 'tokens.css': ':root { --brand-500: #4f46e5; --space-md: 1rem; }' })
    globalThis.fetch = (async () =>
      new Response(zip, { status: 200, headers: { 'content-length': String(zip.byteLength) } })) as typeof fetch

    const res = await post({ source: 'github', url: 'https://github.com/acme/widgets' })

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      label: string
      colors: Array<{ name: string }>
      spacing: Array<{ name: string }>
    }
    expect(body.label).toBe('acme/widgets')
    expect(body.colors.map((c) => c.name)).toEqual(['brand-500'])
    expect(body.spacing.map((c) => c.name)).toEqual(['space-md'])
  })

  it('combines CSS + a token-named JSON file into one candidate set, and excludes the JSON from the returned files', async () => {
    const zip = buildFakeZipball({
      'tokens.css': ':root { --brand-500: #4f46e5; }',
      'design-tokens.json': JSON.stringify({ 'space-md': '1rem' }),
    })
    globalThis.fetch = (async () =>
      new Response(zip, { status: 200, headers: { 'content-length': String(zip.byteLength) } })) as typeof fetch

    const res = await post({ source: 'github', url: 'https://github.com/acme/widgets' })
    const body = (await res.json()) as {
      files: Array<{ relPath: string }>
      colors: Array<{ name: string }>
      spacing: Array<{ name: string }>
    }

    expect(body.colors.map((c) => c.name)).toEqual(['brand-500'])
    expect(body.spacing.map((c) => c.name)).toEqual(['space-md'])
    // Only the CSS file is offered back for the later copy-css step.
    expect(body.files.map((f) => f.relPath)).toEqual(['tokens.css'])
  })

  it('maps a bad GitHub URL to a 400 with an error message', async () => {
    const res = await post({ source: 'github', url: 'not-a-url' })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error.length).toBeGreaterThan(0)
  })

  it('returns 400 for an invalid body shape (missing discriminant)', async () => {
    const res = await post({ url: 'https://github.com/acme/widgets' })
    expect(res.status).toBe(400)
  })

  it('rejects a GET request with a 404 rather than falling through to the admin SPA', async () => {
    const res = await serve('/admin/api/design-import/preview', { method: 'GET', cookie: ownerCookie })
    expect(res.status).toBe(404)
  })
})

describe('POST /admin/api/design-import/copy-css', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-import-copy-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  async function post(body: unknown): Promise<Response> {
    return await serve('/admin/api/design-import/copy-css', { body, cookie: ownerCookie })
  }

  it('writes the given files under styles/imported/<sourceSlug>/', async () => {
    const res = await post({
      dir: tmpDir,
      sourceSlug: 'acme/widgets',
      files: [
        { relPath: 'tokens.css', contents: ':root { --brand: #4f46e5; }' },
        { relPath: 'nested/reset.css', contents: '* { margin: 0; }' },
      ],
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; dir: string; written: number; skipped: number }
    expect(body).toMatchObject({ ok: true, written: 2, skipped: 0 })

    const destRoot = path.join(tmpDir, 'styles', 'imported', 'acme-widgets')
    expect(fs.readFileSync(path.join(destRoot, 'tokens.css'), 'utf8')).toContain('--brand')
    expect(fs.readFileSync(path.join(destRoot, 'nested', 'reset.css'), 'utf8')).toContain('margin: 0')
  })

  it('skips a path-traversal attempt and a non-.css file, without writing them', async () => {
    const res = await post({
      dir: tmpDir,
      sourceSlug: 'evil',
      files: [
        { relPath: '../../escape.css', contents: 'malicious' },
        { relPath: 'script.js', contents: 'alert(1)' },
        { relPath: 'ok.css', contents: '.ok {}' },
      ],
    })

    const body = (await res.json()) as { written: number; skipped: number }
    expect(body).toMatchObject({ written: 1, skipped: 2 })
    expect(fs.existsSync(path.join(tmpDir, 'escape.css'))).toBe(false)
    expect(fs.existsSync(path.join(tmpDir, 'styles', 'imported', 'evil', 'script.js'))).toBe(false)
    expect(fs.existsSync(path.join(tmpDir, 'styles', 'imported', 'evil', 'ok.css'))).toBe(true)
  })

  it('slugifies an unsafe sourceSlug rather than using it as a literal path', async () => {
    const res = await post({
      dir: tmpDir,
      sourceSlug: '../../evil',
      files: [{ relPath: 'x.css', contents: '.x {}' }],
    })
    const body = (await res.json()) as { dir: string }
    // The slug is sanitized — never a literal ".." path segment.
    expect(body.dir.includes('..')).toBe(false)
    expect(fs.existsSync(path.join(tmpDir, '..', 'evil'))).toBe(false)
  })
})

/**
 * `sec-16`. Before this gate existed both routes authenticated NOTHING.
 * `copy-css` was therefore an unauthenticated write of caller-supplied bytes
 * into the operator's real repository, reachable from any page they happened
 * to visit: `readValidatedBody` calls `req.json()` whatever the content type,
 * so a cross-origin `<form enctype="text/plain">` needs no preflight and no
 * CORS opt-in — and needed no cookie, because no cookie was read.
 */
describe('design-import namespace — the gate', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-import-gate-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  const PREVIEW = '/admin/api/design-import/preview'
  const COPY_CSS = '/admin/api/design-import/copy-css'

  function plantBody() {
    return {
      dir: tmpDir,
      sourceSlug: 'planted',
      files: [{ relPath: 'pwned.css', contents: 'body { content: "pwned"; }' }],
    }
  }

  function plantedFile(): string {
    return path.join(tmpDir, 'styles', 'imported', 'planted', 'pwned.css')
  }

  it.each([PREVIEW, COPY_CSS])('refuses an unauthenticated POST to %s with 401', async (route) => {
    const res = await serve(route, { body: plantBody() })
    expect(res.status).toBe(401)
    expect(fs.existsSync(plantedFile())).toBe(false)
  })

  it.each([PREVIEW, COPY_CSS])(
    'refuses a signed-in session without studio.write on %s with 403',
    async (route) => {
      const res = await serve(route, { body: plantBody(), cookie: powerlessCookie })
      expect(res.status).toBe(403)
      expect(fs.existsSync(plantedFile())).toBe(false)
    },
  )

  it.each([PREVIEW, COPY_CSS])(
    'refuses a cross-origin POST to %s carrying the victim cookie',
    async (route) => {
      const res = await serve(route, {
        body: plantBody(),
        cookie: ownerCookie,
        origin: 'https://evil.test',
      })
      expect(res.status).toBe(403)
      expect(((await res.json()) as { error?: string }).error).toBe('Forbidden: invalid origin')
      expect(fs.existsSync(plantedFile())).toBe(false)
    },
  )

  it('refuses a cross-origin POST even with no cookie at all — CSRF precedes the session lookup', async () => {
    const res = await serve(COPY_CSS, { body: plantBody(), origin: 'https://evil.test' })
    expect(res.status).toBe(403)
    expect(fs.existsSync(plantedFile())).toBe(false)
  })

  it('refuses an origin-less cross-site browser POST (Sec-Fetch-Site, sec-16)', async () => {
    const url = new URL(`http://localhost${COPY_CSS}`)
    const req = new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify(plantBody()),
    })
    req.headers.set('cookie', ownerCookie)
    req.headers.set('sec-fetch-site', 'cross-site')
    const res = await tryServeDesignImport(req, { db: harness.db }, url, url.pathname)
    expect(res?.status).toBe(403)
    expect(fs.existsSync(plantedFile())).toBe(false)
  })

  it('answers 404 for an undeclared path under the namespace, even for the Owner', async () => {
    const res = await serve('/admin/api/design-import/copy-css/extra', {
      body: plantBody(),
      cookie: ownerCookie,
    })
    expect(res.status).toBe(404)
  })

  it('leaves paths outside the namespace to the rest of the router', async () => {
    const url = new URL('http://localhost/admin/api/design-importer')
    const req = new Request(url, { method: 'POST' })
    expect(await tryServeDesignImport(req, { db: harness.db }, url, url.pathname)).toBeNull()
  })
})
