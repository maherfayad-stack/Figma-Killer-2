/**
 * tokenExtractJsTheme.ts — T6 (`STUDIO-FIGMA-PARITY-PLAN.md` §11): before
 * this, `theme.ts` inside the CURRENTLY OPEN project was invisible, while
 * the identical file was already parsed when fetched from an npm package by
 * the design-import wizard.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractJsThemeTokens, findJsThemeFileCandidates } from '../tokenExtractJsTheme'

function write(root: string, relPath: string, contents: string): void {
  const full = join(root, ...relPath.split('/'))
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, contents, 'utf8')
}

describe('findJsThemeFileCandidates', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'studio-jstheme-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('finds a conventionally-named theme file in the open project', () => {
    write(dir, 'src/theme.ts', 'export const theme = {}')
    write(dir, 'src/Button.tsx', 'export function Button() { return null }')
    expect(findJsThemeFileCandidates(dir)).toEqual(['src/theme.ts'])
  })

  it('recognises tokens.ts, design-tokens.js, colors.json, palette.tsx', () => {
    write(dir, 'a/tokens.ts', '')
    write(dir, 'b/design-tokens.js', '')
    write(dir, 'c/colors.json', '{}')
    write(dir, 'd/palette.tsx', '')
    expect(findJsThemeFileCandidates(dir).sort()).toEqual(
      ['a/tokens.ts', 'b/design-tokens.js', 'c/colors.json', 'd/palette.tsx'].sort(),
    )
  })

  it('ignores an unrelated file that merely mentions "theme" mid-name', () => {
    write(dir, 'src/themeContext.ts', '')
    expect(findJsThemeFileCandidates(dir)).toEqual([])
  })

  it('never descends into node_modules — an installed package theme.ts is not the project\'s own', () => {
    write(dir, 'node_modules/some-pkg/theme.ts', 'export const theme = {}')
    expect(findJsThemeFileCandidates(dir)).toEqual([])
  })
})

describe('extractJsThemeTokens', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'studio-jstheme-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('extracts and classifies a JS/TS theme object — text-only, never executed', () => {
    write(
      dir,
      'src/theme.ts',
      `export const theme = {\n  colorBrand: '#0c9ab0',\n  spaceMd: '16px',\n}\n`,
    )
    const tokens = extractJsThemeTokens(dir, findJsThemeFileCandidates(dir))
    expect(tokens.colors).toEqual([{ name: 'colorBrand', light: '#0c9ab0' }])
    expect(tokens.spacing).toEqual([{ name: 'spaceMd', px: 16 }])
  })

  it('extracts and classifies a JSON theme file via real JSON.parse', () => {
    write(dir, 'tokens.json', JSON.stringify({ colorBrand: '#0c9ab0' }))
    const tokens = extractJsThemeTokens(dir, findJsThemeFileCandidates(dir))
    expect(tokens.colors).toEqual([{ name: 'colorBrand', light: '#0c9ab0' }])
  })

  it('skips a malformed JSON file rather than failing the whole scan', () => {
    write(dir, 'tokens.json', '{ not valid json')
    write(dir, 'theme.ts', `export const theme = { colorBrand: '#0c9ab0' }\n`)
    const tokens = extractJsThemeTokens(dir, findJsThemeFileCandidates(dir))
    expect(tokens.colors).toEqual([{ name: 'colorBrand', light: '#0c9ab0' }])
  })
})
