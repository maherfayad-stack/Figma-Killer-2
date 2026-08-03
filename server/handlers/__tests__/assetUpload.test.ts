/**
 * assetUpload — the write-side asset endpoint (WS-8.3). Every test here is
 * adversarial except the two happy-path ones: this route writes into a real
 * repo on a caller-supplied `targetDir`, so the refusals ARE the feature.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { tryServeStudioAssetUpload, MAX_ASSET_UPLOAD_BYTES } from '../studio/assetUpload'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-asset-upload-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// Minimal-but-real magic-number prefixes. Sniffing only inspects the header,
// so the tail bytes don't need to form a decodable image.
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0])
const NOT_AN_IMAGE = new TextEncoder().encode('<html><body>not an image</body></html>')

function uploadRequest(fields: Record<string, string>, file?: { name: string; bytes: Uint8Array }): Request {
  const form = new FormData()
  for (const [key, value] of Object.entries(fields)) form.append(key, value)
  if (file) form.append('file', new File([file.bytes], file.name))
  return new Request('http://localhost/admin/api/studio/asset-upload', { method: 'POST', body: form })
}

describe('tryServeStudioAssetUpload — routing', () => {
  it('returns null for a non-matching path', async () => {
    const req = new Request('http://localhost/admin/api/studio/other', { method: 'GET' })
    expect(await tryServeStudioAssetUpload(req, new URL(req.url), '/admin/api/studio/other')).toBeNull()
  })

  it('returns null for a matching path with the wrong method', async () => {
    const req = new Request('http://localhost/admin/api/studio/asset-upload', { method: 'GET' })
    expect(
      await tryServeStudioAssetUpload(req, new URL(req.url), '/admin/api/studio/asset-upload'),
    ).toBeNull()
  })
})

describe('tryServeStudioAssetUpload — happy path', () => {
  it('writes a valid PNG into the default target dir and reports its relPath', async () => {
    const req = uploadRequest({ dir: tmpDir }, { name: 'hero.png', bytes: PNG_BYTES })
    const res = await tryServeStudioAssetUpload(req, new URL(req.url), '/admin/api/studio/asset-upload')
    expect(res).not.toBeNull()
    const body = (await res!.json()) as { ok: boolean; relPath: string }
    expect(res!.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.relPath).toBe('src/assets/hero.png')
    expect(fs.readFileSync(path.join(tmpDir, 'src/assets/hero.png'))).toEqual(Buffer.from(PNG_BYTES))
  })

  it('writes into an explicit, pre-existing targetDir', async () => {
    fs.mkdirSync(path.join(tmpDir, 'public', 'images'), { recursive: true })
    const req = uploadRequest(
      { dir: tmpDir, targetDir: 'public/images' },
      { name: 'photo.jpg', bytes: JPEG_BYTES },
    )
    const res = await tryServeStudioAssetUpload(req, new URL(req.url), '/admin/api/studio/asset-upload')
    const body = (await res!.json()) as { relPath: string }
    expect(body.relPath).toBe('public/images/photo.jpg')
  })

  it('derives the extension from the sniffed content, ignoring a mismatched client-declared extension', async () => {
    // Declared name says .png, bytes say JPEG — the write must use the REAL format.
    const req = uploadRequest({ dir: tmpDir }, { name: 'not-really.png', bytes: JPEG_BYTES })
    const res = await tryServeStudioAssetUpload(req, new URL(req.url), '/admin/api/studio/asset-upload')
    const body = (await res!.json()) as { relPath: string }
    expect(body.relPath).toBe('src/assets/not-really.jpg')
  })

  it('avoids overwriting an existing file on name collision', async () => {
    const req1 = uploadRequest({ dir: tmpDir }, { name: 'logo.png', bytes: PNG_BYTES })
    await tryServeStudioAssetUpload(req1, new URL(req1.url), '/admin/api/studio/asset-upload')

    const req2 = uploadRequest({ dir: tmpDir }, { name: 'logo.png', bytes: PNG_BYTES })
    const res2 = await tryServeStudioAssetUpload(req2, new URL(req2.url), '/admin/api/studio/asset-upload')
    const body2 = (await res2!.json()) as { relPath: string }

    expect(body2.relPath).toBe('src/assets/logo-2.png')
    expect(fs.existsSync(path.join(tmpDir, 'src/assets/logo.png'))).toBe(true)
    expect(fs.existsSync(path.join(tmpDir, 'src/assets/logo-2.png'))).toBe(true)
  })

  it('sanitizes an uploaded SVG before writing it — landAssetBytes closes the same gap studio_fetch_remote_asset needs closed', async () => {
    const svgWithScript = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><circle r="5"/></svg>',
    )
    const req = uploadRequest({ dir: tmpDir }, { name: 'icon.svg', bytes: svgWithScript })
    const res = await tryServeStudioAssetUpload(req, new URL(req.url), '/admin/api/studio/asset-upload')
    expect(res!.status).toBe(200)
    const body = (await res!.json()) as { relPath: string }
    const written = fs.readFileSync(path.join(tmpDir, body.relPath), 'utf8')
    expect(written).not.toContain('<script')
    expect(written).not.toContain('alert(1)')
    expect(written).toContain('<circle')
  })

  it('sanitizes a filename carrying traversal-looking characters into a safe base name', async () => {
    const req = uploadRequest({ dir: tmpDir }, { name: '../../evil name!!.png', bytes: PNG_BYTES })
    const res = await tryServeStudioAssetUpload(req, new URL(req.url), '/admin/api/studio/asset-upload')
    const body = (await res!.json()) as { relPath: string }
    // Written INSIDE the target dir, never climbing out via the filename.
    expect(body.relPath.startsWith('src/assets/')).toBe(true)
    expect(body.relPath).not.toContain('..')
    expect(fs.existsSync(path.join(tmpDir, body.relPath))).toBe(true)
  })
})

describe('tryServeStudioAssetUpload — adversarial targetDir', () => {
  it('refuses a parent-traversal targetDir', async () => {
    const req = uploadRequest({ dir: tmpDir, targetDir: '../../.ssh' }, { name: 'x.png', bytes: PNG_BYTES })
    const res = await tryServeStudioAssetUpload(req, new URL(req.url), '/admin/api/studio/asset-upload')
    expect(res!.status).toBe(400)
    expect(fs.existsSync(path.join(path.dirname(path.dirname(tmpDir)), '.ssh'))).toBe(false)
  })

  it('refuses a targetDir using backslash traversal segments', async () => {
    const req = uploadRequest(
      { dir: tmpDir, targetDir: 'src\\..\\..\\outside' },
      { name: 'x.png', bytes: PNG_BYTES },
    )
    const res = await tryServeStudioAssetUpload(req, new URL(req.url), '/admin/api/studio/asset-upload')
    expect(res!.status).toBe(400)
  })

  it('refuses an absolute POSIX targetDir', async () => {
    const req = uploadRequest({ dir: tmpDir, targetDir: '/etc' }, { name: 'x.png', bytes: PNG_BYTES })
    const res = await tryServeStudioAssetUpload(req, new URL(req.url), '/admin/api/studio/asset-upload')
    expect(res!.status).toBe(400)
  })

  it('refuses a Windows drive-letter targetDir', async () => {
    const req = uploadRequest({ dir: tmpDir, targetDir: 'C:\\Windows' }, { name: 'x.png', bytes: PNG_BYTES })
    const res = await tryServeStudioAssetUpload(req, new URL(req.url), '/admin/api/studio/asset-upload')
    expect(res!.status).toBe(400)
  })

  it('refuses a UNC-style targetDir', async () => {
    const req = uploadRequest({ dir: tmpDir, targetDir: '\\\\host\\share' }, { name: 'x.png', bytes: PNG_BYTES })
    const res = await tryServeStudioAssetUpload(req, new URL(req.url), '/admin/api/studio/asset-upload')
    expect(res!.status).toBe(400)
  })

  it('refuses an excluded workspace directory name', async () => {
    const req = uploadRequest({ dir: tmpDir, targetDir: 'node_modules/x' }, { name: 'x.png', bytes: PNG_BYTES })
    const res = await tryServeStudioAssetUpload(req, new URL(req.url), '/admin/api/studio/asset-upload')
    expect(res!.status).toBe(400)
  })

  it('refuses a targetDir reached through a symlink escaping the workspace', async () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-asset-upload-outside-'))
    try {
      const link = path.join(tmpDir, 'linked')
      try {
        fs.symlinkSync(outsideDir, link, 'junction')
      } catch {
        return // symlink creation unsupported/unprivileged in this environment — skip
      }

      const req = uploadRequest({ dir: tmpDir, targetDir: 'linked' }, { name: 'x.png', bytes: PNG_BYTES })
      const res = await tryServeStudioAssetUpload(req, new URL(req.url), '/admin/api/studio/asset-upload')

      expect(res!.status).toBe(400)
      expect(fs.readdirSync(outsideDir)).toEqual([])
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true })
    }
  })

  it('refuses when an intermediate (not-yet-existing-leaf) path segment is a symlink escaping the workspace', async () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-asset-upload-outside2-'))
    try {
      const link = path.join(tmpDir, 'src')
      try {
        fs.symlinkSync(outsideDir, link, 'junction')
      } catch {
        return // symlink creation unsupported/unprivileged in this environment — skip
      }

      // "src/assets" doesn't exist yet, but "src" itself is a symlink escaping
      // the workspace — the nearest-existing-ancestor walk must catch it.
      const req = uploadRequest({ dir: tmpDir, targetDir: 'src/assets' }, { name: 'x.png', bytes: PNG_BYTES })
      const res = await tryServeStudioAssetUpload(req, new URL(req.url), '/admin/api/studio/asset-upload')

      expect(res!.status).toBe(400)
      expect(fs.existsSync(path.join(outsideDir, 'assets'))).toBe(false)
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true })
    }
  })
})

describe('tryServeStudioAssetUpload — adversarial file content', () => {
  it('refuses a file whose content is not a recognized image, regardless of its declared name', async () => {
    const req = uploadRequest({ dir: tmpDir }, { name: 'totally-a-photo.png', bytes: NOT_AN_IMAGE })
    const res = await tryServeStudioAssetUpload(req, new URL(req.url), '/admin/api/studio/asset-upload')
    expect(res!.status).toBe(400)
    expect(fs.existsSync(path.join(tmpDir, 'src/assets'))).toBe(false)
  })

  it('refuses a request with no file', async () => {
    const req = uploadRequest({ dir: tmpDir })
    const res = await tryServeStudioAssetUpload(req, new URL(req.url), '/admin/api/studio/asset-upload')
    expect(res!.status).toBe(400)
  })

  it('refuses an empty file', async () => {
    const req = uploadRequest({ dir: tmpDir }, { name: 'x.png', bytes: new Uint8Array(0) })
    const res = await tryServeStudioAssetUpload(req, new URL(req.url), '/admin/api/studio/asset-upload')
    expect(res!.status).toBe(400)
  })

  it('defaults dir through the same optional-dir convention save/load use, never touching the real repo', async () => {
    // `dir` omitted is a real, supported shape (mirrors `SaveBodySchema`'s
    // `Type.Optional`) — the route must NOT reject it. It must also NOT fall
    // back to this repo's own real `studio-workspace/`, so the default
    // resolution is injected via `deps.resolveDir` here, the same test seam
    // `tryServeStudioIngest` uses for `projectsRoot`.
    const form = new FormData()
    form.append('file', new File([PNG_BYTES], 'x.png'))
    const req = new Request('http://localhost/admin/api/studio/asset-upload', { method: 'POST', body: form })

    const res = await tryServeStudioAssetUpload(req, new URL(req.url), '/admin/api/studio/asset-upload', {
      resolveDir: () => tmpDir,
    })

    expect(res!.status).toBe(200)
    expect(fs.existsSync(path.join(tmpDir, 'src/assets/x.png'))).toBe(true)
  })

  it('rejects an oversized upload by streamed byte count, not a declared content-length', async () => {
    // Bun does not set content-length for a FormData-body Request, so a
    // spoofed/missing header can't be the thing enforcing this cap — only the
    // actual streamed size can, which is exactly what `readFormDataWithLimit`
    // checks.
    const oversized = new Uint8Array(MAX_ASSET_UPLOAD_BYTES + 1024)
    oversized.set(PNG_BYTES) // still starts with a valid PNG header — size is the only violation
    const req = uploadRequest({ dir: tmpDir }, { name: 'huge.png', bytes: oversized })
    const res = await tryServeStudioAssetUpload(req, new URL(req.url), '/admin/api/studio/asset-upload')
    expect(res!.status).toBe(413)
    expect(fs.existsSync(path.join(tmpDir, 'src/assets'))).toBe(false)
  })
})
