import { describe, expect, it } from 'bun:test'
import {
  applyKeyboardStep,
  applyScrubDelta,
  formatScrubValue,
  isScrubKeyword,
  parseScrubValue,
} from '../scrubMath'

describe('parseScrubValue', () => {
  it('parses a plain px length', () => {
    expect(parseScrubValue('120px')).toEqual({ magnitude: 120, unit: 'px' })
  })

  it('parses a negative decimal with a unit', () => {
    expect(parseScrubValue('-1.5rem')).toEqual({ magnitude: -1.5, unit: 'rem' })
  })

  it('parses a percentage', () => {
    expect(parseScrubValue('50%')).toEqual({ magnitude: 50, unit: '%' })
  })

  it('parses a bare unitless number', () => {
    expect(parseScrubValue('12')).toEqual({ magnitude: 12, unit: '' })
  })

  it('trims surrounding whitespace', () => {
    expect(parseScrubValue('  8px  ')).toEqual({ magnitude: 8, unit: 'px' })
  })

  it('returns null for a keyword', () => {
    expect(parseScrubValue('auto')).toBeNull()
  })

  it('returns null for a calc() expression', () => {
    expect(parseScrubValue('calc(100% - 8px)')).toBeNull()
  })

  it('returns null for an empty string', () => {
    expect(parseScrubValue('')).toBeNull()
  })

  it('returns null for a var() reference', () => {
    expect(parseScrubValue('var(--space-md)')).toBeNull()
  })
})

describe('isScrubKeyword', () => {
  it('recognizes auto/fill/hug case-insensitively and trimmed', () => {
    expect(isScrubKeyword('auto')).toBe(true)
    expect(isScrubKeyword('Fill')).toBe(true)
    expect(isScrubKeyword('  HUG  ')).toBe(true)
  })

  it('rejects a numeric value', () => {
    expect(isScrubKeyword('120px')).toBe(false)
  })

  it('rejects an unrelated keyword', () => {
    expect(isScrubKeyword('none')).toBe(false)
  })
})

describe('formatScrubValue', () => {
  it('appends the unit', () => {
    expect(formatScrubValue(120, 'px')).toBe('120px')
  })

  it('rounds to 2 decimal places', () => {
    expect(formatScrubValue(1.23456, 'rem')).toBe('1.23rem')
  })

  it('drops trailing zeros via numeric rounding', () => {
    expect(formatScrubValue(10.0, 'px')).toBe('10px')
  })
})

describe('applyScrubDelta', () => {
  it('adds a positive pixel delta at 1:1 scale', () => {
    expect(applyScrubDelta('100px', 24)).toBe('124px')
  })

  it('subtracts a negative pixel delta', () => {
    expect(applyScrubDelta('100px', -24)).toBe('76px')
  })

  it('applies a scale factor (Shift-held coarse drag)', () => {
    expect(applyScrubDelta('100px', 5, { scale: 10 })).toBe('150px')
  })

  it('applies a fractional scale (Alt-held fine drag)', () => {
    expect(applyScrubDelta('100px', 10, { scale: 0.1 })).toBe('101px')
  })

  it('preserves the unit of the starting value', () => {
    expect(applyScrubDelta('2rem', 1)).toBe('3rem')
  })

  it('starts from 0 with the fallback unit when the field is empty', () => {
    expect(applyScrubDelta('', 5, { fallbackUnit: 'px' })).toBe('5px')
  })

  it('clamps to a minimum', () => {
    expect(applyScrubDelta('5px', -100, { min: 0 })).toBe('0px')
  })

  it('clamps to a maximum', () => {
    expect(applyScrubDelta('5px', 1000, { max: 100 })).toBe('100px')
  })

  it('returns null for a non-scrubbable keyword value', () => {
    expect(applyScrubDelta('auto', 10)).toBeNull()
  })

  it('returns null for a calc() expression', () => {
    expect(applyScrubDelta('calc(100% - 8px)', 10)).toBeNull()
  })
})

describe('applyKeyboardStep', () => {
  it('steps by 1 with no modifier', () => {
    expect(applyKeyboardStep('10px', 1)).toBe('11px')
    expect(applyKeyboardStep('10px', -1)).toBe('9px')
  })

  it('steps by shiftStep (default 10) when shift is held', () => {
    expect(applyKeyboardStep('10px', 1, { shift: true })).toBe('20px')
  })

  it('honors a custom step / shiftStep', () => {
    expect(applyKeyboardStep('10px', 1, { step: 5 })).toBe('15px')
    expect(applyKeyboardStep('10px', 1, { shift: true, shiftStep: 100 })).toBe('110px')
  })

  it('respects min/max while stepping', () => {
    expect(applyKeyboardStep('0px', -1, { min: 0 })).toBe('0px')
  })

  it('returns null for a keyword — the caller must not silently coerce it', () => {
    expect(applyKeyboardStep('hug', 1)).toBeNull()
  })
})
