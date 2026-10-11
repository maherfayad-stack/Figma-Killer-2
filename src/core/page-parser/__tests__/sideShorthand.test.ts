import { describe, expect, it } from 'bun:test'
import { expandSideShorthand } from '../sideShorthand'

describe('expandSideShorthand', () => {
  it('applies the CSS 1-to-4 value rule', () => {
    expect(expandSideShorthand('padding', '4px')).toEqual({ paddingTop: '4px', paddingRight: '4px', paddingBottom: '4px', paddingLeft: '4px' })
    expect(expandSideShorthand('padding', '1px 2px 3px')).toEqual({ paddingTop: '1px', paddingRight: '2px', paddingBottom: '3px', paddingLeft: '2px' })
    expect(expandSideShorthand('margin', '1px 2px 3px 4px')).toEqual({ marginTop: '1px', marginRight: '2px', marginBottom: '3px', marginLeft: '4px' })
  })

  it('keeps a function value whole', () => {
    expect(expandSideShorthand('padding', 'calc(1px + 2px) var(--space-md)')).toMatchObject({
      paddingTop: 'calc(1px + 2px)',
      paddingRight: 'var(--space-md)',
    })
  })

  it('refuses what is not a plain value list', () => {
    expect(expandSideShorthand('padding', 'inherit')).toBeUndefined()
    expect(expandSideShorthand('padding', '4px !important')).toBeUndefined()
    expect(expandSideShorthand('padding', '1px 2px 3px 4px 5px')).toBeUndefined()
  })
})
