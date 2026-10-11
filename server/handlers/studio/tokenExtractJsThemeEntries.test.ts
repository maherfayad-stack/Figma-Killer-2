/**
 * CT-6 - the values a JavaScript theme defines, read WITHOUT running it:
 * Tailwind v3 configs (object literals, nested DEFAULT shades, tuple forms,
 * spreads, `require`, functions, imports of a token file) and standalone
 * `theme.ts` files. Every entry is read-only and says exactly why; an entry
 * read through a Tailwind config also names the classes that apply it.
 *
 * Fixtures are a bakery storefront and a plumbing-supply shop: nothing here
 * shares a name with the eSIM corpus the first token tests grew from.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { JsThemeEntry } from '@core/studio-tokens'
import { extractJsThemeEntries } from './tokenExtractJsTheme'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'js-theme-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})
function write(rel: string, text: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true })
  writeFileSync(join(dir, rel), text, 'utf8')
}
const byId = (entries: readonly JsThemeEntry[]): Record<string, JsThemeEntry> => Object.fromEntries(entries.map((entry) => [entry.id, entry]))

describe('Tailwind v3 config - object literals', () => {
  beforeEach(() => {
    write(
      'tailwind.config.js',
      [
        "/** @type {import('tailwindcss').Config} */",
        'module.exports = {',
        "  content: ['./src/**/*.{ts,tsx}'],",
        '  theme: {',
        "    fontFamily: { display: ['Fraunces', 'serif'] },",
        '    extend: {',
        '      colors: {',
        "        crust: { DEFAULT: '#c58940', dark: '#8a5a1f' },",
        "        cream: '#fff7e8',",
        '      },',
        "      spacing: { gutter: '2rem' },",
        "      fontSize: { hero: ['3rem', { lineHeight: '1.1' }] },",
        "      borderRadius: { card: '14px' },",
        '    },',
        '  },',
        '}',
        '',
      ].join('\n'),
    )
  })

  it('lists every literal with its value, family and the line it is written on', () => {
    const entries = byId(extractJsThemeEntries(dir))
    expect(entries['tailwind.config.js#colors.crust.DEFAULT']).toMatchObject({ value: '#c58940', family: 'color', line: 8, source: 'tailwind-config', group: 'colors', path: 'crust.DEFAULT' })
    expect(entries['tailwind.config.js#colors.crust.dark']).toMatchObject({ value: '#8a5a1f', line: 8 })
    expect(entries['tailwind.config.js#colors.cream']).toMatchObject({ value: '#fff7e8', line: 9 })
    expect(entries['tailwind.config.js#spacing.gutter']).toMatchObject({ value: '2rem', family: 'space' })
    expect(entries['tailwind.config.js#borderRadius.card']).toMatchObject({ value: '14px', family: 'radius' })
  })

  it('reads tuple forms as the value they carry', () => {
    const entries = byId(extractJsThemeEntries(dir))
    expect(entries['tailwind.config.js#fontSize.hero']).toMatchObject({ value: '3rem', family: 'type' })
    expect(entries['tailwind.config.js#fontFamily.display']).toMatchObject({ value: 'Fraunces, serif' })
  })

  it('names the classes that apply an entry: DEFAULT is the bare name, a shade is name-shade', () => {
    const entries = byId(extractJsThemeEntries(dir))
    expect(entries['tailwind.config.js#colors.crust.DEFAULT']!.utilities).toContain('bg-crust')
    expect(entries['tailwind.config.js#colors.crust.DEFAULT']!.utilities).not.toContain('bg-crust-DEFAULT')
    expect(entries['tailwind.config.js#colors.crust.dark']!.utilities.slice(0, 2)).toEqual(['bg-crust-dark', 'text-crust-dark'])
    expect(entries['tailwind.config.js#borderRadius.card']!.utilities).toEqual(['rounded-card'])
    expect(entries['tailwind.config.js#fontFamily.display']!.utilities).toEqual(['font-display'])
  })

  it('every entry is read-only and says where it is written and what to do instead', () => {
    for (const entry of extractJsThemeEntries(dir)) {
      expect(entry.readOnlyReason).toContain(`tailwind.config.js:${entry.line}`)
      expect(entry.readOnlyReason).toContain('Edit it in tailwind.config.js')
      expect(entry.readOnlyReason).toContain('without running')
    }
  })

  it('lets extend override a replace-style key of the same name', () => {
    write('tailwind.config.js', "module.exports = { theme: { colors: { ink: '#000' }, extend: { colors: { ink: '#111' } } } }\n")
    const entries = extractJsThemeEntries(dir)
    expect(entries.filter((entry) => entry.path === 'ink')).toHaveLength(1)
    expect(entries.find((entry) => entry.path === 'ink')!.value).toBe('#111')
  })
})

describe('Tailwind v3 config - what cannot be read without running it', () => {
  beforeEach(() => {
    write('palette.js', "module.exports = { clay: '#a0522d' }\n")
    write(
      'tailwind.config.js',
      [
        "const colors = require('tailwindcss/colors')",
        "const palette = require('./palette')",
        "const defaultTheme = require('tailwindcss/defaultTheme')",
        'module.exports = {',
        '  theme: {',
        '    extend: {',
        '      colors: {',
        '        ...palette,',
        '        brand: colors.sky[500],',
        "        plain: '#123456',",
        '        derived: ({ theme }) => theme("colors.plain"),',
        '      },',
        "      fontFamily: { sans: ['Inter', ...defaultTheme.fontFamily.sans] },",
        "      spacing: require('./spacing'),",
        '    },',
        '  },',
        '}',
        '',
      ].join('\n'),
    )
  })

  it('lists a spread of a require()d palette as one opaque entry that says so', () => {
    const entries = extractJsThemeEntries(dir)
    const spread = entries.find((entry) => entry.path.endsWith('*'))!
    expect(spread).toMatchObject({ group: 'colors', value: null, utilities: [] })
    expect(spread.readOnlyReason).toContain('require()')
    expect(spread.readOnlyReason).toContain('Edit them in tailwind.config.js')
  })

  it('lists a computed value with its reason, still applicable by class, never guessed', () => {
    const entries = byId(extractJsThemeEntries(dir))
    const brand = entries['tailwind.config.js#colors.brand']!
    expect(brand.value).toBeNull()
    expect(brand.raw).toBe('colors.sky[500]')
    expect(brand.readOnlyReason).toContain('Computed in tailwind.config.js:9')
    expect(brand.readOnlyReason).toContain('Studio never does')
    expect(brand.utilities).toContain('bg-brand')
    expect(brand.readOnlyReason).toContain('bg-brand')
    expect(entries['tailwind.config.js#colors.derived']!.readOnlyReason).toContain('function of the theme')
    expect(entries['tailwind.config.js#colors.plain']!.value).toBe('#123456')
  })

  it('reads an array that spreads something as computed, not as its literal half', () => {
    const sans = byId(extractJsThemeEntries(dir))['tailwind.config.js#fontFamily.sans']!
    expect(sans.value).toBeNull()
    expect(sans.readOnlyReason).toContain('Computed')
  })

  it('lists a whole group loaded by require() as one computed entry', () => {
    const spacing = extractJsThemeEntries(dir).find((entry) => entry.group === 'spacing')!
    expect(spacing).toMatchObject({ value: null, path: '', utilities: [] })
    expect(spacing.readOnlyReason).toContain('require()')
  })
})

describe('a token file the config imports, and one it does not', () => {
  it('follows a relative import into the token file and attributes each value to ITS line', () => {
    write(
      'tailwind.config.ts',
      [
        "import type { Config } from 'tailwindcss'",
        "import { palette, radii } from './src/theme'",
        'export default {',
        '  content: [],',
        '  theme: { extend: { colors: palette, borderRadius: radii } },',
        '} satisfies Config',
        '',
      ].join('\n'),
    )
    write('src/theme.ts', ["export const palette = {", "  ink: '#111',", "  paper: { DEFAULT: '#fafafa', warm: '#f5efe6' },", '} as const', "export const radii = { pill: '999px' }", ''].join('\n'))
    const entries = byId(extractJsThemeEntries(dir))
    expect(entries['src/theme.ts#colors.ink']).toMatchObject({ value: '#111', line: 2, source: 'theme-file', file: 'src/theme.ts' })
    expect(entries['src/theme.ts#colors.paper.DEFAULT']!.utilities).toContain('bg-paper')
    expect(entries['src/theme.ts#colors.paper.warm']).toMatchObject({ value: '#f5efe6', line: 3 })
    expect(entries['src/theme.ts#borderRadius.pill']).toMatchObject({ value: '999px', line: 5 })
    expect(entries['src/theme.ts#colors.ink']!.readOnlyReason).toContain('src/theme.ts:2')
  })

  it('lists a standalone theme.ts read by no Tailwind config, with no class to apply', () => {
    write('src/theme.ts', ["export const theme = { colors: { primary: '#0ea5e9' }, spacing: { md: '16px' } }", "export const palette = { accent: '#ff00ff' }", ''].join('\n'))
    const entries = byId(extractJsThemeEntries(dir))
    expect(entries['src/theme.ts#colors.primary']).toMatchObject({ value: '#0ea5e9', utilities: [], source: 'theme-file' })
    expect(entries['src/theme.ts#spacing.md']!.value).toBe('16px')
    expect(entries['src/theme.ts#colors.accent']!.value).toBe('#ff00ff')
    expect(entries['src/theme.ts#colors.primary']!.readOnlyReason).toContain('No Tailwind config in this project reads that file')
  })

  it('does not list a theme file that is not a token object (a call result is computed, not read)', () => {
    write('src/theme.ts', "import { createTheme } from '@mui/material'\nexport default createTheme({ palette: { primary: { main: '#0ea5e9' } } })\n")
    expect(extractJsThemeEntries(dir)).toEqual([])
  })
})

describe('parse, never execute', () => {
  it('reads a config whose top level would throw, write a file and exit, without running any of it', () => {
    const marker = join(dir, 'EXECUTED').replaceAll('\\', '/')
    write(
      'tailwind.config.js',
      [
        `require('node:fs').writeFileSync('${marker}', 'ran')`,
        "throw new Error('the config was executed')",
        "module.exports = { theme: { extend: { colors: { safe: '#00ff00' } } } }",
        '',
      ].join('\n'),
    )
    const entries = extractJsThemeEntries(dir)
    expect(entries.map((entry) => entry.path)).toEqual(['safe'])
    expect(existsSync(marker)).toBe(false)
  })

  it('ends a self-referencing constant as computed instead of looping', () => {
    write('tailwind.config.js', 'const a = b\nconst b = a\nmodule.exports = { theme: { extend: { colors: a } } }\n')
    const entries = extractJsThemeEntries(dir)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.value).toBeNull()
  })

  it('does not follow an import out of the workspace', () => {
    write('tailwind.config.js', "import outside from '../../secrets'\nexport default { theme: { extend: { colors: outside } } }\n")
    const entries = extractJsThemeEntries(dir)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.value).toBeNull()
  })

  it('a project with no JavaScript theme lists nothing', () => {
    write('src/App.tsx', 'export const App = () => null\n')
    expect(extractJsThemeEntries(dir)).toEqual([])
  })
})
