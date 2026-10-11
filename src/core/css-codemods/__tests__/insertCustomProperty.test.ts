/**
 * insertCustomProperty: declare a token in the rule that already holds its
 * mode, or in a new block, touching nothing else - CRLF files included.
 */
import { describe, expect, it } from 'bun:test'
import { insertCustomProperty } from '../customProperty'

const SHEET = [
  '/* brand palette */',
  ':root {',
  '  --brand: #0c9ab0; /* teal */',
  '  --space-1: 4px;',
  '  --space-2: 8px;',
  '}',
  '',
  '[data-theme="dark"] {',
  '  --brand: #5fd3e4;',
  '}',
  '',
].join('\n')

const base = { kind: 'base' } as const
const dark = { kind: 'attr', attr: 'data-theme', value: 'dark' } as const

function ok(result: ReturnType<typeof insertCustomProperty>): string {
  if (!result.ok) throw new Error(result.message)
  return result.css
}

describe('insertCustomProperty', () => {
  it('appends to the existing :root rule, matching its indentation', () => {
    const css = ok(insertCustomProperty(SHEET, { name: '--space-3', value: '12px', gate: base }))
    expect(css).toBe(SHEET.replace('  --space-2: 8px;\n', '  --space-2: 8px;\n  --space-3: 12px;\n'))
  })

  it('places the declaration after a named sibling in the same rule', () => {
    const css = ok(insertCustomProperty(SHEET, { name: '--space-1-5', value: '6px', gate: base, after: '--space-1' }))
    expect(css).toBe(SHEET.replace('  --space-1: 4px;\n', '  --space-1: 4px;\n  --space-1-5: 6px;\n'))
  })

  it('declares a dark value inside the rule that already holds the dark gate', () => {
    const css = ok(insertCustomProperty(SHEET, { name: '--surface', value: '#111', gate: dark }))
    expect(css).toBe(SHEET.replace('  --brand: #5fd3e4;\n', '  --brand: #5fd3e4;\n  --surface: #111;\n'))
  })

  it('creates the gate block when the file has none, after a blank line', () => {
    const css = ok(insertCustomProperty(SHEET, { name: '--surface', value: '#fafafa', gate: { kind: 'attr', attr: 'data-density', value: 'compact' } }))
    expect(css).toBe(`${SHEET}\n[data-density="compact"] {\n  --surface: #fafafa;\n}\n`)
  })

  it('creates a :root block in a file with no tokens yet', () => {
    expect(ok(insertCustomProperty('.a { color: red }\n', { name: '--x', value: '1px', gate: base }))).toBe('.a { color: red }\n\n:root {\n  --x: 1px;\n}\n')
  })

  it('creates an @media block for a media gate', () => {
    const css = ok(insertCustomProperty(SHEET, { name: '--gap', value: '24px', gate: { kind: 'media', query: '(min-width: 768px)' } }))
    expect(css.slice(SHEET.length)).toBe('\n@media (min-width: 768px) {\n  :root {\n    --gap: 24px;\n  }\n}\n')
    expect(css.startsWith(SHEET)).toBe(true)
  })

  it('declares inside Tailwind v4 @theme when asked to', () => {
    const theme = '@import "tailwindcss";\n\n@theme {\n  --color-brand: #0c9ab0;\n}\n'
    const css = ok(insertCustomProperty(theme, { name: '--color-accent', value: '#f00', gate: base, host: 'theme' }))
    expect(css).toBe(theme.replace('  --color-brand: #0c9ab0;\n', '  --color-brand: #0c9ab0;\n  --color-accent: #f00;\n'))
  })

  it('does not put a base token into a comma group that also sets another mode', () => {
    const grouped = ":root, [data-theme='dark'] {\n  --a: 1px;\n}\n"
    const css = ok(insertCustomProperty(grouped, { name: '--b', value: '2px', gate: base }))
    expect(css.startsWith(grouped)).toBe(true)
    expect(css).toContain('\n\n:root {\n  --b: 2px;\n}')
  })

  it('refuses a name the rule already declares', () => {
    const result = insertCustomProperty(SHEET, { name: '--brand', value: '#000', gate: base })
    expect(result).toMatchObject({ ok: false, reason: 'already-declared' })
  })

  it('refuses a value that would break out of the declaration, and a non-custom name', () => {
    expect(insertCustomProperty(SHEET, { name: '--x', value: '1px; color: red', gate: base })).toMatchObject({ ok: false, reason: 'invalid-value' })
    expect(insertCustomProperty(SHEET, { name: 'color', value: 'red', gate: base })).toMatchObject({ ok: false, reason: 'not-a-custom-property' })
  })

  it('keeps a CRLF stylesheet CRLF, including the block it appends', () => {
    const crlf = SHEET.replace(/\n/g, '\r\n')
    const withDeclaration = ok(insertCustomProperty(crlf, { name: '--space-3', value: '12px', gate: base }))
    expect(withDeclaration).toBe(crlf.replace('  --space-2: 8px;\r\n', '  --space-2: 8px;\r\n  --space-3: 12px;\r\n'))
    const withBlock = ok(insertCustomProperty(crlf, { name: '--x', value: '1px', gate: { kind: 'class', className: 'dark' } }))
    expect(withBlock).toBe(`${crlf}\r\n.dark {\r\n  --x: 1px;\r\n}\r\n`)
    expect(withBlock.replace(/\r\n/g, '')).not.toContain('\n')
  })
})
