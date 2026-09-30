/**
 * projectAssets — the READ side of the inspector's image-fill picker.
 *
 * `listProjectImageAssets` is tested directly against a real temp workspace
 * (the route itself is a three-line shell over it plus `resolveProjectDir`,
 * which every other studio route's tests already cover). What matters here is
 * what the picker is allowed to OFFER: images the user owns, and nothing from
 * `node_modules`, `.git`, `dist`, `.studio`, or Studio's own `prototype/`
 * scaffold — offering any of those would put something that is not the user's
 * design asset into the user's stylesheet.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describeProjectImageAssets, listProjectImageAssets, tryServeStudioProjectAssets } from '../studio/projectAssets'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-project-assets-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function writeFile(rel: string, contents = 'x'): void {
  const abs = path.join(tmpDir, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, contents)
}

describe('listProjectImageAssets', () => {
  it('lists the project\'s own images, sorted, workspace-relative', () => {
    writeFile('public/hero.png')
    writeFile('src/assets/EN-2.png')
    writeFile('assets/logo.svg')

    expect(listProjectImageAssets(tmpDir)).toEqual([
      'assets/logo.svg',
      'public/hero.png',
      'src/assets/EN-2.png',
    ])
  })

  it('offers only the formats the upload path is willing to write (plus .jpeg)', () => {
    writeFile('a.png')
    writeFile('b.JPG')
    writeFile('c.jpeg')
    writeFile('d.webp')
    writeFile('e.avif')
    writeFile('f.gif')
    writeFile('g.svg')
    writeFile('h.tsx')
    writeFile('i.css')
    writeFile('j.mp4')
    writeFile('README')

    expect(listProjectImageAssets(tmpDir)).toEqual([
      'a.png',
      'b.JPG',
      'c.jpeg',
      'd.webp',
      'e.avif',
      'f.gif',
      'g.svg',
    ])
  })

  it('never offers a dependency, build output, or editor-owned file', () => {
    writeFile('node_modules/pkg/icon.png')
    writeFile('dist/bundled.png')
    writeFile('.git/thumb.png')
    writeFile('.studio/references/ref.png')
    writeFile('keep.png')

    expect(listProjectImageAssets(tmpDir)).toEqual(['keep.png'])
  })

  it('never offers an image from Studio\'s own preview scaffold', () => {
    writeFile('prototype/shell-logo.png')
    writeFile('keep.png')

    expect(listProjectImageAssets(tmpDir)).toEqual(['keep.png'])
  })
})

/**
 * IMG-1 — each listed image carries the URL the SERVER computed
 * (`assetSiteUrl.ts`), so the picker writes it instead of deriving one. The
 * deleted client rule joined `public` to the project dir; in a monorepo that
 * called the wrong folder build-safe.
 */
describe('describeProjectImageAssets', () => {
  it('attaches the site URL and build-safety verdict to every image', () => {
    writeFile('package.json', JSON.stringify({ name: 'app' }))
    writeFile('public/hero.png')
    writeFile('src/assets/EN-2.png')

    expect(describeProjectImageAssets(tmpDir)).toEqual([
      { relPath: 'public/hero.png', src: '/hero.png', buildSafe: true },
      { relPath: 'src/assets/EN-2.png', src: '/src/assets/EN-2.png', buildSafe: false },
    ])
  })

  it("in a monorepo, only the APP's public/ is build-safe and a file outside the app has no URL", () => {
    writeFile('web/package.json', JSON.stringify({ name: 'web' }))
    writeFile('web/public/hero.png')
    writeFile('docs/diagram.png')

    expect(describeProjectImageAssets(tmpDir)).toEqual([
      { relPath: 'docs/diagram.png', src: null, buildSafe: false },
      { relPath: 'web/public/hero.png', src: '/hero.png', buildSafe: true },
    ])
  })
})

describe('tryServeStudioProjectAssets — routing', () => {
  it('returns null for a non-matching path', async () => {
    const req = new Request('http://localhost/admin/api/studio/icons')
    expect(await tryServeStudioProjectAssets(req, new URL(req.url), '/admin/api/studio/icons')).toBeNull()
  })

  it('returns null for a matching path with the wrong method', async () => {
    const req = new Request('http://localhost/admin/api/studio/project-assets', { method: 'POST' })
    expect(
      await tryServeStudioProjectAssets(req, new URL(req.url), '/admin/api/studio/project-assets'),
    ).toBeNull()
  })
})
