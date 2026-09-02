/**
 * POST /admin/api/design-import/{preview,copy-css} — route wiring over
 * `githubSource.ts`/`npmSource.ts`/`parseCssTokens.ts`. The fetch itself is
 * unit-tested in `designImport/__tests__/`; this only exercises the HTTP
 * layer (body validation, response shape, error mapping), same split as
 * `studio.test.ts`'s "route wiring" describe blocks.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { tryServeDesignImport } from '../designImport'

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
    const url = new URL('http://localhost/admin/api/design-import/preview')
    const req = new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const res = await tryServeDesignImport(req, undefined, url, url.pathname)
    expect(res).not.toBeNull()
    return res!
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

  it('rejects a GET request', async () => {
    const url = new URL('http://localhost/admin/api/design-import/preview')
    const req = new Request(url, { method: 'GET' })
    const res = await tryServeDesignImport(req, undefined, url, url.pathname)
    expect(res).toBeNull()
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
    const url = new URL('http://localhost/admin/api/design-import/copy-css')
    const req = new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const res = await tryServeDesignImport(req, undefined, url, url.pathname)
    expect(res).not.toBeNull()
    return res!
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
