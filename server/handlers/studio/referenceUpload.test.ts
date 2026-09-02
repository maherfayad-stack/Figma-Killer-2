/**
 * referenceUpload — `POST/GET/DELETE /admin/api/studio/reference-upload`.
 * Exercises the real handler against a real project directory and real
 * sharp-encoded PNG bytes — the exact contract `uploadDesignReference.ts`
 * (the chat panel's client) specifies in its own header comment.
 *
 * Same fixture posture as `trustTier.test.ts`/`componentBundle.test.ts`: a
 * temp dir created INSIDE `projectsRootDir()` so the route's own
 * `isRealpathContained(dir, projectsRootDir())` containment guard passes.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import sharp from 'sharp'
import { projectsRootDir } from '../studioProjects'
import { tryServeStudioReferenceUpload } from './referenceUpload'

const ROUTE_URL = 'http://localhost/admin/api/studio/reference-upload'
const ROUTE_PATH = '/admin/api/studio/reference-upload'

let dir: string

beforeEach(() => {
  const root = projectsRootDir()
  fs.mkdirSync(root, { recursive: true })
  dir = fs.mkdtempSync(path.join(root, '__reference_upload_test_'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

async function pngFile(name: string, width = 10, height = 10): Promise<File> {
  const bytes = await sharp({ create: { width, height, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } } })
    .png()
    .toBuffer()
  return new File([bytes], name, { type: 'image/png' })
}

async function post(dirValue: string, file: File): Promise<Response> {
  const form = new FormData()
  form.set('dir', dirValue)
  form.set('file', file)
  const res = await tryServeStudioReferenceUpload(
    new Request(ROUTE_URL, { method: 'POST', body: form }),
    new URL(ROUTE_URL),
    ROUTE_PATH,
  )
  return res!
}

async function get(dirValue: string): Promise<Response> {
  const url = new URL(ROUTE_URL)
  url.searchParams.set('dir', dirValue)
  const res = await tryServeStudioReferenceUpload(new Request(url, { method: 'GET' }), url, ROUTE_PATH)
  return res!
}

async function del(dirValue: string, id: string): Promise<Response> {
  const url = new URL(ROUTE_URL)
  url.searchParams.set('dir', dirValue)
  url.searchParams.set('id', id)
  const res = await tryServeStudioReferenceUpload(new Request(url, { method: 'DELETE' }), url, ROUTE_PATH)
  return res!
}

describe('tryServeStudioReferenceUpload', () => {
  it('ignores a path it does not own', async () => {
    const res = await tryServeStudioReferenceUpload(new Request('http://localhost/x'), new URL('http://localhost/x'), '/x')
    expect(res).toBeNull()
  })

  it('POST lands a real PNG and returns its metadata', async () => {
    const res = await post(dir, await pngFile('hero.png', 12, 9))
    const body = await res.json() as { ok: boolean; reference: { id: string; width: number; height: number } }
    expect(body.ok).toBe(true)
    expect(body.reference.width).toBe(12)
    expect(body.reference.height).toBe(9)
    expect(fs.existsSync(path.join(dir, '.studio', 'references', `${body.reference.id}.png`))).toBe(true)
  })

  it('GET returns null when nothing has been uploaded yet, then the most recent upload', async () => {
    const emptyBody = await (await get(dir)).json() as { reference: unknown }
    expect(emptyBody.reference).toBeNull()

    await post(dir, await pngFile('one.png'))
    const secondUpload = await post(dir, await pngFile('two.png'))
    const secondBody = await secondUpload.json() as { reference: { id: string } }

    const body = await (await get(dir)).json() as { reference: { id: string } | null }
    expect(body.reference?.id).toBe(secondBody.reference.id)
  })

  it('DELETE removes a reference and GET no longer returns it', async () => {
    const uploadRes = await post(dir, await pngFile('gone.png'))
    const { reference } = await uploadRes.json() as { reference: { id: string } }

    const delBody = await (await del(dir, reference.id)).json() as { ok: boolean }
    expect(delBody.ok).toBe(true)

    const body = await (await get(dir)).json() as { reference: unknown }
    expect(body.reference).toBeNull()
  })

  it('DELETE is idempotent — an unknown id still returns ok:true', async () => {
    const body = await (await del(dir, '11111111-1111-1111-1111-111111111111')).json() as { ok: boolean }
    expect(body.ok).toBe(true)
  })

  it('POST refuses non-image content without writing anything', async () => {
    const file = new File([new TextEncoder().encode('not an image')], 'x.png', { type: 'image/png' })
    const res = await post(dir, file)
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(fs.existsSync(path.join(dir, '.studio', 'references'))).toBe(false)
  })

  it('rejects a dir outside studio-workspace/', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'reference-upload-outside-'))
    try {
      const res = await get(outside)
      expect(res.status).toBe(404)
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })
})
