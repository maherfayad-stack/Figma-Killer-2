/**
 * assetLanding — direct unit coverage of the shared write pipeline both
 * `assetUpload.ts` (`assetUpload.test.ts`) and `remoteAssetFetch.ts`
 * (`remoteAssetFetch.test.ts`) already exercise end to end. This file covers
 * `landAssetBytes` itself, in isolation, so the choke point has its own
 * direct tests rather than relying only on its two callers'.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { landAssetBytes, sniffImageExtension } from './assetLanding'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-asset-landing-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])

describe('sniffImageExtension', () => {
  it('recognizes a PNG and refuses arbitrary text', () => {
    expect(sniffImageExtension(PNG_BYTES)).toBe('png')
    expect(sniffImageExtension(new TextEncoder().encode('not an image'))).toBeNull()
  })

  it('recognizes SVG text content, tolerating a leading XML declaration', () => {
    const svg = new TextEncoder().encode('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>')
    expect(sniffImageExtension(svg)).toBe('svg')
  })
})

describe('landAssetBytes', () => {
  it('writes a valid PNG and returns its workspace-relative path', () => {
    const result = landAssetBytes(dir, undefined, PNG_BYTES, 'hero.png')
    expect(result).toEqual({ ok: true, relPath: 'src/assets/hero.png' })
    expect(fs.readFileSync(path.join(dir, 'src/assets/hero.png'))).toEqual(Buffer.from(PNG_BYTES))
  })

  it('sanitizes SVG bytes before writing — the pipeline both callers rely on for this', () => {
    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" onload="steal()"><script>alert(1)</script><rect width="1" height="1"/></svg>',
    )
    const result = landAssetBytes(dir, undefined, svg, 'icon.svg')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const written = fs.readFileSync(path.join(dir, result.relPath), 'utf8')
    expect(written).not.toContain('<script')
    expect(written).not.toContain('onload')
    expect(written).toContain('<rect')
  })

  it('refuses content that is not a recognized image', () => {
    const result = landAssetBytes(dir, undefined, new TextEncoder().encode('nope'), 'x.png')
    expect(result).toEqual({ ok: false, error: expect.stringContaining('not a recognized image format') })
  })

  it('refuses a traversal-shaped targetDir without writing anything', () => {
    const result = landAssetBytes(dir, '../../outside', PNG_BYTES, 'x.png')
    expect(result.ok).toBe(false)
    expect(fs.existsSync(path.join(path.dirname(path.dirname(dir)), 'outside'))).toBe(false)
  })

  it('never overwrites a name collision — numeric suffix instead', () => {
    landAssetBytes(dir, undefined, PNG_BYTES, 'logo.png')
    const second = landAssetBytes(dir, undefined, PNG_BYTES, 'logo.png')
    expect(second).toEqual({ ok: true, relPath: 'src/assets/logo-2.png' })
  })

  it('derives the extension from sniffed bytes, ignoring the declared filename\'s own extension', () => {
    const result = landAssetBytes(dir, undefined, PNG_BYTES, 'not-really.svg')
    expect(result).toEqual({ ok: true, relPath: 'src/assets/not-really.png' })
  })
})
