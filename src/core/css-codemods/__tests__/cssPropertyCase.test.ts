import { describe, expect, it } from 'bun:test'
import { camelToKebabCssProperty } from '../cssPropertyCase'

describe('camelToKebabCssProperty', () => {
  it('converts a simple camelCase property', () => {
    expect(camelToKebabCssProperty('backgroundColor')).toBe('background-color')
  })

  it('converts a property with a leading capital run', () => {
    expect(camelToKebabCssProperty('zIndex')).toBe('z-index')
  })

  it('converts a property with several humps', () => {
    expect(camelToKebabCssProperty('borderTopLeftRadius')).toBe('border-top-left-radius')
  })

  it('leaves an already-kebab or lowercase property untouched', () => {
    expect(camelToKebabCssProperty('color')).toBe('color')
    expect(camelToKebabCssProperty('flex-grow')).toBe('flex-grow')
  })
})
