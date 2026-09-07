/**
 * studioFramework — `.studio/framework.json` read/write round trip.
 * Driven against a temp fixture dir, same pattern as `studio.test.ts`'s
 * `listStudioProjects`/`POST /admin/api/studio/page` suites.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { readStudioFontsFile, readStudioFrameworkFile, writeStudioFontsFile, writeStudioFrameworkFile } from '../studioFramework'
import type { SiteFontsSettings } from '@core/fonts'
import type { FrameworkSettings } from '@core/framework-schema'

const VALID_FRAMEWORK: FrameworkSettings = { colors: { tokens: [] } }

/**
 * `font-revert` — one installed Google family, the shape `installCmsGoogleFont`
 * returns and `addFont` commits into `site.settings.fonts`.
 */
const VALID_FONTS: SiteFontsSettings = {
  items: [{
    id: 'font-inter',
    source: 'google',
    family: 'Inter',
    variants: ['400'],
    subsets: ['latin'],
    files: [{ variant: '400', subset: 'latin', path: '/uploads/fonts/inter/400.woff2', format: 'woff2' }],
    createdAt: 0,
    updatedAt: 0,
  }],
  tokens: [{
    id: 'tok-font-primary',
    name: 'Primary',
    variable: 'font-primary',
    familyId: 'font-inter',
    fallback: 'sans-serif',
    order: 0,
    createdAt: 0,
    updatedAt: 0,
  }],
}

describe('studioFramework', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-framework-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns null when no framework.json exists yet', () => {
    expect(readStudioFrameworkFile(tmpDir)).toBeNull()
  })

  it('writes a valid framework and reads it back unchanged', () => {
    const written = writeStudioFrameworkFile(tmpDir, VALID_FRAMEWORK)
    expect(written).toMatchObject({ ok: true })

    const read = readStudioFrameworkFile(tmpDir)
    expect(read).toEqual(VALID_FRAMEWORK)

    // Written to the expected sidecar path.
    expect(fs.existsSync(path.join(tmpDir, '.studio', 'framework.json'))).toBe(true)
  })

  it('rejects an invalid shape on write (missing required colors field)', () => {
    const result = writeStudioFrameworkFile(tmpDir, { typography: undefined })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message.length).toBeGreaterThan(0)
    // Nothing was written.
    expect(fs.existsSync(path.join(tmpDir, '.studio', 'framework.json'))).toBe(false)
  })

  it('overwrites a previous valid write with a new one', () => {
    writeStudioFrameworkFile(tmpDir, VALID_FRAMEWORK)
    const updated: FrameworkSettings = {
      colors: {
        tokens: [
          {
            id: 't1', category: 'brand', slug: 'brand-500', lightValue: '#4f46e5', darkValue: '#4f46e5',
            darkModeEnabled: false,
            generateUtilities: { text: true, background: true, border: true, fill: false },
            generateTransparent: false,
            generateShades: { enabled: false, count: 5 },
            generateTints: { enabled: false, count: 5 },
            order: 0, createdAt: 0, updatedAt: 0,
          },
        ],
      },
    }
    writeStudioFrameworkFile(tmpDir, updated)

    const read = readStudioFrameworkFile(tmpDir)
    expect(read?.colors.tokens).toHaveLength(1)
    expect(read?.colors.tokens[0].slug).toBe('brand-500')
  })

  it('returns null (soft-fallback) for a corrupted framework.json already on disk', () => {
    const file = path.join(tmpDir, '.studio', 'framework.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, 'not valid json {{{')

    expect(readStudioFrameworkFile(tmpDir)).toBeNull()
  })

  it('returns null (soft-fallback) for well-formed JSON that does not match the schema', () => {
    const file = path.join(tmpDir, '.studio', 'framework.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ nope: true }))

    expect(readStudioFrameworkFile(tmpDir)).toBeNull()
  })
})

/**
 * `.studio/fonts.json` — the sidecar that closes the "installing a font does
 * nothing" half of the font-family revert report. Before it, the installed
 * library lived in `site.settings.fonts` in memory only: no schema field on
 * `FrameworkSettings`, no write in `saveSite`, no read in `loadSite`. The
 * binaries landed under `uploads/fonts/` and the entry pointing at them died
 * with the tab.
 */
describe('studioFonts sidecar', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-fonts-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns null when no fonts.json exists yet', () => {
    expect(readStudioFontsFile(tmpDir)).toBeNull()
  })

  it('writes a library and reads it back unchanged', () => {
    expect(writeStudioFontsFile(tmpDir, VALID_FONTS)).toMatchObject({ ok: true })
    expect(readStudioFontsFile(tmpDir)).toEqual(VALID_FONTS)
    expect(fs.existsSync(path.join(tmpDir, '.studio', 'fonts.json'))).toBe(true)
  })

  it('lives BESIDE framework.json, not inside it — two SiteSettings fields, two files', () => {
    writeStudioFrameworkFile(tmpDir, VALID_FRAMEWORK)
    writeStudioFontsFile(tmpDir, VALID_FONTS)
    expect(readStudioFrameworkFile(tmpDir)).toEqual(VALID_FRAMEWORK)
    expect(readStudioFontsFile(tmpDir)).toEqual(VALID_FONTS)
  })

  it('rejects an invalid shape on write', () => {
    const result = writeStudioFontsFile(tmpDir, { items: 'not-an-array' })
    expect(result.ok).toBe(false)
    expect(fs.existsSync(path.join(tmpDir, '.studio', 'fonts.json'))).toBe(false)
  })

  it('drops ONE malformed entry on read rather than throwing the library away', () => {
    const file = path.join(tmpDir, '.studio', 'fonts.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ items: [VALID_FONTS.items[0], { id: 'broken' }] }))
    expect(readStudioFontsFile(tmpDir)?.items.map((f) => f.family)).toEqual(['Inter'])
  })

  it('returns null (soft fallback) for a corrupted file', () => {
    const file = path.join(tmpDir, '.studio', 'fonts.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '{ not json')
    expect(readStudioFontsFile(tmpDir)).toBeNull()
  })
})
