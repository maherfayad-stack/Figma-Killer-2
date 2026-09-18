/**
 * assetDrop — D2 G15's write route. Two halves are tested here, and only one of
 * them is new code:
 *
 *  - **the product decision** (`resolveDroppedAssetHome` / `droppedAssetSrc`):
 *    which directory in THIS project can back a literal `<img src>`, when
 *    Studio may create it, and what the literal actually is. That decision is
 *    the whole reason this route exists rather than a second caller of
 *    `asset-upload`.
 *  - **that the shared security pipeline still applies**. The route delegates
 *    every guard to `landAssetBytes`, so the tests that matter are the ones
 *    proving delegation actually happened: a non-image is refused by CONTENT
 *    (not by its declared type), an oversize body never lands, and the write
 *    directory is server-derived so there is no client string to traverse with.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  droppedAssetSrc,
  resolveDroppedAssetHome,
  tryServeStudioAssetDrop,
  MAX_ASSET_DROP_BYTES,
} from '../studio/assetDrop'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-asset-drop-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// Minimal-but-real magic-number prefixes — sniffing only inspects the header.
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0])
const NOT_AN_IMAGE = new TextEncoder().encode('%PDF-1.7\nnot an image at all\n')

function write(rel: string, contents: string): void {
  const full = path.join(tmpDir, ...rel.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents, 'utf8')
}

/** A Vite-shaped project — the framework detection this route's directory decision reads. */
function seedViteProject(): void {
  write('package.json', JSON.stringify({ name: 'app', devDependencies: { vite: '^5.0.0' } }))
  write('vite.config.ts', "export default {}\n")
  write('src/App.tsx', 'export default function App() { return <div /> }\n')
}

function dropRequest(fields: Record<string, string>, file?: { name: string; bytes: Uint8Array; type?: string }): Request {
  const form = new FormData()
  for (const [key, value] of Object.entries(fields)) form.append(key, value)
  if (file) form.append('file', new File([file.bytes], file.name, file.type ? { type: file.type } : undefined))
  return new Request('http://localhost/admin/api/studio/asset-drop', { method: 'POST', body: form })
}

const serve = (req: Request) =>
  tryServeStudioAssetDrop(req, new URL(req.url), '/admin/api/studio/asset-drop')

describe('tryServeStudioAssetDrop — routing', () => {
  it('returns null for a non-matching path', async () => {
    const req = new Request('http://localhost/admin/api/studio/other', { method: 'POST' })
    expect(await tryServeStudioAssetDrop(req, new URL(req.url), '/admin/api/studio/other')).toBeNull()
  })

  it('returns null for a matching path with the wrong method', async () => {
    const req = new Request('http://localhost/admin/api/studio/asset-drop', { method: 'GET' })
    expect(await serve(req)).toBeNull()
  })
})

describe('resolveDroppedAssetHome — the one honest location', () => {
  it('uses an existing public/ folder', () => {
    seedViteProject()
    fs.mkdirSync(path.join(tmpDir, 'public'))
    const home = resolveDroppedAssetHome(tmpDir)
    expect(home.ok).toBe(true)
    if (!home.ok) return
    expect(home.relToProject).toBe('public')
  })

  it('CREATES public/ for a framework whose contract already serves it', () => {
    seedViteProject()
    expect(fs.existsSync(path.join(tmpDir, 'public'))).toBe(false)
    const home = resolveDroppedAssetHome(tmpDir)
    expect(home.ok).toBe(true)
    expect(fs.existsSync(path.join(tmpDir, 'public'))).toBe(true)
  })

  it('REFUSES rather than guessing when no framework was detected and there is no public/', () => {
    write('package.json', JSON.stringify({ name: 'mystery' }))
    write('index.js', 'console.log(1)\n')
    const home = resolveDroppedAssetHome(tmpDir)
    expect(home.ok).toBe(false)
    if (home.ok) return
    expect(home.error).toContain('public/')
    expect(fs.existsSync(path.join(tmpDir, 'public'))).toBe(false)
  })
})

describe('droppedAssetSrc — the literal the <img> gets', () => {
  it('is the file name at the site root', () => {
    expect(droppedAssetSrc('public/photo.png')).toBe('/photo.png')
  })

  it('drops the app root of a monorepo — the browser never sees where the app lives on disk', () => {
    expect(droppedAssetSrc('apps/web/public/photo.png')).toBe('/photo.png')
  })

  it('keeps a nested path under public/', () => {
    expect(droppedAssetSrc('public/img/photo.png')).toBe('/img/photo.png')
  })
})

describe('tryServeStudioAssetDrop — happy path', () => {
  beforeEach(seedViteProject)

  it('lands the image in public/ and reports the literal src an <img> can use', async () => {
    const res = await serve(dropRequest({ dir: tmpDir }, { name: 'hero.png', bytes: PNG_BYTES }))
    expect(res).not.toBeNull()
    expect(res!.status).toBe(200)
    const body = (await res!.json()) as { ok: boolean; relPath: string; src: string }
    expect(body).toEqual({ ok: true, relPath: 'public/hero.png', src: '/hero.png' })
    expect(fs.readFileSync(path.join(tmpDir, 'public', 'hero.png'))).toEqual(Buffer.from(PNG_BYTES))
  })

  it('derives the extension from the CONTENT, not the declared name or type', async () => {
    const res = await serve(
      dropRequest({ dir: tmpDir }, { name: 'lying.png', bytes: JPEG_BYTES, type: 'image/png' }),
    )
    const body = (await res!.json()) as { relPath: string; src: string }
    expect(body.relPath).toBe('public/lying.jpg')
    expect(body.src).toBe('/lying.jpg')
  })

  it('never overwrites an existing file of the same name', async () => {
    await serve(dropRequest({ dir: tmpDir }, { name: 'logo.png', bytes: PNG_BYTES }))
    const res = await serve(dropRequest({ dir: tmpDir }, { name: 'logo.png', bytes: PNG_BYTES }))
    const body = (await res!.json()) as { src: string }
    expect(body.src).toBe('/logo-2.png')
    expect(fs.existsSync(path.join(tmpDir, 'public', 'logo.png'))).toBe(true)
  })

  it('strips path separators out of the declared filename', async () => {
    const res = await serve(dropRequest({ dir: tmpDir }, { name: '../../etc/passwd.png', bytes: PNG_BYTES }))
    const body = (await res!.json()) as { relPath: string }
    expect(body.relPath).toBe('public/passwd.png')
    expect(fs.existsSync(path.join(tmpDir, 'public', 'passwd.png'))).toBe(true)
  })
})

describe('tryServeStudioAssetDrop — refusals', () => {
  beforeEach(seedViteProject)

  it('refuses a non-image by its CONTENT, naming what it is not', async () => {
    const res = await serve(
      dropRequest({ dir: tmpDir }, { name: 'report.png', bytes: NOT_AN_IMAGE, type: 'image/png' }),
    )
    expect(res!.status).toBe(400)
    const body = (await res!.json()) as { error: string }
    expect(body.error).toContain('not a recognized image format')
    expect(fs.existsSync(path.join(tmpDir, 'public', 'report.png'))).toBe(false)
  })

  it('refuses a request with no file at all', async () => {
    const res = await serve(dropRequest({ dir: tmpDir }))
    expect(res!.status).toBe(400)
  })

  it('refuses an empty file', async () => {
    const res = await serve(dropRequest({ dir: tmpDir }, { name: 'empty.png', bytes: new Uint8Array(0) }))
    expect(res!.status).toBe(400)
  })

  it('refuses a body past the streamed size cap without writing anything', async () => {
    const oversize = new Uint8Array(MAX_ASSET_DROP_BYTES + 1024)
    oversize.set(PNG_BYTES, 0)
    const res = await serve(dropRequest({ dir: tmpDir }, { name: 'huge.png', bytes: oversize }))
    expect(res!.status).toBeGreaterThanOrEqual(400)
    expect(fs.existsSync(path.join(tmpDir, 'public', 'huge.png'))).toBe(false)
  })

  it('refuses with 409 when the project has no public/ and no framework convention', async () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-asset-drop-bare-'))
    try {
      fs.writeFileSync(path.join(bare, 'package.json'), JSON.stringify({ name: 'mystery' }), 'utf8')
      fs.writeFileSync(path.join(bare, 'index.js'), 'console.log(1)\n', 'utf8')
      const res = await serve(dropRequest({ dir: bare }, { name: 'hero.png', bytes: PNG_BYTES }))
      expect(res!.status).toBe(409)
      const body = (await res!.json()) as { error: string }
      expect(body.error).toContain('public/')
      expect(fs.existsSync(path.join(bare, 'public'))).toBe(false)
    } finally {
      fs.rmSync(bare, { recursive: true, force: true })
    }
  })
})
