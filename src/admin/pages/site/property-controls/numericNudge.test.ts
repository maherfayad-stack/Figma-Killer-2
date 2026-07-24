import { describe, expect, it } from 'bun:test'
import {
  BASE_NUDGE,
  FINE_NUDGE,
  SHIFT_NUDGE,
  nudgeCssValue,
  nudgeNumber,
  nudgeStepFor,
  parseNudgeableValue,
} from './numericNudge'

describe('nudgeStepFor', () => {
  it('selects plain / shift / alt steps', () => {
    expect(nudgeStepFor({ shiftKey: false, altKey: false })).toBe(BASE_NUDGE)
    expect(nudgeStepFor({ shiftKey: true, altKey: false })).toBe(SHIFT_NUDGE)
    expect(nudgeStepFor({ shiftKey: false, altKey: true })).toBe(FINE_NUDGE)
  })

  it('lets alt (fine) win over shift when both are held', () => {
    expect(nudgeStepFor({ shiftKey: true, altKey: true })).toBe(FINE_NUDGE)
  })

  it('uses 8 as the shift nudge and 0.1 as the fine nudge', () => {
    expect(SHIFT_NUDGE).toBe(8)
    expect(FINE_NUDGE).toBe(0.1)
  })
})

describe('parseNudgeableValue', () => {
  it('parses a number with a unit', () => {
    expect(parseNudgeableValue('16px')).toEqual({ number: 16, unit: 'px' })
    expect(parseNudgeableValue('1.25rem')).toEqual({ number: 1.25, unit: 'rem' })
    expect(parseNudgeableValue('-4%')).toEqual({ number: -4, unit: '%' })
  })

  it('parses a bare unitless number', () => {
    expect(parseNudgeableValue('24')).toEqual({ number: 24, unit: '' })
  })

  it('tolerates surrounding whitespace', () => {
    expect(parseNudgeableValue('  8px  ')).toEqual({ number: 8, unit: 'px' })
  })

  it('returns null for non-nudgeable values', () => {
    expect(parseNudgeableValue('var(--space-md)')).toBeNull()
    expect(parseNudgeableValue('auto')).toBeNull()
    expect(parseNudgeableValue('calc(100% - 8px)')).toBeNull()
    expect(parseNudgeableValue('10px 20px')).toBeNull()
    expect(parseNudgeableValue('')).toBeNull()
    expect(parseNudgeableValue('#4f46e5')).toBeNull()
  })
})

describe('nudgeCssValue', () => {
  it('nudges the number and preserves the unit', () => {
    expect(nudgeCssValue('16px', 'up', BASE_NUDGE)).toBe('17px')
    expect(nudgeCssValue('16px', 'down', BASE_NUDGE)).toBe('15px')
  })

  it('applies the shift (8) big nudge', () => {
    expect(nudgeCssValue('16px', 'up', SHIFT_NUDGE)).toBe('24px')
    expect(nudgeCssValue('16px', 'down', SHIFT_NUDGE)).toBe('8px')
  })

  it('applies the alt (0.1) fine nudge without float dust', () => {
    expect(nudgeCssValue('1.2rem', 'up', FINE_NUDGE)).toBe('1.3rem')
    expect(nudgeCssValue('0.3rem', 'down', FINE_NUDGE)).toBe('0.2rem')
  })

  it('handles unitless values', () => {
    expect(nudgeCssValue('24', 'up', SHIFT_NUDGE)).toBe('32')
  })

  it('can drive a value negative', () => {
    expect(nudgeCssValue('4px', 'down', SHIFT_NUDGE)).toBe('-4px')
  })

  it('leaves non-numeric values untouched (returns null)', () => {
    expect(nudgeCssValue('var(--space-md)', 'up', SHIFT_NUDGE)).toBeNull()
    expect(nudgeCssValue('auto', 'up', BASE_NUDGE)).toBeNull()
    expect(nudgeCssValue('', 'up', BASE_NUDGE)).toBeNull()
  })

  it('starts an empty field from zero when emptyUnit is given', () => {
    expect(nudgeCssValue('', 'up', BASE_NUDGE, { emptyUnit: 'px' })).toBe('1px')
    expect(nudgeCssValue('', 'up', SHIFT_NUDGE, { emptyUnit: 'px' })).toBe('8px')
    expect(nudgeCssValue('   ', 'up', SHIFT_NUDGE, { emptyUnit: 'rem' })).toBe('8rem')
    expect(nudgeCssValue('', 'down', BASE_NUDGE, { emptyUnit: 'px' })).toBe('-1px')
  })

  it('still returns null for non-empty non-numeric values even with emptyUnit', () => {
    expect(nudgeCssValue('auto', 'up', BASE_NUDGE, { emptyUnit: 'px' })).toBeNull()
    expect(nudgeCssValue('var(--space-md)', 'up', SHIFT_NUDGE, { emptyUnit: 'px' })).toBeNull()
  })
})

describe('nudgeNumber', () => {
  it('nudges up and down', () => {
    expect(nudgeNumber(10, 'up', 1)).toBe(11)
    expect(nudgeNumber(10, 'down', 8)).toBe(2)
  })

  it('avoids binary-float dust on fractional steps', () => {
    expect(nudgeNumber(0.2, 'up', 0.1)).toBe(0.3)
  })

  it('clamps to min/max bounds', () => {
    expect(nudgeNumber(1, 'down', 8, { min: 0 })).toBe(0)
    expect(nudgeNumber(0.95, 'up', 0.8, { max: 1 })).toBe(1)
  })
})
