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
import { pathToFileURL } from 'node:url'
import { MAX_DEDUPE_CANDIDATES, landAssetBytes, landDesignReferenceBytes, sniffImageExtension } from './assetLanding'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-asset-landing-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
/** Same length as `PNG_BYTES`, different content: a size match that must NOT dedupe. */
const OTHER_PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 1])

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
    expect(result).toEqual({ ok: true, relPath: 'src/assets/hero.png', deduped: false, width: null, height: null })
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
    const second = landAssetBytes(dir, undefined, OTHER_PNG_BYTES, 'logo.png')
    expect(second).toEqual({ ok: true, relPath: 'src/assets/logo-2.png', deduped: false, width: null, height: null })
    expect(fs.readFileSync(path.join(dir, 'src/assets/logo.png'))).toEqual(Buffer.from(PNG_BYTES))
  })

  it('derives the extension from sniffed bytes, ignoring the declared filename\'s own extension', () => {
    const result = landAssetBytes(dir, undefined, PNG_BYTES, 'not-really.svg')
    expect(result).toEqual({ ok: true, relPath: 'src/assets/not-really.png', deduped: false, width: null, height: null })
  })
})

describe('landAssetBytes — content dedupe (IMG-1, audit 07 §A.4)', () => {
  it('reuses a byte-identical file in the same directory instead of writing photo-2', () => {
    const first = landAssetBytes(dir, 'public', PNG_BYTES, 'photo.png')
    const second = landAssetBytes(dir, 'public', PNG_BYTES, 'photo.png')
    expect(first).toMatchObject({ ok: true, relPath: 'public/photo.png', deduped: false })
    expect(second).toMatchObject({ ok: true, relPath: 'public/photo.png', deduped: true })
    expect(fs.readdirSync(path.join(dir, 'public'))).toEqual(['photo.png'])
  })

  it('reuses the identical file whatever name the second landing declared', () => {
    landAssetBytes(dir, 'public', PNG_BYTES, 'photo.png')
    const renamed = landAssetBytes(dir, 'public', PNG_BYTES, 'holiday.png')
    expect(renamed).toMatchObject({ relPath: 'public/photo.png', deduped: true })
  })

  it('writes a new file for same-size bytes that differ', () => {
    landAssetBytes(dir, 'public', PNG_BYTES, 'photo.png')
    const other = landAssetBytes(dir, 'public', OTHER_PNG_BYTES, 'photo.png')
    expect(other).toMatchObject({ relPath: 'public/photo-2.png', deduped: false })
    expect(fs.readFileSync(path.join(dir, 'public/photo-2.png'))).toEqual(Buffer.from(OTHER_PNG_BYTES))
  })

  it(`compares at most ${MAX_DEDUPE_CANDIDATES} same-size candidates, then writes a new file (security review F2)`, () => {
    fs.mkdirSync(path.join(dir, 'public'), { recursive: true })
    // MAX_DEDUPE_CANDIDATES same-size decoys sort before the identical twin.
    for (let i = 0; i < MAX_DEDUPE_CANDIDATES; i += 1) {
      const decoy = new Uint8Array(PNG_BYTES)
      decoy[decoy.length - 1] = 100 + i
      fs.writeFileSync(path.join(dir, 'public', `a${String(i).padStart(2, '0')}.png`), decoy)
    }
    fs.writeFileSync(path.join(dir, 'public', 'zz-twin.png'), PNG_BYTES)

    const landed = landAssetBytes(dir, 'public', PNG_BYTES, 'photo.png')
    expect(landed).toMatchObject({ relPath: 'public/photo.png', deduped: false })
  })

  it('still finds the twin when it is within the candidate cap', () => {
    fs.mkdirSync(path.join(dir, 'public'), { recursive: true })
    for (let i = 0; i < MAX_DEDUPE_CANDIDATES - 1; i += 1) {
      const decoy = new Uint8Array(PNG_BYTES)
      decoy[decoy.length - 1] = 100 + i
      fs.writeFileSync(path.join(dir, 'public', `a${String(i).padStart(2, '0')}.png`), decoy)
    }
    fs.writeFileSync(path.join(dir, 'public', 'zz-twin.png'), PNG_BYTES)

    expect(landAssetBytes(dir, 'public', PNG_BYTES, 'photo.png')).toMatchObject({ relPath: 'public/zz-twin.png', deduped: true })
  })

  it('compares a multi-chunk file correctly: a difference in the last byte is not a match', () => {
    const big = new Uint8Array(200 * 1024)
    big.set(PNG_BYTES.subarray(0, 8), 0)
    const almost = new Uint8Array(big)
    almost[almost.length - 1] = 1
    fs.mkdirSync(path.join(dir, 'public'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'public', 'almost.png'), almost)
    expect(landAssetBytes(dir, 'public', big, 'big.png')).toMatchObject({ relPath: 'public/big.png', deduped: false })
    expect(landAssetBytes(dir, 'public', almost, 'x.png')).toMatchObject({ relPath: 'public/almost.png', deduped: true })
  })

  it('never dedupes across directories', () => {
    landAssetBytes(dir, 'public', PNG_BYTES, 'photo.png')
    const elsewhere = landAssetBytes(dir, 'public/img', PNG_BYTES, 'photo.png')
    expect(elsewhere).toMatchObject({ relPath: 'public/img/photo.png', deduped: false })
  })

  it('compares the SANITIZED bytes of an SVG, so one hostile SVG landed twice is one file', () => {
    const hostile = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" onload="steal()"><rect width="1" height="1"/></svg>',
    )
    landAssetBytes(dir, 'public', hostile, 'mark.svg')
    const again = landAssetBytes(dir, 'public', hostile, 'mark.svg')
    expect(again).toMatchObject({ relPath: 'public/mark.svg', deduped: true })
  })

  it('never dedupes a design reference: its file name is its id, so two references must not share a file', () => {
    const first = landDesignReferenceBytes(dir, PNG_BYTES, 'ref-a')
    const second = landDesignReferenceBytes(dir, PNG_BYTES, 'ref-b')
    expect(first).toMatchObject({ relPath: '.studio/references/ref-a.png', deduped: false })
    expect(second).toMatchObject({ relPath: '.studio/references/ref-b.png', deduped: false })
  })

  it('never reuses an identical file whose NAME it could not have written (it would reach an <img src>)', () => {
    fs.mkdirSync(path.join(dir, 'public'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'public', 'a b.png'), PNG_BYTES)
    const landed = landAssetBytes(dir, 'public', PNG_BYTES, 'photo.png')
    expect(landed).toMatchObject({ relPath: 'public/photo.png', deduped: false })
  })

  it('never follows a symlink to find an identical file', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-asset-landing-outside-'))
    try {
      fs.writeFileSync(path.join(outside, 'secret.png'), PNG_BYTES)
      fs.mkdirSync(path.join(dir, 'public'), { recursive: true })
      try {
        fs.symlinkSync(path.join(outside, 'secret.png'), path.join(dir, 'public', 'linked.png'), 'file')
      } catch {
        return // symlink creation needs a privilege this machine does not grant
      }
      const landed = landAssetBytes(dir, 'public', PNG_BYTES, 'photo.png')
      expect(landed).toMatchObject({ relPath: 'public/photo.png', deduped: false })
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe('landAssetBytes — exclusive create (audit 07 §A.4 TOCTOU)', () => {
  it('never follows a dangling symlink that holds the name: the name is taken, the target never created', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-asset-landing-escape-'))
    const escapeTarget = path.join(outside, 'planted.png')
    try {
      fs.mkdirSync(path.join(dir, 'public'), { recursive: true })
      try {
        // A repo from GitHub can carry exactly this: `public/hero.png` -> a path outside the project.
        fs.symlinkSync(escapeTarget, path.join(dir, 'public', 'hero.png'), 'file')
      } catch {
        return // symlink creation needs a privilege this machine does not grant
      }
      const landed = landAssetBytes(dir, 'public', PNG_BYTES, 'hero.png')
      expect(landed).toMatchObject({ ok: true, relPath: 'public/hero-2.png', deduped: false })
      expect(fs.existsSync(escapeTarget)).toBe(false)
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it('concurrent landings of one name from separate processes each get their own file; none is overwritten', async () => {
    const workers = 6
    const goFile = path.join(dir, 'go')
    const moduleUrl = pathToFileURL(path.join(import.meta.dir, 'assetLanding.ts')).href
    const script = [
      `const { landAssetBytes } = await import(${JSON.stringify(moduleUrl)})`,
      `const fs = await import('node:fs')`,
      `while (!fs.existsSync(${JSON.stringify(goFile)})) Bun.sleepSync(2)`,
      `const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, Number(process.argv.at(-1))])`,
      `const landed = landAssetBytes(${JSON.stringify(dir)}, 'public', bytes, 'race.png')`,
      `process.stdout.write(JSON.stringify(landed))`,
    ].join('\n')
    const repoRoot = path.resolve(import.meta.dir, '../../..')
    const procs = Array.from({ length: workers }, (_, i) =>
      Bun.spawn(['bun', '-e', script, '--', String(i + 1)], { cwd: repoRoot, stdout: 'pipe', stderr: 'pipe' }),
    )
    // Let every process reach the barrier, then release them together.
    await Bun.sleep(1500)
    fs.writeFileSync(goFile, '')
    const results = await Promise.all(
      procs.map(async (proc) => JSON.parse(await new Response(proc.stdout).text()) as { ok: boolean; relPath: string }),
    )

    expect(results.every((result) => result.ok)).toBe(true)
    expect(new Set(results.map((result) => result.relPath)).size).toBe(workers)
    const lastBytes = fs
      .readdirSync(path.join(dir, 'public'))
      .map((name) => fs.readFileSync(path.join(dir, 'public', name)).at(-1))
      .sort()
    expect(lastBytes).toEqual([1, 2, 3, 4, 5, 6])
  }, 30_000)
})

describe('landAssetBytes — intrinsic size', () => {
  it('reports width and height read from the header of what landed', () => {
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0x02, 0x80, 0, 0, 0x01, 0xe0,
      8, 6, 0, 0, 0,
    ])
    expect(landAssetBytes(dir, 'public', png, 'hero.png')).toMatchObject({ width: 640, height: 480 })
  })

  it('reads an SVG size from the sanitized markup', () => {
    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 16"><rect width="1" height="1"/></svg>',
    )
    expect(landAssetBytes(dir, 'public', svg, 'icon.svg')).toMatchObject({ width: 24, height: 16 })
  })
})
