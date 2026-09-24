import { describe, expect, it } from 'bun:test'
import { listCustomPropertyDeclarations, setCustomPropertyValueAtLine } from '../customProperty'

const TOKENS = [
  '/* brand palette */',
  ':root {',
  '  --brand: #0c9ab0; /* teal */',
  '  --radius-card: 12px;',
  '  --shadow: 0 1px 2px rgb(0 0 0 / 0.2) !important;',
  '}',
  '',
  '[data-theme="dark"] {',
  '  --brand: #5fd3e4;',
  '}',
  '',
  '@media (min-width: 768px) {',
  '  :root {',
  '    --radius-card: 16px;',
  '  }',
  '}',
  '',
].join('\n')

describe('listCustomPropertyDeclarations', () => {
  it('finds every declaration of one name, with its line and what encloses it', () => {
    expect(listCustomPropertyDeclarations(TOKENS, '--brand')).toEqual([
      { line: 3, value: '#0c9ab0', selector: ':root', atRules: [] },
      { line: 9, value: '#5fd3e4', selector: '[data-theme="dark"]', atRules: [] },
    ])
    expect(listCustomPropertyDeclarations(TOKENS, '--radius-card')).toEqual([
      { line: 4, value: '12px', selector: ':root', atRules: [] },
      { line: 14, value: '16px', selector: ':root', atRules: ['@media (min-width: 768px)'] },
    ])
  })

  it('is empty for a name the file does not declare, and for a file that does not parse', () => {
    expect(listCustomPropertyDeclarations(TOKENS, '--missing')).toEqual([])
    expect(listCustomPropertyDeclarations(':root { --a: 1px', '--a')).toEqual([])
  })
})

describe('setCustomPropertyValueAtLine', () => {
  it('rewrites exactly the one declaration on that line and nothing else, byte for byte', () => {
    const result = setCustomPropertyValueAtLine(TOKENS, '--brand', 3, '#ef4550')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.changed).toBe(true)
    expect(result.previous).toBe('#0c9ab0')
    expect(result.css).toBe(TOKENS.replace('--brand: #0c9ab0; /* teal */', '--brand: #ef4550; /* teal */'))
  })

  it('edits the dark declaration when that is the line named, leaving the light one alone', () => {
    const result = setCustomPropertyValueAtLine(TOKENS, '--brand', 9, '#ffffff')
    expect(result.ok && result.css).toBe(TOKENS.replace('--brand: #5fd3e4;', '--brand: #ffffff;'))
  })

  it('keeps !important, which postcss holds outside the value', () => {
    const result = setCustomPropertyValueAtLine(TOKENS, '--shadow', 5, '0 2px 4px rgb(0 0 0 / 0.3)')
    expect(result.ok && result.css).toContain('  --shadow: 0 2px 4px rgb(0 0 0 / 0.3) !important;')
  })

  it('round-trips a CRLF stylesheet with CRLF, and reports the same line numbers', () => {
    const crlf = TOKENS.replace(/\n/g, '\r\n')
    const result = setCustomPropertyValueAtLine(crlf, '--radius-card', 14, '20px')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.css).toBe(crlf.replace('--radius-card: 16px;', '--radius-card: 20px;'))
    expect(result.css.replace(/\r\n/g, '')).not.toContain('\n')
  })

  it('a value already in place is a no-op that hands back the caller\'s own bytes', () => {
    const crlf = TOKENS.replace(/\n/g, '\r\n')
    const result = setCustomPropertyValueAtLine(crlf, '--brand', 3, '#0c9ab0')
    expect(result).toEqual({ ok: true, css: crlf, changed: false, previous: '#0c9ab0' })
  })

  it('refuses a line that no longer holds the declaration, instead of editing a neighbour', () => {
    const result = setCustomPropertyValueAtLine(TOKENS, '--brand', 4, '#000')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('no-declaration-at-line')
  })

  it('refuses a value that would end the declaration or open a block', () => {
    for (const value of ['red; color: blue', 'red } .x { color: blue', '', 'a\nb']) {
      const result = setCustomPropertyValueAtLine(TOKENS, '--brand', 3, value)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe('invalid-value')
    }
  })

  it('refuses a name that is not a custom property, and a stylesheet that does not parse', () => {
    const notCustom = setCustomPropertyValueAtLine(TOKENS, 'color', 3, 'red')
    expect(!notCustom.ok && notCustom.reason).toBe('not-a-custom-property')
    const broken = setCustomPropertyValueAtLine(':root {\n  --a: 1px;\n', '--a', 2, '2px')
    expect(!broken.ok && broken.reason).toBe('unparseable-stylesheet')
  })
})
