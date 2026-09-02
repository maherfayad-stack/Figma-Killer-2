/**
 * A numeric style value has to pick up its implied unit somewhere, or the
 * browser drops the declaration outright. The symptom that motivated this: a
 * parsed `style={{ width: size, height: size }}` in an imported component
 * reached the canvas as `width: "44"`, so every inline SVG icon rendered at its
 * own intrinsic size — a 24px check painted 300px wide across its badge.
 */
import { describe, expect, it } from 'bun:test'
import { cssValueForProperty, isUnitlessCssProperty } from '../cssValueForProperty'

describe('cssValueForProperty', () => {
  it('gives a bare number the px unit on a length property', () => {
    expect(cssValueForProperty('width', 44)).toBe('44px')
    expect(cssValueForProperty('height', 24)).toBe('24px')
    expect(cssValueForProperty('marginTop', 8)).toBe('8px')
  })

  it('accepts the kebab spelling of the same property', () => {
    expect(cssValueForProperty('margin-top', 8)).toBe('8px')
    expect(cssValueForProperty('flex-shrink', 1)).toBe('1')
  })

  it('leaves unitless properties bare — px there is invalid and would be dropped', () => {
    expect(cssValueForProperty('flexShrink', 0)).toBe('0')
    expect(cssValueForProperty('flexGrow', 1)).toBe('1')
    expect(cssValueForProperty('zIndex', 10)).toBe('10')
    expect(cssValueForProperty('opacity', 1)).toBe('1')
    expect(cssValueForProperty('lineHeight', 2)).toBe('2')
    expect(cssValueForProperty('fontWeight', 600)).toBe('600')
  })

  it('leaves 0 bare on any property', () => {
    // Valid for every property, and `0px` vs `0` is a pointless difference.
    expect(cssValueForProperty('width', 0)).toBe('0')
  })

  it('passes strings through untouched, including bare numeric strings', () => {
    // An authored `'44'` is the author's call — guessing a unit would change
    // the meaning of a value someone wrote deliberately.
    expect(cssValueForProperty('width', '44')).toBe('44')
    expect(cssValueForProperty('width', '2rem')).toBe('2rem')
    expect(cssValueForProperty('color', 'var(--text-default)')).toBe('var(--text-default)')
  })

  it('never guesses a unit for a custom property', () => {
    // What a bare number means in a `--x` depends on where the `var()` is used.
    expect(cssValueForProperty('--icon-size', 44)).toBe('44')
    expect(isUnitlessCssProperty('--anything')).toBe(true)
  })

  it('still drops a dangerous value', () => {
    // The sanitiser stays the security boundary; this wrapper only adds a unit.
    expect(cssValueForProperty('background', 'expression(document.cookie)')).toBeNull()
    expect(cssValueForProperty('width', 'calc(100% - {})')).toBeNull()
  })

  it('negative numbers keep their unit', () => {
    expect(cssValueForProperty('marginLeft', -8)).toBe('-8px')
  })
})
