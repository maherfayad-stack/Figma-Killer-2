/**
 * The token catalog (CT-1): tokens with every gated declaration, collections,
 * inferred mode axes, alias chains resolved per mode, and the usage scan.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { buildTokenCatalog, scanTokenUsage, withTokenUsage } from './tokenCatalog'
import type { TokenCssSource } from './projectTokenIndex'

const src = (file: string, css: string, origin: TokenCssSource['origin'] = 'project'): TokenCssSource => ({ file, origin, css })

const TOKENS_CSS = [
  ':root {',
  '  --color-brand: #0c9ab0;',
  '  --color-link: var(--color-brand);',
  '  --space-md: 16px;',
  '  --radius-card: 12px;',
  '}',
  '',
  "[data-theme='dark'] {",
  '  --color-brand: #5fd3e4;',
  '}',
  '',
  '@media (prefers-color-scheme: dark) {',
  '  :root:not([data-theme=light]) { --color-brand: #5fd3e4; }',
  '}',
  '',
  '@media (min-width: 768px) {',
  '  :root { --space-md: 24px; }',
  '}',
  '',
  '.btn { --btn-pad: 8px; }',
  '',
].join('\n')

describe('buildTokenCatalog', () => {
  const catalog = buildTokenCatalog([src('src/tokens.css', TOKENS_CSS)])
  const token = (name: string) => catalog.tokens.find((t) => t.name === name)!

  it('keeps every declaration of a token, one per mode, with file:line and the cascade winner', () => {
    const brand = token('--color-brand')
    expect(brand.decls.map((d) => [d.gate.kind, d.line, d.winning])).toEqual([
      ['base', 2, true],
      ['attr', 9, true],
      ['attr', 13, true],
    ])
    expect(brand.decls[0]).toMatchObject({ value: '#0c9ab0', resolvedValue: '#0c9ab0', file: 'src/tokens.css', origin: 'project' })
  })

  it('resolves an alias in the mode it is declared in, and names what it aliases', () => {
    const link = token('--color-link')
    expect(link.decls).toHaveLength(1)
    expect(link.decls[0]).toMatchObject({ value: 'var(--color-brand)', resolvedValue: '#0c9ab0', aliasOf: '--color-brand' })
  })

  it('classifies the family from the resolved value', () => {
    expect(token('--color-brand').family).toBe('color')
    expect(token('--space-md').family).toBe('space')
    expect(token('--radius-card').family).toBe('radius')
  })

  it('infers the mode axes from the gates it found', () => {
    const ids = catalog.axes.map((axis) => axis.id)
    expect(ids).toEqual(['color-scheme', 'breakpoint'])
    expect(catalog.axes[0]!.modes.map((m) => m.id)).toEqual(['dark'])
    expect(catalog.axes[1]!.modes[0]).toMatchObject({ id: '(min-width: 768px)', gate: { kind: 'media' } })
  })

  it('lists a component-scoped token, but not as a mode', () => {
    expect(token('--btn-pad').decls[0]!.gate).toEqual({ kind: 'scope', selector: '.btn' })
    expect(catalog.axes.flatMap((axis) => axis.modes.map((m) => m.id))).not.toContain('.btn')
  })

  it('groups tokens into collections by declaring file and leading name segment', () => {
    expect(catalog.collections.map((c) => c.id).sort()).toEqual(['src/tokens.css#btn', 'src/tokens.css#color', 'src/tokens.css#radius', 'src/tokens.css#space'])
    expect(token('--space-md').collection).toBe('src/tokens.css#space')
    expect(catalog.collections.find((c) => c.id === 'src/tokens.css#color')).toMatchObject({ label: 'color', origin: 'project', editable: true })
  })

  it('lets the project override a package token and marks only the project declaration as winning', () => {
    const merged = buildTokenCatalog([
      src('pkg/ds.css', ':root{--color-brand:#000000}', 'package'),
      src('src/index.css', ':root{--color-brand:#ffffff}'),
    ])
    const decls = merged.tokens[0]!.decls
    expect(decls.map((d) => [d.origin, d.winning])).toEqual([['package', false], ['project', true]])
  })

  it('marks a package-only collection read-only and reports no line for compiled output', () => {
    const merged = buildTokenCatalog([
      src('pkg/ds.css', ':root{--a:1px}', 'package'),
      src('compiled postcss output', ':root{--b:2px}', 'compiled'),
    ])
    expect(merged.collections.every((c) => !c.editable)).toBe(true)
    expect(merged.tokens.find((t) => t.name === '--b')!.decls[0]!.line).toBeNull()
  })

  it('reads Tailwind v4 @theme tokens as base-mode tokens flagged inTheme', () => {
    const theme = buildTokenCatalog([src('src/app.css', '@import "tailwindcss";\n@theme {\n  --color-brand: #0c9ab0;\n}\n')])
    expect(theme.tokens[0]!.decls[0]).toMatchObject({ gate: { kind: 'base' }, inTheme: true, line: 3 })
  })

  it('attaches usage only when given', () => {
    expect(token('--space-md').usage).toBeUndefined()
    const withUsage = withTokenUsage(buildTokenCatalog([src('a.css', ':root{--a:1px;--b:2px}')]), new Map([['--a', { count: 3, sites: [{ file: 'x.tsx', line: 4 }] }]]))
    expect(withUsage.tokens.map((t) => t.usage?.count)).toEqual([3, 0])
  })
})

describe('scanTokenUsage', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'token-usage-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })
  const write = (rel: string, text: string): void => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), text, 'utf8')
  }

  it('counts var() reads in stylesheets, TSX strings and Tailwind arbitrary values, with file:line', () => {
    write('src/a.css', '.a {\n  color: var(--brand);\n  padding: var( --space-md , 4px);\n}\n')
    write('src/App.tsx', "export const s = { background: 'var(--brand)' }\nexport const c = 'bg-[--brand] p-(--space-md)'\n")
    write('node_modules/x/y.css', '.z { color: var(--brand) }')
    const usage = scanTokenUsage(dir)
    expect(usage.get('--brand')).toEqual({
      count: 3,
      sites: [
        { file: 'src/App.tsx', line: 1 },
        { file: 'src/App.tsx', line: 2 },
        { file: 'src/a.css', line: 2 },
      ],
    })
    expect(usage.get('--space-md')!.count).toBe(2)
  })

  it('does not count a declaration as a use of itself', () => {
    write('src/a.css', ':root { --brand: red; }\n')
    expect(scanTokenUsage(dir).has('--brand')).toBe(false)
  })
})
