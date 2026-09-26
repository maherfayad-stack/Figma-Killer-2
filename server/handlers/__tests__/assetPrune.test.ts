/**
 * P5-B3 (IMG-11) — the asset ledger and the explicit "delete unused".
 *
 * The prune is the one Studio route that deletes a file a drop created, so
 * nearly every test here is a file it must NOT delete:
 *
 *  - a file Studio did not land (not in the ledger), whatever it is named;
 *  - a ledger file something still references (a page, a stylesheet, a loose
 *    canvas layer outside the workspace walk);
 *  - a ledger file the user has since overwritten (hash changed);
 *  - a ledger entry a hostile repository wrote: a source file, a traversal, a
 *    symlink out of the project;
 *  - anything the request did not name.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { landAssetBytes } from '../studio/assetLanding'
import { ASSET_LEDGER_REL, findUnusedLedgerAssets, readAssetLedger, sha256Hex, writeAssetLedger } from '../studio/assetLedger'
import { pruneUnusedAssets, tryServeStudioAssetLedger } from '../studio/assetPrune'
import { createStudioRouteTestHarness, type StudioRouteTestHarness } from './helpers/studioRouteHarness'

let tmpDir: string

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const OTHER_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 7])

function write(rel: string, contents: string | Uint8Array): void {
  const full = path.join(tmpDir, ...rel.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents)
}

const exists = (rel: string) => fs.existsSync(path.join(tmpDir, ...rel.split('/')))

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-asset-prune-'))
  write('package.json', JSON.stringify({ name: 'app', devDependencies: { vite: '^5.0.0' } }))
  write('src/App.tsx', 'export default function App() { return <main /> }\n')
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function land(name: string, bytes: Uint8Array = PNG): string {
  const landed = landAssetBytes(tmpDir, 'public', bytes, name)
  if (!landed.ok) throw new Error(landed.error)
  return landed.relPath
}

describe('the ledger', () => {
  it('records every file a landing CREATES, with its hash', () => {
    const rel = land('hero.png')
    expect(readAssetLedger(tmpDir)).toEqual([{ relPath: rel, sha256: sha256Hex(PNG), landedAt: expect.any(String) }])
    expect(exists(ASSET_LEDGER_REL)).toBe(true)
  })

  it('records nothing for a dedupe onto a file Studio did not create', () => {
    write('public/mine.png', PNG)
    const landed = landAssetBytes(tmpDir, 'public', PNG, 'dropped.png')
    expect(landed.ok && landed.deduped).toBe(true)
    expect(readAssetLedger(tmpDir)).toEqual([])
  })
})

describe('findUnusedLedgerAssets', () => {
  it('offers a landed image nothing references', () => {
    const rel = land('orphan.png')
    expect(findUnusedLedgerAssets(tmpDir)).toEqual({ unused: [{ relPath: rel, bytes: PNG.length }], incomplete: false })
  })

  it('keeps an image a page, a stylesheet or a loose canvas layer references', () => {
    land('in-page.png')
    land('in-css.png', OTHER_PNG)
    land('in-layer.png', new Uint8Array([...PNG, 1]))
    write('src/Home.tsx', 'export default () => <img src="/in-page.png" />\n')
    write('src/app.css', '.hero { background: url(/in-css.png) }\n')
    // `.studio/` is outside the workspace walk, but loose layers live there.
    write('.studio/canvas/clabcdefghij.tsx', 'export default () => <img src="/in-layer.png" />\n')
    expect(findUnusedLedgerAssets(tmpDir).unused).toEqual([])
  })
})

describe('pruneUnusedAssets — deletes only what it may', () => {
  it('deletes a confirmed unused image and forgets it', () => {
    const rel = land('orphan.png')
    expect(pruneUnusedAssets(tmpDir, [rel])).toEqual({ deleted: [rel], kept: [] })
    expect(exists(rel)).toBe(false)
    expect(readAssetLedger(tmpDir)).toEqual([])
  })

  it('never deletes a file Studio did not land, even when asked by name', () => {
    write('public/users-own.png', PNG)
    const result = pruneUnusedAssets(tmpDir, ['public/users-own.png'])
    expect(result).toEqual({ deleted: [], kept: [{ relPath: 'public/users-own.png', reason: expect.any(String) }] })
    expect(exists('public/users-own.png')).toBe(true)
  })

  it('never deletes a referenced file, re-checked at delete time', () => {
    const rel = land('hero.png')
    // Referenced AFTER the report the user saw — the prune scans again.
    write('src/Home.tsx', 'export default () => <img src="/hero.png" />\n')
    expect(pruneUnusedAssets(tmpDir, [rel])).toMatchObject({ deleted: [] })
    expect(exists(rel)).toBe(true)
  })

  it('never deletes a file the user has since overwritten', () => {
    const rel = land('hero.png')
    write(rel, OTHER_PNG)
    expect(pruneUnusedAssets(tmpDir, [rel])).toMatchObject({ deleted: [] })
    expect(exists(rel)).toBe(true)
  })

  it('never deletes what the request did not name', () => {
    const a = land('a.png')
    const b = land('b.png', OTHER_PNG)
    pruneUnusedAssets(tmpDir, [a])
    expect(exists(b)).toBe(true)
  })

  it('refuses a hand-written ledger naming source, a traversal, or an excluded dir', () => {
    const appSource = fs.readFileSync(path.join(tmpDir, 'src', 'App.tsx'))
    write('node_modules/pkg/logo.png', PNG)
    writeAssetLedger(tmpDir, [
      { relPath: 'src/App.tsx', sha256: sha256Hex(appSource), landedAt: '2026-01-01T00:00:00.000Z' },
      { relPath: '../outside.png', sha256: sha256Hex(PNG), landedAt: '2026-01-01T00:00:00.000Z' },
      { relPath: 'node_modules/pkg/logo.png', sha256: sha256Hex(PNG), landedAt: '2026-01-01T00:00:00.000Z' },
    ])
    expect(findUnusedLedgerAssets(tmpDir).unused).toEqual([])
    const result = pruneUnusedAssets(tmpDir, ['src/App.tsx', '../outside.png', 'node_modules/pkg/logo.png'])
    expect(result).toMatchObject({ deleted: [] })
    expect(exists('src/App.tsx')).toBe(true)
    expect(exists('node_modules/pkg/logo.png')).toBe(true)
  })

  it('refuses a ledger entry whose path is a symlink out of the project', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-asset-prune-outside-'))
    try {
      fs.writeFileSync(path.join(outside, 'victim.png'), PNG)
      fs.mkdirSync(path.join(tmpDir, 'public'), { recursive: true })
      try {
        fs.symlinkSync(path.join(outside, 'victim.png'), path.join(tmpDir, 'public', 'link.png'))
      } catch {
        return // this platform cannot create a symlink without privileges; nothing to test
      }
      writeAssetLedger(tmpDir, [{ relPath: 'public/link.png', sha256: sha256Hex(PNG), landedAt: '2026-01-01T00:00:00.000Z' }])
      expect(pruneUnusedAssets(tmpDir, ['public/link.png'])).toMatchObject({ deleted: [] })
      expect(fs.existsSync(path.join(outside, 'victim.png'))).toBe(true)
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe('the routes', () => {
  const serve = (req: Request) =>
    tryServeStudioAssetLedger(req, new URL(req.url), new URL(req.url).pathname, { resolveDir: () => tmpDir })

  it('GET asset-ledger reports the unused images', async () => {
    const rel = land('orphan.png')
    const res = await serve(new Request('http://localhost/admin/api/studio/asset-ledger'))
    expect(await res!.json()).toEqual({ unused: [{ relPath: rel, bytes: PNG.length }], incomplete: false })
  })

  it('POST asset-prune deletes the confirmed files', async () => {
    const rel = land('orphan.png')
    const res = await serve(
      new Request('http://localhost/admin/api/studio/asset-prune', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ relPaths: [rel] }),
      }),
    )
    expect(await res!.json()).toEqual({ deleted: [rel], kept: [] })
    expect(exists(rel)).toBe(false)
  })

  it('POST asset-prune refuses an empty or malformed list', async () => {
    const res = await serve(
      new Request('http://localhost/admin/api/studio/asset-prune', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ relPaths: [] }),
      }),
    )
    expect(res!.status).toBe(400)
  })

  describe('authorization (the gate)', () => {
    let routes: StudioRouteTestHarness
    beforeAll(async () => {
      routes = await createStudioRouteTestHarness()
    })
    afterAll(async () => {
      await routes.cleanup()
    })

    it('refuses a forged cross-origin prune, and deletes nothing', async () => {
      const rel = land('orphan.png')
      const req = new Request('http://localhost/admin/api/studio/asset-prune', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ relPaths: [rel], dir: tmpDir }),
      })
      req.headers.set('origin', 'https://evil.test')
      const res = await routes.serve(req, new URL(req.url))
      expect(res!.status).toBe(403)
      expect(exists(rel)).toBe(true)
    })

    it('refuses an anonymous prune', async () => {
      const rel = land('orphan.png')
      const req = new Request('http://localhost/admin/api/studio/asset-prune', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ relPaths: [rel], dir: tmpDir }),
      })
      const res = await routes.serveAnonymous(req, new URL(req.url))
      expect(res!.status).toBe(401)
      expect(exists(rel)).toBe(true)
    })
  })
})
