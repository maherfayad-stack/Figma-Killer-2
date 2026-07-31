import { describe, expect, it } from 'bun:test'
import { MIXED, isMixed, collapseValues } from '../index'

describe('MixedValue', () => {
  it('MIXED is a unique symbol, never equal to a string a user could type', () => {
    expect(typeof MIXED).toBe('symbol')
    expect(MIXED === ('__mixed__' as unknown)).toBe(false)
  })

  it('isMixed only recognizes the MIXED sentinel', () => {
    expect(isMixed(MIXED)).toBe(true)
    expect(isMixed('mixed')).toBe(false)
    expect(isMixed(undefined)).toBe(false)
    expect(isMixed(0)).toBe(false)
  })

  it('collapseValues returns the shared value when every item agrees', () => {
    expect(collapseValues([100, 100, 100])).toBe(100)
  })

  it('collapseValues returns MIXED when values disagree', () => {
    expect(collapseValues([100, 200, 100])).toBe(MIXED)
  })

  it('collapseValues returns undefined for an empty selection', () => {
    expect(collapseValues([])).toBeUndefined()
  })

  it('collapseValues treats undefined as a real, comparable value', () => {
    expect(collapseValues([undefined, undefined])).toBeUndefined()
    expect(collapseValues([undefined, 5])).toBe(MIXED)
  })
})
