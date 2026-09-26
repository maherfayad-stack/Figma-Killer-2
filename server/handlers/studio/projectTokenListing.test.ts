/**
 * `listProjectTokens` (the listing view of the token scan) and
 * `splitCompiledStyleChunks` (how a token in compiled CSS finds its file) —
 * pure, no project on disk. The end-to-end tool behaviour is pinned in
 * `server/ai/mcp/tools/studio/projectTokenTools.test.ts`.
 */
import { describe, expect, it } from 'bun:test'
import { buildProjectTokenIndex, listProjectTokens, type TokenCssSource } from './projectTokenIndex'
import { splitCompiledStyleChunks } from './styleCompile'

const src = (file: string, css: string, origin: TokenCssSource['origin'] = 'project'): TokenCssSource => ({ file, origin, css })

describe('listProjectTokens', () => {
  it('lets a later source win the value AND the file:line, exactly as the cascade does', () => {
    const tokens = listProjectTokens([
      src('vendor/alm-design-system/dist/index.css', ':root{--color-brand:#000000}', 'studio-design-system'),
      src('src/index.css', '\n\n:root {\n  --color-brand: #0c9ab0;\n}\n'),
    ])
    expect(tokens).toEqual([
      { name: '--color-brand', value: '#0c9ab0', family: 'color', file: 'src/index.css', line: 4, origin: 'project' },
    ])
  })

  it('agrees with the measurement index about every value', () => {
    const css = ':root{--a:#ff0000;--b:var(--a);--size-title:18px}'
    const listed = listProjectTokens([src('x.css', css)])
    const index = buildProjectTokenIndex(css)
    expect(listed.find((t) => t.name === '--b')!.value).toBe('#ff0000')
    expect(index.colors.find((c) => c.name === '--b')!.hex).toBe('#ff0000')
  })

  it('reports no line for compiled output — its lines point at nothing a person edits', () => {
    const [token] = listProjectTokens([src('compiled sass output', ':root{--space-md:16px}', 'compiled')])
    expect(token).toMatchObject({ name: '--space-md', family: 'space', file: 'compiled sass output', line: null })
  })

  it('lists a token declared only for dark mode, at the dark declaration', () => {
    const [token] = listProjectTokens([src('t.css', ':root.dark {\n  --glow: #ffffff;\n}')])
    expect(token).toMatchObject({ name: '--glow', value: '#ffffff', line: 2 })
    expect(token!.dark).toBeUndefined()
  })

  it('finds a declaration nested in @layer and names its real line', () => {
    const css = '@layer theme {\n  :root {\n    --radius-card: 12px;\n  }\n}\n'
    const [token] = listProjectTokens([src('src/theme.css', css)])
    expect(token).toMatchObject({ name: '--radius-card', family: 'radius', line: 3 })
  })
})

describe('splitCompiledStyleChunks', () => {
  it('splits the concatenation back into the files it was joined from, line 1 intact', () => {
    const joined = [
      '/* studio: css module pages/Home.module.css */',
      '.a_x { color: red }',
      '',
      '/* studio: compiled postcss */',
      ':root {',
      '  --space-md: 16px;',
      '}',
    ].join('\n')
    expect(splitCompiledStyleChunks(joined)).toEqual([
      { kind: 'css module', label: 'pages/Home.module.css', css: '.a_x { color: red }' },
      { kind: 'compiled', label: 'postcss', css: ':root {\n  --space-md: 16px;\n}' },
    ])
  })

  it('returns nothing for empty output', () => {
    expect(splitCompiledStyleChunks('')).toEqual([])
  })
})
