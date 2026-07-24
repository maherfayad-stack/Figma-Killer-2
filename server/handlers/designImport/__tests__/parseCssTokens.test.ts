import { describe, expect, it } from 'bun:test'
import {
  buildTokenCandidates,
  classifyToken,
  convertLengthToPx,
  extractJsonTokens,
  extractJsTokens,
  extractRootCustomProperties,
} from '../parseCssTokens'
import { isCandidateTokenFile } from '../shared'

describe('extractRootCustomProperties', () => {
  it('extracts every --name: value; pair from a :root block', () => {
    const css = `:root {\n  --brand-500: #4f46e5;\n  --space-md: 1rem;\n}`
    const vars = extractRootCustomProperties(css, 'a.css')
    expect(vars).toEqual([
      { name: 'brand-500', value: '#4f46e5', file: 'a.css' },
      { name: 'space-md', value: '1rem', file: 'a.css' },
    ])
  })

  it('finds a :root nested inside a @media wrapper, with correct brace matching', () => {
    const css = `@media (prefers-color-scheme: dark) {\n  :root {\n    --bg: #000;\n  }\n}`
    const vars = extractRootCustomProperties(css, 'a.css')
    expect(vars).toEqual([{ name: 'bg', value: '#000', file: 'a.css' }])
  })

  it('matches a compound selector containing :root (e.g. :root, [data-theme])', () => {
    const css = `:root, [data-theme='dark'] {\n  --fg: #111;\n}`
    const vars = extractRootCustomProperties(css, 'a.css')
    expect(vars).toEqual([{ name: 'fg', value: '#111', file: 'a.css' }])
  })

  it('ignores custom properties declared in a non-:root rule', () => {
    const css = `.card {\n  --local: #fff;\n}\n:root {\n  --global: #000;\n}`
    const vars = extractRootCustomProperties(css, 'a.css')
    expect(vars).toEqual([{ name: 'global', value: '#000', file: 'a.css' }])
  })

  it('ignores a :root inside a block comment', () => {
    const css = `/* :root { --fake: red; } */\n:root {\n  --real: blue;\n}`
    const vars = extractRootCustomProperties(css, 'a.css')
    expect(vars).toEqual([{ name: 'real', value: 'blue', file: 'a.css' }])
  })

  it('returns an empty list when there is no :root block', () => {
    expect(extractRootCustomProperties('.card { color: red; }', 'a.css')).toEqual([])
  })

  it('extracts from :where(html) — the low-specificity host pattern real packages (e.g. open-props) use instead of :root', () => {
    const css = `:where(html) {\n  --brand-500: #4f46e5;\n}`
    expect(extractRootCustomProperties(css, 'a.css')).toEqual([{ name: 'brand-500', value: '#4f46e5', file: 'a.css' }])
  })

  it('extracts from a bare html selector', () => {
    const css = `html {\n  --x: 1px;\n}`
    expect(extractRootCustomProperties(css, 'a.css')).toEqual([{ name: 'x', value: '1px', file: 'a.css' }])
  })

  it('extracts from :is(:root)', () => {
    const css = `:is(:root) {\n  --y: 2px;\n}`
    expect(extractRootCustomProperties(css, 'a.css')).toEqual([{ name: 'y', value: '2px', file: 'a.css' }])
  })

  it('does NOT false-positive on a class whose name merely contains "html" (e.g. .html-embed)', () => {
    const css = `.html-embed {\n  --local: #fff;\n}`
    expect(extractRootCustomProperties(css, 'a.css')).toEqual([])
  })
})

describe('convertLengthToPx', () => {
  it('passes px through unchanged', () => {
    expect(convertLengthToPx('16px')).toBe(16)
  })

  it('converts rem/em against the standard 16px browser default', () => {
    expect(convertLengthToPx('1rem')).toBe(16)
    expect(convertLengthToPx('1.25rem')).toBe(20)
    expect(convertLengthToPx('0.5em')).toBe(8)
  })

  it('converts pt using the standard 96/72 ratio', () => {
    expect(convertLengthToPx('12pt')).toBeCloseTo(16, 5)
  })

  it('returns null for context-dependent units (%, vh, vw, ch)', () => {
    expect(convertLengthToPx('100%')).toBeNull()
    expect(convertLengthToPx('50vh')).toBeNull()
    expect(convertLengthToPx('2ch')).toBeNull()
  })

  it('returns null for a non-length value', () => {
    expect(convertLengthToPx('#4f46e5')).toBeNull()
    expect(convertLengthToPx('var(--x)')).toBeNull()
  })
})

describe('classifyToken', () => {
  it('classifies a hex/rgb/hsl value as color regardless of name', () => {
    expect(classifyToken('brand-500', '#4f46e5')).toBe('color')
    expect(classifyToken('x', 'rgba(0, 0, 0, 0.5)')).toBe('color')
    expect(classifyToken('y', 'hsl(220 80% 50%)')).toBe('color')
  })

  it('classifies by a color-ish name hint even when the value is a reference', () => {
    expect(classifyToken('brand-color', 'var(--gray-900)')).toBe('color')
  })

  it('classifies a font/text-hinted convertible length as typography', () => {
    expect(classifyToken('font-size-lg', '1.25rem')).toBe('typography')
    expect(classifyToken('text-sm', '14px')).toBe('typography')
  })

  it('classifies a spacing-hinted convertible length as spacing', () => {
    expect(classifyToken('space-md', '1rem')).toBe('spacing')
    expect(classifyToken('gap-lg', '24px')).toBe('spacing')
  })

  it('falls back to spacing for a bare convertible length with no name hint', () => {
    expect(classifyToken('foo', '8px')).toBe('spacing')
  })

  it('classifies a font/spacing-hinted non-convertible value as other', () => {
    expect(classifyToken('font-size-lg', '100%')).toBe('other')
    expect(classifyToken('space-md', 'auto')).toBe('other')
  })

  it('classifies an unrecognized name + unconvertible value as other', () => {
    expect(classifyToken('foo', 'auto')).toBe('other')
  })
})

describe('extractJsonTokens', () => {
  it('extracts a nested plain-value JSON object, using dot-joined paths as names', () => {
    const json = { colors: { brand: { 500: '#4f46e5' } }, space: { md: '1rem' } }
    const vars = extractJsonTokens(json, 'tokens.json')
    expect(vars).toEqual(
      expect.arrayContaining([
        { name: 'colors.brand.500', value: '#4f46e5', file: 'tokens.json' },
        { name: 'space.md', value: '1rem', file: 'tokens.json' },
      ]),
    )
  })

  it('extracts a DTCG-style {value, type} leaf, folding type into the name', () => {
    const json = { brand500: { value: '#4f46e5', type: 'color' } }
    const vars = extractJsonTokens(json, 'tokens.json')
    expect(vars).toEqual([{ name: 'color brand500', value: '#4f46e5', file: 'tokens.json' }])
  })

  it('ignores arrays and returns nothing for a bare top-level scalar', () => {
    expect(extractJsonTokens(['a', 'b'], 'x.json')).toEqual([])
    expect(extractJsonTokens('bare-string', 'x.json')).toEqual([])
  })

  it('returns an empty list for an empty object', () => {
    expect(extractJsonTokens({}, 'x.json')).toEqual([])
  })
})

describe('extractJsTokens', () => {
  it('extracts key: "string" pairs from a plain object literal', () => {
    const source = `export const colors = {\n  brand500: '#4f46e5',\n  "brand-100": "#eef2ff",\n}`
    const vars = extractJsTokens(source, 'tokens.ts')
    expect(vars).toEqual(
      expect.arrayContaining([
        { name: 'brand500', value: '#4f46e5', file: 'tokens.ts' },
        { name: 'brand-100', value: '#eef2ff', file: 'tokens.ts' },
      ]),
    )
  })

  it('ignores a commented-out entry', () => {
    const source = `const x = {\n  // fake: 'red',\n  real: 'blue',\n}`
    const vars = extractJsTokens(source, 'a.ts')
    expect(vars).toEqual([{ name: 'real', value: 'blue', file: 'a.ts' }])
  })

  it('does not extract non-string (numeric) values', () => {
    const source = `const x = { count: 5, name: 'ok' }`
    const vars = extractJsTokens(source, 'a.ts')
    expect(vars.map((v) => v.name)).toEqual(['name'])
  })
})

describe('isCandidateTokenFile', () => {
  it('accepts a file whose name contains "token"', () => {
    expect(isCandidateTokenFile('src/tokens.json')).toBe(true)
    expect(isCandidateTokenFile('design-tokens.ts')).toBe(true)
    expect(isCandidateTokenFile('colorTokens.js')).toBe(true)
  })

  it('accepts the conventional theme.json name', () => {
    expect(isCandidateTokenFile('theme.json')).toBe(true)
  })

  it('rejects a token-named file with a non-source extension', () => {
    expect(isCandidateTokenFile('tokens.md')).toBe(false)
  })

  it('rejects an ordinary, non-token-named JSON/TS file', () => {
    expect(isCandidateTokenFile('package.json')).toBe(false)
    expect(isCandidateTokenFile('src/App.tsx')).toBe(false)
    expect(isCandidateTokenFile('tsconfig.json')).toBe(false)
  })
})

describe('buildTokenCandidates', () => {
  it('classifies across multiple files and de-dupes by name, last file wins', () => {
    const files = [
      { relPath: 'a.css', contents: ':root { --brand-500: #111; --space-md: 1rem; --weird: banana; }' },
      { relPath: 'b.css', contents: ':root { --brand-500: #222; --font-lg: 1.25rem; }' },
    ]
    const result = buildTokenCandidates(files)

    expect(result.colors).toHaveLength(1)
    expect(result.colors[0]).toMatchObject({ name: 'brand-500', value: '#222', file: 'b.css' })

    expect(result.spacing).toHaveLength(1)
    expect(result.spacing[0]).toMatchObject({ name: 'space-md', value: '1rem', px: 16, file: 'a.css' })

    expect(result.typography).toHaveLength(1)
    expect(result.typography[0]).toMatchObject({ name: 'font-lg', value: '1.25rem', px: 20, file: 'b.css' })

    expect(result.otherCount).toBe(1) // --weird: banana
  })

  it('returns empty candidate lists for CSS with no :root declarations', () => {
    const result = buildTokenCandidates([{ relPath: 'a.css', contents: '.card { color: red; }' }])
    expect(result).toEqual({ colors: [], typography: [], spacing: [], otherCount: 0 })
  })

  it('combines CSS files with JSON + JS token files into one candidate set', () => {
    const cssFiles = [{ relPath: 'a.css', contents: ':root { --brand-500: #111; }' }]
    const tokenFiles = [
      { relPath: 'tokens.json', contents: JSON.stringify({ 'space-md': '1rem' }) },
      { relPath: 'tokens.ts', contents: `export const t = { fontLg: '1.25rem' }` },
      { relPath: 'broken-tokens.json', contents: 'not valid json {' },
    ]
    const result = buildTokenCandidates(cssFiles, tokenFiles)

    expect(result.colors.map((c) => c.name)).toEqual(['brand-500'])
    expect(result.spacing.map((c) => c.name)).toEqual(['space-md'])
    expect(result.typography.map((c) => c.name)).toEqual(['fontLg'])
  })
})
