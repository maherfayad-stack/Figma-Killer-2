/**
 * Flip horizontal / vertical (W8-1 item 5), backed by the standalone `scale`
 * property. The load-bearing behaviours: an unflipped element gets NO
 * declaration, and a `scale` value outside the plain-number space is refused
 * rather than overwritten.
 */
import { describe, expect, it } from 'bun:test'
import { parseFlipState, serializeFlipState, toggleFlipAxis, TRANSFORM_SCALE_FN_RE } from './flipValue'

describe('parseFlipState', () => {
  it('reads an unset / none scale as the identity', () => {
    expect(parseFlipState(undefined)).toEqual({ x: 1, y: 1 })
    expect(parseFlipState(null)).toEqual({ x: 1, y: 1 })
    expect(parseFlipState('')).toEqual({ x: 1, y: 1 })
    expect(parseFlipState('none')).toEqual({ x: 1, y: 1 })
  })

  it('expands CSS\'s one-value form to both axes', () => {
    expect(parseFlipState('2')).toEqual({ x: 2, y: 2 })
    expect(parseFlipState('-1')).toEqual({ x: -1, y: -1 })
  })

  it('reads the two-value form', () => {
    expect(parseFlipState('-1 1')).toEqual({ x: -1, y: 1 })
    expect(parseFlipState('1  -1')).toEqual({ x: 1, y: -1 })
    expect(parseFlipState('  0.5 2 ')).toEqual({ x: 0.5, y: 2 })
  })

  it('refuses values this control cannot reproduce', () => {
    expect(parseFlipState('50%')).toBeNull()
    expect(parseFlipState('1 1 1')).toBeNull()
    expect(parseFlipState('var(--flip)')).toBeNull()
    expect(parseFlipState('calc(1 * -1)')).toBeNull()
  })
})

describe('serializeFlipState', () => {
  it('writes nothing for an unflipped element', () => {
    expect(serializeFlipState({ x: 1, y: 1 })).toBeUndefined()
  })

  it('collapses equal factors to the one-value form', () => {
    expect(serializeFlipState({ x: -1, y: -1 })).toBe('-1')
  })

  it('writes both axes when they differ', () => {
    expect(serializeFlipState({ x: -1, y: 1 })).toBe('-1 1')
    expect(serializeFlipState({ x: 1, y: -1 })).toBe('1 -1')
  })
})

describe('toggleFlipAxis', () => {
  it('flips one axis at a time and back again', () => {
    const identity = { x: 1, y: 1 }
    const flippedH = toggleFlipAxis(identity, 'x')
    expect(serializeFlipState(flippedH)).toBe('-1 1')
    expect(serializeFlipState(toggleFlipAxis(flippedH, 'x'))).toBeUndefined()

    const flippedBoth = toggleFlipAxis(flippedH, 'y')
    expect(serializeFlipState(flippedBoth)).toBe('-1')
  })

  it('preserves a non-unit scale factor while flipping its sign', () => {
    expect(serializeFlipState(toggleFlipAxis({ x: 2, y: 2 }, 'x'))).toBe('-2 2')
  })
})

describe('TRANSFORM_SCALE_FN_RE', () => {
  it('matches every scale-family transform function', () => {
    for (const value of ['scale(2)', 'scaleX(-1)', 'scaleY(-1)', 'scaleZ(2)', 'scale3d(1, 1, 1)', 'rotate(4deg) scale( 2 )']) {
      expect(TRANSFORM_SCALE_FN_RE.test(value)).toBe(true)
    }
  })

  it('does not match unrelated transforms', () => {
    for (const value of ['rotate(45deg)', 'translateX(4px)', 'none', 'skew(2deg)']) {
      expect(TRANSFORM_SCALE_FN_RE.test(value)).toBe(false)
    }
  })
})
