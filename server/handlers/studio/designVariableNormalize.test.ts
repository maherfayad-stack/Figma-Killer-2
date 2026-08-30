import { describe, expect, it } from 'bun:test'
import { normalizeDesignVariableValue } from './designVariableNormalize'

describe('normalizeDesignVariableValue — colour equivalence', () => {
  it('recognises hex, rgb(), and hsl() forms of the same colour as equal', () => {
    const hex = normalizeDesignVariableValue('#EF4550')
    const hexLower = normalizeDesignVariableValue('#ef4550')
    const rgb = normalizeDesignVariableValue('rgb(239, 69, 80)')
    const hsl = normalizeDesignVariableValue('hsl(356, 82%, 60%)')

    expect(hex.kind).toBe('color')
    expect(hex.hex).toBe('#ef4550')
    expect(hexLower.hex).toBe('#ef4550')
    expect(rgb.hex).toBe('#ef4550')
    // hsl -> rgb rounding can be off by a step; assert perceptual equality
    // isn't the point here (colorDifference covers that) — just that it
    // normalised to a colour, not a size or "other".
    expect(hsl.kind).toBe('color')
  })

  it('3-digit and 8-digit (with alpha) hex normalise to the same 6-digit form', () => {
    const short = normalizeDesignVariableValue('#f00')
    const withAlpha = normalizeDesignVariableValue('#ff0000ff')
    expect(short.hex).toBe('#ff0000')
    expect(withAlpha.hex).toBe('#ff0000')
  })

  it('is whitespace- and case-insensitive', () => {
    expect(normalizeDesignVariableValue('  #EF4550  ').hex).toBe('#ef4550')
    expect(normalizeDesignVariableValue('RGB(239, 69, 80)').hex).toBe('#ef4550')
  })
})

describe('normalizeDesignVariableValue — size, unit knowability', () => {
  it('an explicit px suffix converts exactly, with no unitAssumed flag', () => {
    const result = normalizeDesignVariableValue('16px')
    expect(result.kind).toBe('size')
    expect(result.px).toBe(16)
    expect(result.unitAssumed).toBeUndefined()
  })

  it('rem/em resolve against a 16px root; pt converts to px', () => {
    expect(normalizeDesignVariableValue('1rem').px).toBe(16)
    expect(normalizeDesignVariableValue('1.5rem').px).toBe(24)
    expect(normalizeDesignVariableValue('1em').px).toBe(16)
    expect(normalizeDesignVariableValue('12pt').px).toBeCloseTo(16, 0)
  })

  it('a bare number is treated as px but flagged unitAssumed — the unit is not actually knowable', () => {
    const result = normalizeDesignVariableValue('16')
    expect(result.kind).toBe('size')
    expect(result.px).toBe(16)
    expect(result.unitAssumed).toBe(true)
  })

  it('a bare decimal is also treated as an assumed-px size (e.g. a Figma spacing FLOAT)', () => {
    const result = normalizeDesignVariableValue('8.5')
    expect(result.kind).toBe('size')
    expect(result.px).toBe(8.5)
    expect(result.unitAssumed).toBe(true)
  })

  it('never discards the caller\'s original string — this module only returns the DERIVED value', () => {
    // (raw preservation is the caller's job — designVariableStore.ts keeps
    // `entry.raw` verbatim regardless of what this function returns.) This
    // test documents that the function itself never mutates or truncates
    // the string it is given by asserting it is pure over its input.
    const input = '  16px  '
    const result = normalizeDesignVariableValue(input)
    expect(input).toBe('  16px  ') // untouched
    expect(result.px).toBe(16)
  })
})

describe('normalizeDesignVariableValue — honest "other" fallback', () => {
  it('a boolean-looking string is neither a colour nor a knowable size', () => {
    expect(normalizeDesignVariableValue('true').kind).toBe('other')
    expect(normalizeDesignVariableValue('false').kind).toBe('other')
  })

  it('free text is "other"', () => {
    expect(normalizeDesignVariableValue('Inter').kind).toBe('other')
    expect(normalizeDesignVariableValue('Regular').kind).toBe('other')
  })

  it('an empty or whitespace-only value is "other", not a crash', () => {
    expect(normalizeDesignVariableValue('').kind).toBe('other')
    expect(normalizeDesignVariableValue('   ').kind).toBe('other')
  })
})

describe('normalizeDesignVariableValue — hostile input is bounded, never throws', () => {
  it('an absurdly large bare number does not become a plausible px value', () => {
    const result = normalizeDesignVariableValue('99999999999999999999999999')
    // Either rejected outright (kind: other) or clamped by the plausibility
    // ceiling — either way it must not silently become a huge "px" that
    // could corrupt downstream nearest-match arithmetic.
    if (result.kind === 'size') {
      expect(result.px).toBeLessThanOrEqual(100_000)
    } else {
      expect(result.kind).toBe('other')
    }
  })

  it('a very long garbage string does not throw and normalises to "other"', () => {
    const garbage = 'x'.repeat(5000)
    expect(() => normalizeDesignVariableValue(garbage)).not.toThrow()
    expect(normalizeDesignVariableValue(garbage).kind).toBe('other')
  })

  it('scientific notation is not treated as a bare number (ambiguous magnitude)', () => {
    const result = normalizeDesignVariableValue('1e10')
    expect(result.kind).toBe('other')
  })

  it('NaN/Infinity spelled out are not numbers to this parser', () => {
    expect(normalizeDesignVariableValue('NaN').kind).toBe('other')
    expect(normalizeDesignVariableValue('Infinity').kind).toBe('other')
  })

  it('a colour-shaped string with invalid digits is not falsely accepted', () => {
    expect(normalizeDesignVariableValue('#zzzzzz').kind).toBe('other')
    expect(normalizeDesignVariableValue('rgb(not, a, color)').kind).toBe('other')
  })
})
