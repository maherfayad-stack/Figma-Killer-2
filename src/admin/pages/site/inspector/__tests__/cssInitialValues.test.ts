/**
 * cssInitialValues — proves this table is NOT `DEFAULT_CSS_VALUES`
 * (`panels/PropertiesPanel/cssControlTypes.ts`), which gets `objectFit`
 * wrong (`'cover'` instead of the CSS spec's own `'fill'`) and would
 * therefore misjudge an element with a genuinely-initial `object-fit` as
 * "something real is rendering here" — see `STATE.md` `panel-30`.
 */
import { describe, expect, it } from 'bun:test'
import { isTrueCssInitialValue } from '../cssInitialValues'

describe('isTrueCssInitialValue', () => {
  it('reads backgroundColor: transparent as the true initial', () => {
    expect(isTrueCssInitialValue('backgroundColor', 'transparent')).toBe(true)
  })

  it('reads backgroundColor: rgba(0, 0, 0, 0) as the SAME initial, a different spelling', () => {
    expect(isTrueCssInitialValue('backgroundColor', 'rgba(0, 0, 0, 0)')).toBe(true)
  })

  it('reads objectFit: fill as the true initial — proving this is NOT DEFAULT_CSS_VALUES, which says "cover"', () => {
    expect(isTrueCssInitialValue('objectFit', 'fill')).toBe(true)
  })

  it('does NOT read objectFit: cover as the initial — DEFAULT_CSS_VALUES would get this backwards', () => {
    expect(isTrueCssInitialValue('objectFit', 'cover')).toBe(false)
  })

  it('reads objectPosition: 50% 50% (what getComputedStyle actually reports) as the true initial', () => {
    expect(isTrueCssInitialValue('objectPosition', '50% 50%')).toBe(true)
  })

  it('a real, non-default colour reads as non-initial', () => {
    expect(isTrueCssInitialValue('backgroundColor', '#ff0000')).toBe(false)
    expect(isTrueCssInitialValue('backgroundColor', 'rgb(255, 0, 0)')).toBe(false)
  })

  it('a real, non-default keyword reads as non-initial', () => {
    expect(isTrueCssInitialValue('backgroundRepeat', 'no-repeat')).toBe(false)
    expect(isTrueCssInitialValue('objectFit', 'cover')).toBe(false)
  })

  it('defaults to "meaningful" (false) for a property this table does not cover', () => {
    expect(isTrueCssInitialValue('background', 'red url(hero.png) no-repeat')).toBe(false)
  })

  it('defaults to "meaningful" (false) for an unparseable colour value', () => {
    expect(isTrueCssInitialValue('backgroundColor', 'var(--brand)')).toBe(false)
  })
})
