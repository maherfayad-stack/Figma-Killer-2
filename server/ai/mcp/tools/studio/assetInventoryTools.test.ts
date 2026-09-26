/**
 * studio_list_assets / studio_list_fonts — the project's own inventory
 * (P4-E, AI-20). Real files on disk, no network.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ToolContext } from '../../../runtime/types'
import { googleFontImportLine, searchGoogleFonts, studioAssetInventoryMcpTools } from './assetInventoryTools'
import { IMAGE_CREDITS_FILE } from './imageCredits'

const listAssets = studioAssetInventoryMcpTools.find((tool) => tool.name === 'studio_list_assets')!
const listFonts = studioAssetInventoryMcpTools.find((tool) => tool.name === 'studio_list_fonts')!

/** A 3x2 PNG header — enough for `readImageDimensions`. */
function png(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0)
  bytes.writeUInt32BE(13, 8)
  bytes.write('IHDR', 12, 'ascii')
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes
}

function ctx(): ToolContext {
  return { db: {} as never, userId: 'u1', capabilities: [], conversationId: 'c1', snapshot: null, signal: new AbortController().signal }
}

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-inventory-'))
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture', dependencies: { react: '^19.0.0' } }))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function write(rel: string, content: string | Buffer): void {
  const abs = path.join(dir, ...rel.split('/'))
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
}

describe('both are ungated reads with short descriptions', () => {
  for (const tool of studioAssetInventoryMcpTools) {
    it(tool.name, () => {
      expect(tool.requiresWrite ?? false).toBe(false)
      expect(tool.sideEffects).toBe('none')
      expect(tool.requiredCapabilities).toEqual([])
      expect(tool.description.length).toBeLessThanOrEqual(900)
    })
  }
})

describe('studio_list_assets', () => {
  it('lists images with their site URL, size and stock credit, and skips Studio\'s own shell', async () => {
    write('src/assets/hero.png', png(1200, 800))
    write('public/logo.png', png(64, 64))
    write('prototype/shell.png', png(1, 1))
    write('src/App.tsx', 'export {}')
    write(IMAGE_CREDITS_FILE, '# Image credits\n\n- `src/assets/hero.png` — Photo by Jo on Pexels · Pexels License (https://www.pexels.com/license/)\n')
    const result = (await listAssets.handler!({ dir }, ctx())) as { total: number; assets: Array<Record<string, unknown>>; nextOffset: number | null }
    expect(result.total).toBe(2)
    expect(result.nextOffset).toBeNull()
    const hero = result.assets.find((asset) => asset.relPath === 'src/assets/hero.png')!
    expect(hero).toMatchObject({ width: 1200, height: 800, buildSafe: false, src: '/src/assets/hero.png' })
    expect(String(hero.credit)).toContain('Photo by Jo')
    const logo = result.assets.find((asset) => asset.relPath === 'public/logo.png')!
    expect(logo).toMatchObject({ src: '/logo.png', buildSafe: true, width: 64 })
    expect(logo.credit).toBeUndefined()
  })

  it('filters and pages', async () => {
    for (let i = 0; i < 5; i++) write(`src/assets/card-${i}.png`, png(10, 10))
    write('src/assets/hero.png', png(10, 10))
    const first = (await listAssets.handler!({ dir, query: 'CARD', limit: 2 }, ctx())) as { total: number; assets: unknown[]; nextOffset: number | null }
    expect(first.total).toBe(5)
    expect(first.assets).toHaveLength(2)
    expect(first.nextOffset).toBe(2)
    const last = (await listAssets.handler!({ dir, query: 'card', offset: 4, limit: 2 }, ctx())) as { assets: unknown[]; nextOffset: number | null }
    expect(last.assets).toHaveLength(1)
    expect(last.nextOffset).toBeNull()
  })

  it('an empty project says so', async () => {
    const result = (await listAssets.handler!({ dir }, ctx())) as { message: string }
    expect(result.message).toContain('no image files')
  })
})

describe('studio_list_fonts', () => {
  it('reports each loaded family with how it is loaded, and the font tokens', async () => {
    write('index.html', '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap" rel="stylesheet">')
    write('src/styles/global.css', ':root { --font-body: "Inter", system-ui, sans-serif; --font-size-body: 16px; }\n@font-face { font-family: "Brand Sans"; src: url(/fonts/brand.woff2); }')
    write('public/fonts/BrandSans-Bold.woff2', 'x')
    const result = (await listFonts.handler!({ dir }, ctx())) as {
      families: Array<{ family: string; via: string[] }>
      fontFiles: string[]
      fontTokens: Array<{ name: string; value: string }>
    }
    const inter = result.families.find((family) => family.family === 'Inter')
    expect(inter?.via).toContain('google-fonts')
    expect(result.fontFiles).toContain('public/fonts/BrandSans-Bold.woff2')
    expect(result.families.some((family) => family.via.includes('font-file'))).toBe(true)
    expect(result.families.some((family) => family.family === 'sans-serif')).toBe(false)
  })

  it('with query, searches Google Fonts and returns the line that adds one', async () => {
    const result = (await listFonts.handler!({ dir, query: 'playfair display', limit: 3 }, ctx())) as { google: Array<{ family: string; import: string }>; howToAdd: string }
    expect(result.google[0]!.family).toBe('Playfair Display')
    expect(result.google[0]!.import).toMatch(/^@import url\('https:\/\/fonts\.googleapis\.com\/css2\?family=Playfair\+Display:wght@400;500;600;700&display=swap'\);$/)
    expect(result.howToAdd).toContain('top of the project')
  })

  it('a category finds popular families of exactly that kind', () => {
    const serif = searchGoogleFonts('serif', 5)
    expect(serif.length).toBe(5)
    expect(serif.every((family) => family.category === 'Serif')).toBe(true)
  })

  it('asks only for weights the family has', () => {
    expect(googleFontImportLine({ family: 'Solo', category: 'Display', subsets: [], variants: ['400'], popularity: 1 })).toBe("@import url('https://fonts.googleapis.com/css2?family=Solo&display=swap');")
    expect(googleFontImportLine({ family: 'Thin Only', category: 'Display', subsets: [], variants: ['100', '200'], popularity: 1 })).toBe("@import url('https://fonts.googleapis.com/css2?family=Thin+Only:wght@100;200&display=swap');")
  })
})
