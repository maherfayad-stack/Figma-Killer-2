/**
 * P5-B3 (IMG-10) — the server half of an insert's image import: the browser
 * names a workspace FILE, the server guards the path and spells the specifier
 * from the file being written. A path that is not a contained, existing
 * project file refuses the whole write; a Next.js project refuses an import
 * outright (an imported image is `StaticImageData` there).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { resolveInsertAssetImports } from '../studioInsertAssetImports'

let tmpDir: string

function write(rel: string, contents: string): void {
  const full = path.join(tmpDir, ...rel.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents)
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-insert-asset-'))
  write('package.json', JSON.stringify({ name: 'app', devDependencies: { vite: '^5.0.0' } }))
  write('vite.config.ts', 'export default {}\n')
  write('src/assets/hero.png', 'png')
  write('src/pages/Home.tsx', 'export default () => <main />\n')
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('resolveInsertAssetImports', () => {
  it('re-spells a workspace path as the specifier the written file imports it by — root, children and siblings', () => {
    const result = resolveInsertAssetImports(tmpDir, 'src/pages/Home.tsx', {
      props: { src: { __assetImport: 'src/assets/hero.png' }, alt: 'hero' },
      children: [{ name: 'img', props: { src: { __assetImport: 'src/assets/hero.png' } } }],
      siblings: [{ name: 'img', props: { src: { __assetImport: 'src/assets/hero.png' } } }],
    })
    expect(result).toEqual({
      ok: true,
      value: {
        props: { src: { __assetImport: '../assets/hero.png' }, alt: 'hero' },
        children: [{ name: 'img', props: { src: { __assetImport: '../assets/hero.png' } } }],
        siblings: [{ name: 'img', props: { src: { __assetImport: '../assets/hero.png' } } }],
      },
    })
  })

  it('leaves an edit with no image import exactly as it was', () => {
    const edit = { props: { src: '/hero.png' } }
    expect(resolveInsertAssetImports(tmpDir, 'src/pages/Home.tsx', edit)).toEqual({ ok: true, value: edit })
  })

  for (const hostile of ['../outside.png', '/etc/passwd', 'src/assets/missing.png', 'node_modules/x/a.png', '.studio/references/a.png']) {
    it(`refuses ${JSON.stringify(hostile)}`, () => {
      const result = resolveInsertAssetImports(tmpDir, 'src/pages/Home.tsx', { props: { src: { __assetImport: hostile } } })
      expect(result.ok).toBe(false)
    })
  }

  it('refuses any image import in a Next.js project, with the remedy', () => {
    write('package.json', JSON.stringify({ name: 'app', dependencies: { next: '^14.0.0', react: '^18.0.0' } }))
    write('next.config.js', 'module.exports = {}\n')
    write('app/page.tsx', 'export default () => <main />\n')
    fs.rmSync(path.join(tmpDir, 'vite.config.ts'))
    fs.rmSync(path.join(tmpDir, '.studio'), { recursive: true, force: true })
    const result = resolveInsertAssetImports(tmpDir, 'app/page.tsx', { props: { src: { __assetImport: 'src/assets/hero.png' } } })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('public/')
  })
})
