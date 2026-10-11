/**
 * `shorthandCoverage` — which shorthands reset which longhands, and how one
 * longhand's new value is spelled inside the shorthand that sets it.
 *
 * The coverage cases are the table the inspector actually emits; the expansion
 * cases pin the token arithmetic (a box value is 1-4 tokens, the count only
 * grows when the edit needs it) and every shape that must answer `null` so the
 * caller falls to an `!important` longhand instead of guessing.
 */
import { describe, expect, it } from 'bun:test'
import { expandShorthandSide, shorthandCovers } from '../shorthandCoverage'

describe('shorthandCovers — the shorthands the inspector actually emits', () => {
  const cases: ReadonlyArray<readonly [shorthand: string, longhand: string]> = [
    ['margin', 'margin-top'],
    ['padding', 'padding-left'],
    ['background', 'background-color'],
    ['font', 'font-size'],
    ['border', 'border-color'],
    ['border-radius', 'border-top-left-radius'],
    ['flex', 'flex-grow'],
    ['gap', 'row-gap'],
    ['inset', 'top'],
    ['overflow', 'overflow-x'],
    ['transition', 'transition-duration'],
  ]
  for (const [shorthand, longhand] of cases) {
    it(`${shorthand} resets ${longhand}`, () => {
      expect(shorthandCovers(shorthand, longhand)).toBe(true)
    })
  }

  it('does not cover an unrelated property, or itself', () => {
    expect(shorthandCovers('margin', 'color')).toBe(false)
    expect(shorthandCovers('padding', 'padding')).toBe(false)
    expect(shorthandCovers('padding', 'margin-top')).toBe(false)
  })
})

describe('expandShorthandSide — the same declaration, one side changed', () => {
  it('spreads a one-token box to the slot that changed', () => {
    expect(expandShorthandSide('padding', '8px', 'padding-top', '12px')).toBe('12px 8px 8px')
    expect(expandShorthandSide('padding', '8px', 'padding-left', '12px')).toBe('8px 8px 8px 12px')
  })

  it('reads the two- and three-token forms the way CSS does', () => {
    expect(expandShorthandSide('margin', '4px 8px', 'margin-bottom', '12px')).toBe('4px 8px 12px')
    expect(expandShorthandSide('margin', '4px 8px', 'margin-left', '12px')).toBe('4px 8px 4px 12px')
    expect(expandShorthandSide('margin', '4px 8px 6px', 'margin-left', '12px')).toBe('4px 8px 6px 12px')
    expect(expandShorthandSide('margin', '4px 8px 6px', 'margin-top', '2px')).toBe('2px 8px 6px')
  })

  it('never shrinks the token count the author wrote', () => {
    expect(expandShorthandSide('padding', '4px 8px 4px 8px', 'padding-top', '4px')).toBe('4px 8px 4px 8px')
    expect(expandShorthandSide('padding', '4px 8px', 'padding-right', '4px')).toBe('4px 4px 4px 8px')
  })

  it('handles inset, per-side border widths and the corner radii', () => {
    expect(expandShorthandSide('inset', '0', 'top', '8px')).toBe('8px 0 0')
    expect(expandShorthandSide('border-width', '1px 2px', 'border-bottom-width', '3px')).toBe('1px 2px 3px')
    expect(expandShorthandSide('border-radius', '4px', 'border-bottom-right-radius', '12px')).toBe('4px 4px 12px')
  })

  it('handles the row/column pairs', () => {
    expect(expandShorthandSide('gap', '8px', 'column-gap', '16px')).toBe('8px 16px')
    expect(expandShorthandSide('gap', '8px 16px', 'row-gap', '4px')).toBe('4px 16px')
    expect(expandShorthandSide('overflow', 'hidden', 'overflow-y', 'auto')).toBe('hidden auto')
  })

  it('keeps a calc() token whole', () => {
    expect(expandShorthandSide('padding', 'calc(1px + 2px) 8px', 'padding-top', '4px')).toBe('4px 8px calc(1px + 2px)')
  })

  it('answers null for every shape it cannot read side by side', () => {
    expect(expandShorthandSide('background', 'red', 'background-color', 'blue')).toBeNull()
    expect(expandShorthandSide('padding', 'var(--pad)', 'padding-top', '4px')).toBeNull()
    expect(expandShorthandSide('padding', '8px', 'padding-top', 'var(--pad)')).toBeNull()
    expect(expandShorthandSide('padding', '8px', 'padding-top', '4px 6px')).toBeNull()
    expect(expandShorthandSide('padding', '1px 2px 3px 4px 5px', 'padding-top', '4px')).toBeNull()
    expect(expandShorthandSide('border-radius', '8px / 4px', 'border-top-left-radius', '2px')).toBeNull()
    expect(expandShorthandSide('padding', '8px /* x */', 'padding-top', '4px')).toBeNull()
    expect(expandShorthandSide('padding', 'calc(1px', 'padding-top', '4px')).toBeNull()
    expect(expandShorthandSide('padding', '8px', 'margin-top', '4px')).toBeNull()
  })
})
