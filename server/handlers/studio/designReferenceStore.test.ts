/**
 * designReferenceStore — direct coverage of register/list/get/read/remove
 * against real, sharp-encoded PNG/JPEG bytes (not synthetic magic-byte
 * prefixes) so dimension probing and content hashing exercise the real
 * decode path, not a stub.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import sharp from 'sharp'
import {
  getDesignReference,
  getMostRecentDesignReference,
  listDesignReferences,
  readDesignReferenceBytes,
  registerDesignReference,
  removeDesignReference,
} from './designReferenceStore'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-design-reference-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

async function pngBytes(width: number, height: number, color: { r: number; g: number; b: number }): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({ create: { width, height, channels: 4, background: { ...color, alpha: 1 } } }).png().toBuffer(),
  )
}

async function jpegBytes(width: number, height: number): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({ create: { width, height, channels: 3, background: { r: 10, g: 20, b: 30 } } }).jpeg().toBuffer(),
  )
}

const SVG_BYTES = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"></svg>')

describe('registerDesignReference', () => {
  it('lands real PNG bytes verbatim and records accurate metadata', async () => {
    const bytes = await pngBytes(40, 30, { r: 200, g: 100, b: 50 })
    const result = await registerDesignReference(dir, bytes, { pageId: 'src/screens/Home.tsx', label: 'Home hero' })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.reference.width).toBe(40)
    expect(result.reference.height).toBe(30)
    expect(result.reference.ext).toBe('png')
    expect(result.reference.mimeType).toBe('image/png')
    expect(result.reference.sizeBytes).toBe(bytes.length)
    expect(result.reference.pageId).toBe('src/screens/Home.tsx')
    expect(result.reference.label).toBe('Home hero')
    expect(result.reference.contentHash).toMatch(/^[0-9a-f]{64}$/)

    // Bytes on disk are byte-for-byte the original — never re-encoded.
    const onDisk = fs.readFileSync(path.join(dir, '.studio', 'references', `${result.reference.id}.png`))
    expect(onDisk).toEqual(Buffer.from(bytes))
  })

  it('accepts a real JPEG and reports the correct ext/mimeType', async () => {
    const bytes = await jpegBytes(20, 20)
    const result = await registerDesignReference(dir, bytes, {})
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.reference.ext).toBe('jpg')
    expect(result.reference.mimeType).toBe('image/jpeg')
  })

  it('refuses an SVG outright — no fixed intrinsic pixel size to diff against', async () => {
    const result = await registerDesignReference(dir, SVG_BYTES, {})
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('SVG')
    expect(fs.existsSync(path.join(dir, '.studio', 'references'))).toBe(false)
  })

  it('refuses unrecognized content without writing anything', async () => {
    const result = await registerDesignReference(dir, new TextEncoder().encode('not an image'), {})
    expect(result.ok).toBe(false)
    expect(fs.existsSync(path.join(dir, '.studio', 'references'))).toBe(false)
  })

  it('refuses empty bytes', async () => {
    const result = await registerDesignReference(dir, new Uint8Array(0), {})
    expect(result.ok).toBe(false)
  })
})

describe('listDesignReferences / getDesignReference / getMostRecentDesignReference', () => {
  it('lists every registered reference, filters by pageId, and caps honestly', async () => {
    await registerDesignReference(dir, await pngBytes(10, 10, { r: 0, g: 0, b: 0 }), { pageId: 'pageA' })
    await registerDesignReference(dir, await pngBytes(10, 10, { r: 10, g: 0, b: 0 }), { pageId: 'pageB' })
    await registerDesignReference(dir, await pngBytes(10, 10, { r: 20, g: 0, b: 0 }), { pageId: 'pageB' })

    const all = listDesignReferences(dir, undefined, undefined)
    expect(all.totalCount).toBe(3)
    expect(all.truncated).toBe(false)

    const onlyB = listDesignReferences(dir, 'pageB', undefined)
    expect(onlyB.totalCount).toBe(2)

    const capped = listDesignReferences(dir, undefined, 2)
    expect(capped.references.length).toBe(2)
    expect(capped.truncated).toBe(true)
    expect(capped.omittedCount).toBe(1)
  })

  it('getDesignReference finds by id and rejects a malformed id without throwing', async () => {
    const bytes = await pngBytes(5, 5, { r: 1, g: 2, b: 3 })
    const result = await registerDesignReference(dir, bytes, {})
    if (!result.ok) throw new Error('setup failed')

    expect(getDesignReference(dir, result.reference.id)).toEqual(result.reference)
    expect(getDesignReference(dir, 'not-a-uuid')).toBeNull()
    expect(getDesignReference(dir, '00000000-0000-0000-0000-000000000000')).toBeNull()
  })

  it('getMostRecentDesignReference returns the LAST registered entry, or null', async () => {
    expect(getMostRecentDesignReference(dir)).toBeNull()

    const first = await registerDesignReference(dir, await pngBytes(5, 5, { r: 1, g: 1, b: 1 }), {})
    const second = await registerDesignReference(dir, await pngBytes(6, 6, { r: 2, g: 2, b: 2 }), {})
    if (!first.ok || !second.ok) throw new Error('setup failed')

    expect(getMostRecentDesignReference(dir)!.id).toBe(second.reference.id)
  })
})

describe('readDesignReferenceBytes', () => {
  it('reads back the exact original bytes by id, ignoring a tampered relPath', async () => {
    const bytes = await pngBytes(12, 8, { r: 5, g: 6, b: 7 })
    const result = await registerDesignReference(dir, bytes, {})
    if (!result.ok) throw new Error('setup failed')

    const tampered = { ...result.reference, relPath: '../../../../etc/passwd' }
    const read = readDesignReferenceBytes(dir, tampered)
    expect(read).toEqual(bytes)
  })

  it('degrades to null (not a decode error) when the file is missing from disk', async () => {
    const bytes = await pngBytes(4, 4, { r: 0, g: 0, b: 0 })
    const result = await registerDesignReference(dir, bytes, {})
    if (!result.ok) throw new Error('setup failed')

    fs.rmSync(path.join(dir, '.studio', 'references', `${result.reference.id}.png`))
    expect(readDesignReferenceBytes(dir, result.reference)).toBeNull()
  })
})

describe('removeDesignReference', () => {
  it('deletes the manifest entry and the on-disk file', async () => {
    const bytes = await pngBytes(9, 9, { r: 9, g: 9, b: 9 })
    const result = await registerDesignReference(dir, bytes, {})
    if (!result.ok) throw new Error('setup failed')
    const filePath = path.join(dir, '.studio', 'references', `${result.reference.id}.png`)
    expect(fs.existsSync(filePath)).toBe(true)

    const removed = removeDesignReference(dir, result.reference.id)
    expect(removed.removed).toBe(true)
    expect(getDesignReference(dir, result.reference.id)).toBeNull()
    expect(fs.existsSync(filePath)).toBe(false)
  })

  it('is idempotent — removing an unknown id is not an error', () => {
    expect(removeDesignReference(dir, '11111111-1111-1111-1111-111111111111')).toEqual({ removed: false })
    expect(removeDesignReference(dir, 'not-a-uuid-at-all')).toEqual({ removed: false })
  })
})
