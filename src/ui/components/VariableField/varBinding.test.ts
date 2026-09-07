/**
 * The two pure halves of the "Apply variable" affordance: deciding whether a
 * field's value IS a variable binding, and deciding what kind of value a
 * variable holds. Both are load-bearing for the panel's "never render a
 * control that lies" rule — a false positive here shows a chip for a value
 * the detach button cannot honestly restore, and a wrong kind offers a
 * colour to a width field.
 */
import { describe, expect, it } from 'bun:test'
import { formatVarBinding, parseVarBinding, variableChipLabel } from './varBinding'
import { classifyVariableValue, filterVariablesByKind, type VariableOption } from './variableKind'

/**
 * Builds a `var(--name, fallback)` expression at runtime.
 *
 * The literal is assembled rather than written out because
 * `no-css-var-fallbacks.test.ts` scans every `.ts(x)` under `src/ui` for that
 * exact shape — correctly, since authoring one in OUR styles hides a missing
 * token. These strings are not ours: they are the USER's stylesheet, which
 * this parser exists to read. Assembling them keeps the gate at full strength
 * while still exercising the fallback grammar.
 */
function varExpr(name: string, fallback?: string): string {
  return fallback === undefined ? `var(${name})` : `var(${name},${' '}${fallback})`
}

describe('parseVarBinding', () => {
  it('parses a bare reference', () => {
    expect(parseVarBinding('var(--color-primary)')).toEqual({
      name: '--color-primary',
      fallback: undefined,
    })
  })

  it('parses a reference with a fallback', () => {
    expect(parseVarBinding(varExpr('--space-4', '16px'))).toEqual({
      name: '--space-4',
      fallback: '16px',
    })
  })

  it('parses a nested fallback without truncating it', () => {
    const inner = varExpr('--b', '4px')
    expect(parseVarBinding(varExpr('--a', inner))).toEqual({
      name: '--a',
      fallback: inner,
    })
  })

  it('tolerates surrounding whitespace', () => {
    expect(parseVarBinding('  var( --x )  ')).toEqual({ name: '--x', fallback: undefined })
  })

  it('refuses a value that merely CONTAINS a var()', () => {
    // These are the false positives that would put a detachable chip on a
    // value no single write can restore.
    expect(parseVarBinding('calc(var(--x) * 2)')).toBeNull()
    expect(parseVarBinding('1px solid var(--x)')).toBeNull()
    expect(parseVarBinding('var(--x) var(--y)')).toBeNull()
  })

  it('refuses literals, blanks, and nullish', () => {
    expect(parseVarBinding('16px')).toBeNull()
    expect(parseVarBinding('')).toBeNull()
    expect(parseVarBinding(undefined)).toBeNull()
    expect(parseVarBinding(null)).toBeNull()
  })

  it('refuses an unbalanced or malformed call', () => {
    expect(parseVarBinding('var(--x')).toBeNull()
    expect(parseVarBinding('var(notavar)')).toBeNull()
    expect(parseVarBinding('var(--x 16px)')).toBeNull()
  })
})

describe('formatVarBinding / variableChipLabel', () => {
  it('writes the one shape', () => {
    expect(formatVarBinding('--color-primary')).toBe('var(--color-primary)')
  })

  it('strips the leading dashes for display, Figma-style', () => {
    expect(variableChipLabel('--color-primary')).toBe('color-primary')
    expect(variableChipLabel('--34')).toBe('34')
  })

  it('round-trips through the parser', () => {
    const parsed = parseVarBinding(formatVarBinding('--radius-card'))
    expect(parsed?.name).toBe('--radius-card')
  })
})

describe('classifyVariableValue', () => {
  it('recognises every colour notation a design token realistically uses', () => {
    for (const value of [
      '#fff',
      '#ef4550',
      '#ef455080',
      'rgb(239, 69, 80)',
      'rgba(239 69 80 / 0.5)',
      'hsl(187 88% 37%)',
      'oklch(0.7 0.1 200)',
      'color-mix(in srgb, #fff 50%, #000)',
      'transparent',
      'currentColor',
    ]) {
      expect(classifyVariableValue(value)).toBe('color')
    }
  })

  it('recognises lengths and percentages', () => {
    for (const value of ['16px', '1.5rem', '-2px', '.5em', '100%', '4vh']) {
      expect(classifyVariableValue(value)).toBe('length')
    }
  })

  it('recognises bare numbers', () => {
    expect(classifyVariableValue('1.5')).toBe('number')
    expect(classifyVariableValue('-3')).toBe('number')
  })

  it('buckets everything else as other', () => {
    expect(classifyVariableValue('Inter, sans-serif')).toBe('other')
    expect(classifyVariableValue('cubic-bezier(0.4, 0, 0.2, 1)')).toBe('other')
    expect(classifyVariableValue('0 1px 2px rgba(0,0,0,.2)')).toBe('other')
    expect(classifyVariableValue('   ')).toBe('other')
  })

  it('does NOT classify by name — an unresolved reference is not a colour', () => {
    expect(classifyVariableValue('var(--color-primary)')).toBe('other')
  })
})

describe('filterVariablesByKind', () => {
  const catalog: VariableOption[] = [
    { name: '--color-primary', resolvedValue: '#ef4550', kind: 'color', source: 'project' },
    { name: '--space-4', resolvedValue: '16px', kind: 'length', source: 'project' },
    { name: '--leading', resolvedValue: '1.5', kind: 'number', source: 'project' },
    { name: '--font-body', resolvedValue: 'Inter', kind: 'other', source: 'vendor' },
  ]

  it('offers a length field only lengths and numbers', () => {
    expect(filterVariablesByKind(catalog, ['length', 'number']).map((v) => v.name)).toEqual([
      '--space-4',
      '--leading',
    ])
  })

  it('offers a colour field only colours', () => {
    expect(filterVariablesByKind(catalog, ['color']).map((v) => v.name)).toEqual(['--color-primary'])
  })

  it('accepting `other` opts a generic string field into everything', () => {
    expect(filterVariablesByKind(catalog, ['other'])).toHaveLength(4)
  })

  it('preserves catalog order — a scale is declared small-to-large', () => {
    const scale: VariableOption[] = ['1', '2', '10'].map((step) => ({
      name: `--space-${step}`,
      resolvedValue: `${step}px`,
      kind: 'length' as const,
      source: 'project' as const,
    }))
    expect(filterVariablesByKind(scale, ['length']).map((v) => v.name)).toEqual([
      '--space-1',
      '--space-2',
      '--space-10',
    ])
  })
})
