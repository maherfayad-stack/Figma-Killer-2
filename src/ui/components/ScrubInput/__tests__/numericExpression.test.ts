/**
 * The shared field-maths evaluator (W8-1 item 3) and the commit coercion that
 * sits on top of it (item 1).
 *
 * The two defects these lock down:
 *   - typing `50` into Width used to emit the invalid declaration `width: 50`;
 *   - typing `100/2` used to be kept verbatim as a literal, producing CSS the
 *     browser drops on the floor.
 *
 * Everything the evaluator REFUSES matters as much as what it accepts: a
 * refusal keeps the user's literal text, which is the only honest answer for
 * a value we did not fully understand.
 */
import { describe, expect, it } from 'bun:test'
import { evaluateNumericExpression, formatNumericExpression } from '../numericExpression'
import { resolveCommitValue } from '../scrubMath'

describe('evaluateNumericExpression', () => {
  it('evaluates a plain number, with and without a unit', () => {
    expect(evaluateNumericExpression('50')).toEqual({ magnitude: 50, unit: '' })
    expect(evaluateNumericExpression('120px')).toEqual({ magnitude: 120, unit: 'px' })
    expect(evaluateNumericExpression('1.25rem')).toEqual({ magnitude: 1.25, unit: 'rem' })
    expect(evaluateNumericExpression('-4%')).toEqual({ magnitude: -4, unit: '%' })
    expect(evaluateNumericExpression('.5')).toEqual({ magnitude: 0.5, unit: '' })
  })

  it('evaluates the four operators', () => {
    expect(evaluateNumericExpression('100/2')).toEqual({ magnitude: 50, unit: '' })
    expect(evaluateNumericExpression('100+8')).toEqual({ magnitude: 108, unit: '' })
    expect(evaluateNumericExpression('100*2')).toEqual({ magnitude: 200, unit: '' })
    expect(evaluateNumericExpression('100-8')).toEqual({ magnitude: 92, unit: '' })
  })

  it('respects precedence and parentheses', () => {
    expect(evaluateNumericExpression('2+3*4')).toEqual({ magnitude: 14, unit: '' })
    expect(evaluateNumericExpression('(2+3)*4')).toEqual({ magnitude: 20, unit: '' })
    expect(evaluateNumericExpression('(80 + 20) / 2')).toEqual({ magnitude: 50, unit: '' })
  })

  it('tolerates whitespace and unary signs', () => {
    expect(evaluateNumericExpression('  100px  +  8  ')).toEqual({ magnitude: 108, unit: 'px' })
    expect(evaluateNumericExpression('-10 + 4')).toEqual({ magnitude: -6, unit: '' })
    expect(evaluateNumericExpression('10 - -4')).toEqual({ magnitude: 14, unit: '' })
  })

  it('carries the single unit seen through the whole expression', () => {
    expect(evaluateNumericExpression('100px/2')).toEqual({ magnitude: 50, unit: 'px' })
    expect(evaluateNumericExpression('2*8rem')).toEqual({ magnitude: 16, unit: 'rem' })
  })

  it('refuses a mix of two units rather than silently picking one', () => {
    expect(evaluateNumericExpression('100px + 8em')).toBeNull()
    expect(evaluateNumericExpression('50% - 4px')).toBeNull()
  })

  it('rounds away binary-float dust', () => {
    expect(evaluateNumericExpression('0.1 + 0.2')).toEqual({ magnitude: 0.3, unit: '' })
  })

  it('refuses everything outside the grammar', () => {
    expect(evaluateNumericExpression('')).toBeNull()
    expect(evaluateNumericExpression('auto')).toBeNull()
    expect(evaluateNumericExpression('calc(100% - 8px)')).toBeNull()
    expect(evaluateNumericExpression('var(--space-md)')).toBeNull()
    expect(evaluateNumericExpression('10px 20px')).toBeNull()
    expect(evaluateNumericExpression('#4f46e5')).toBeNull()
    expect(evaluateNumericExpression('100 +')).toBeNull()
    expect(evaluateNumericExpression('(100 + 8')).toBeNull()
    expect(evaluateNumericExpression('100/0')).toBeNull()
  })
})

describe('formatNumericExpression', () => {
  it('supplies the fallback unit only when the expression had none', () => {
    expect(formatNumericExpression('50', 'px')).toBe('50px')
    expect(formatNumericExpression('100/2', 'px')).toBe('50px')
    expect(formatNumericExpression('2rem', 'px')).toBe('2rem')
    expect(formatNumericExpression('45', 'deg')).toBe('45deg')
  })

  it('leaves a bare number bare for a unitless field', () => {
    expect(formatNumericExpression('50', '')).toBe('50')
  })

  it('returns null when there is nothing to evaluate', () => {
    expect(formatNumericExpression('auto', 'px')).toBeNull()
  })
})

describe('resolveCommitValue', () => {
  // The bug this closes: `width: 50` is not a CSS declaration.
  it('gives a typed bare number the field unit', () => {
    expect(resolveCommitValue('50', 'px')).toBe('50px')
    expect(resolveCommitValue('45', 'deg')).toBe('45deg')
  })

  it('evaluates arithmetic on commit', () => {
    expect(resolveCommitValue('100/2', 'px')).toBe('50px')
    expect(resolveCommitValue('100 + 8', 'px')).toBe('108px')
    expect(resolveCommitValue('100px*2', 'px')).toBe('200px')
  })

  it('leaves an already-united value exactly as typed', () => {
    expect(resolveCommitValue('12rem', 'px')).toBe('12rem')
    expect(resolveCommitValue('50%', 'px')).toBe('50%')
  })

  it('passes layout keywords through untouched', () => {
    expect(resolveCommitValue('auto', 'px')).toBe('auto')
    expect(resolveCommitValue('hug', 'px')).toBe('hug')
    expect(resolveCommitValue('fill', 'px')).toBe('fill')
  })

  it('keeps the literal for anything it cannot reduce', () => {
    expect(resolveCommitValue('calc(100% - 8px)', 'px')).toBe('calc(100% - 8px)')
    expect(resolveCommitValue('var(--space-md)', 'px')).toBe('var(--space-md)')
    expect(resolveCommitValue('10px 20px', 'px')).toBe('10px 20px')
  })

  it('keeps an empty commit empty (a clear, not a zero)', () => {
    expect(resolveCommitValue('', 'px')).toBe('')
    expect(resolveCommitValue('   ', 'px')).toBe('')
  })
})
