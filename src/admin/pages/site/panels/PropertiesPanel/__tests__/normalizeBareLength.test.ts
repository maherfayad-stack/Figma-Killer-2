import { describe, expect, it } from 'bun:test'
import { normalizeBareLength } from '../cssControlTypes'

describe('normalizeBareLength', () => {
  it('gives a bare line-height number of 10 or more pixels (24 was written as 288px)', () => {
    expect(normalizeBareLength('lineHeight', '24')).toBe('24px')
    expect(normalizeBareLength('lineHeight', '10')).toBe('10px')
    expect(normalizeBareLength('lineHeight', ' 18.5 ')).toBe('18.5px')
  })

  it('keeps a unitless ratio a ratio', () => {
    expect(normalizeBareLength('lineHeight', '1.5')).toBe('1.5')
    expect(normalizeBareLength('lineHeight', '2')).toBe('2')
  })

  it('leaves explicit units, percentages and keywords untouched', () => {
    expect(normalizeBareLength('lineHeight', '24px')).toBe('24px')
    expect(normalizeBareLength('lineHeight', '150%')).toBe('150%')
    expect(normalizeBareLength('lineHeight', '1.5em')).toBe('1.5em')
    expect(normalizeBareLength('lineHeight', 'normal')).toBe('normal')
    expect(normalizeBareLength('lineHeight', 'calc(1px + 2px)')).toBe('calc(1px + 2px)')
  })

  it('does nothing for other properties (their field unit already supplies px)', () => {
    expect(normalizeBareLength('letterSpacing', '24')).toBe('24')
  })
})
