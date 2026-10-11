import { describe, expect, it } from 'bun:test'
import { parseBorderShorthand, withBorderShorthandExpanded } from '../borderShorthand'

describe('parseBorderShorthand', () => {
  it('splits width, style and colour in any order', () => {
    expect(parseBorderShorthand('1px solid #808080')).toEqual({ width: '1px', style: 'solid', color: '#808080' })
    expect(parseBorderShorthand('solid red 2px')).toEqual({ width: '2px', style: 'solid', color: 'red' })
  })

  it('keeps a colour function as one token', () => {
    expect(parseBorderShorthand('1px solid rgb(0 0 0 / 50%)')?.color).toBe('rgb(0 0 0 / 50%)')
    expect(parseBorderShorthand('1px solid var(--line)')?.color).toBe('var(--line)')
  })

  it('refuses a value it cannot place', () => {
    expect(parseBorderShorthand('1px solid red blue')).toBeNull()
  })
})

describe('withBorderShorthandExpanded', () => {
  it('spreads the shorthand onto all twelve longhands', () => {
    const out = withBorderShorthandExpanded({ border: '1px solid #808080' })
    expect(out.borderTopWidth).toBe('1px')
    expect(out.borderLeftStyle).toBe('solid')
    expect(out.borderBottomColor).toBe('#808080')
  })

  it('lets a side longhand win over the shorthand', () => {
    const out = withBorderShorthandExpanded({ border: '1px solid red', borderTopColor: 'blue' })
    expect(out.borderTopColor).toBe('blue')
    expect(out.borderRightColor).toBe('red')
  })

  it('returns the same bag when there is no shorthand', () => {
    const bag = { borderTopWidth: '2px' }
    expect(withBorderShorthandExpanded(bag)).toBe(bag)
  })
})
