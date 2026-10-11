/**
 * projectVariables: turning the server's token catalog (plus the generated
 * Framework scales) into the inspector's picker rows. There is no CSS scan
 * here any more - the scan is the server's, tested in
 * `server/handlers/studio/tokenCatalog.test.ts`.
 */
import { describe, expect, it } from 'bun:test'
import type { CatalogToken, TokenCatalog, TokenDecl } from '@core/studio-tokens'
import { buildVariableCatalog, frameworkVariableOptions, projectVariableOptions } from './projectVariables'

function decl(overrides: Partial<TokenDecl> & Pick<TokenDecl, 'value'>): TokenDecl {
  return {
    gate: { kind: 'base' },
    selector: ':root',
    atRules: [],
    resolvedValue: overrides.value,
    file: 'src/tokens.css',
    line: 1,
    origin: 'project',
    winning: true,
    inTheme: false,
    ...overrides,
  }
}

function token(name: string, decls: TokenDecl[], collection = 'src/tokens.css#color'): CatalogToken {
  return { name, family: 'color', collection, decls }
}

const CATALOG: TokenCatalog = {
  tokens: [
    token('--color-primary', [
      decl({ value: '#ef4550' }),
      decl({ value: '#ff8a93', gate: { kind: 'attr', attr: 'data-theme', value: 'dark' }, selector: "[data-theme='dark']", line: 9 }),
    ]),
    token('--space-4', [decl({ value: '16px' })], 'src/tokens.css#space'),
    token('--btn-bg', [decl({ value: 'var(--vendor-accent)', resolvedValue: 'rgb(12 154 176)', aliasOf: '--vendor-accent' })], 'src/tokens.css#btn'),
    token('--vendor-accent', [decl({ value: 'rgb(12 154 176)', file: 'pkg/ds.css', origin: 'package', line: null })], 'pkg/ds.css#vendor'),
    token('--glow', [decl({ value: '#fff', gate: { kind: 'class', className: 'dark' }, selector: '.dark' })]),
  ],
  collections: [
    { id: 'src/tokens.css#color', label: 'color', file: 'src/tokens.css', origin: 'project', editable: true },
    { id: 'src/tokens.css#space', label: 'space', file: 'src/tokens.css', origin: 'project', editable: true },
  ],
  axes: [],
}

describe('projectVariableOptions', () => {
  const options = projectVariableOptions(CATALOG)
  const find = (name: string) => options.find((entry) => entry.name === name)

  it('classifies each entry from its RESOLVED value', () => {
    expect(find('--color-primary')?.kind).toBe('color')
    expect(find('--space-4')?.kind).toBe('length')
    // Declared as `var(--vendor-accent)`; only resolution makes it a colour.
    expect(find('--btn-bg')?.kind).toBe('color')
    expect(find('--btn-bg')?.resolvedValue).toBe('rgb(12 154 176)')
  })

  it('labels each entry with the bundle that owns its declaration, and names the file', () => {
    expect(find('--space-4')).toMatchObject({ source: 'project', file: 'src/tokens.css', collection: 'space' })
    expect(find('--vendor-accent')).toMatchObject({ source: 'vendor', file: 'pkg/ds.css' })
  })

  it('shows the default value and carries the other modes for the tooltip', () => {
    expect(find('--color-primary')?.resolvedValue).toBe('#ef4550')
    expect(find('--color-primary')?.modes).toEqual([{ label: 'Dark', value: '#ff8a93' }])
    expect(find('--space-4')?.modes).toBeUndefined()
  })

  it('still offers a token declared only under a mode gate', () => {
    expect(find('--glow')?.resolvedValue).toBe('#fff')
  })

  it('is empty for a catalog with no tokens', () => {
    expect(projectVariableOptions({ tokens: [], collections: [], axes: [] })).toEqual([])
  })
})

describe('frameworkVariableOptions', () => {
  it('lists the generated :root scale with resolved values and no file', () => {
    const options = frameworkVariableOptions(':root{--text-l:20px;--text-xl:var(--text-l)}')
    expect(options).toEqual([
      { name: '--text-l', resolvedValue: '20px', kind: 'length', source: 'framework' },
      { name: '--text-xl', resolvedValue: '20px', kind: 'length', source: 'framework' },
    ])
  })
})

describe('buildVariableCatalog', () => {
  it('puts the project first and never lets a Framework step relabel a project variable of the same name', () => {
    const merged = buildVariableCatalog(CATALOG, ':root{--space-4:99px;--text-l:20px}')
    expect(merged.filter((entry) => entry.name === '--space-4')).toHaveLength(1)
    expect(merged.find((entry) => entry.name === '--space-4')).toMatchObject({ source: 'project', resolvedValue: '16px' })
    expect(merged.find((entry) => entry.name === '--text-l')?.source).toBe('framework')
    expect(merged.findIndex((entry) => entry.source === 'framework')).toBeGreaterThan(merged.findLastIndex((entry) => entry.source === 'project'))
  })

  it('has only the Framework group before the server catalog has arrived', () => {
    expect(buildVariableCatalog(null, ':root{--text-l:20px}').map((entry) => entry.source)).toEqual(['framework'])
    expect(buildVariableCatalog(null, '')).toEqual([])
  })
})
