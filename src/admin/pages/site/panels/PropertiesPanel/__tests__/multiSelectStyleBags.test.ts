/**
 * multiSelectStyleBags — collapsing N nodes into the two bags the shared
 * section editor renders (W8-3 phase 1).
 *
 * Covers:
 *   1. Agreement collapses to the shared value; disagreement collapses to
 *      `MIXED` — including the "set on one, absent on the other" case, which
 *      is a disagreement, not a value to silently prefer.
 *   2. A property nothing declares stays out of both bags entirely (so the
 *      section disclosure law still sees it as unset).
 *   3. `MIXED` survives `hasStyleValue`, which is what makes a mixed property
 *      count as SET for the indicator dot / "N set" meta / Law 1.
 *   4. `currentStyles` is the EFFECTIVE layer: inline outranks a class, a lone
 *      class wins, and several classes declaring the same property with no
 *      computed value to arbitrate resolve to no winner rather than a guess.
 *   5. An empty selection yields empty bags.
 */
import { describe, it, expect } from 'bun:test'
import { MIXED } from '@ui/components/MixedValue'
import { hasStyleValue } from '../styleValueUtils'
import { buildMultiSelectStyleBags, type MultiSelectStyleNode } from '../multiSelectStyleBags'

function node(
  inlineStyles: Record<string, unknown> = {},
  classes: Array<{ id: string; selector: string; styles: Record<string, unknown> }> = [],
): MultiSelectStyleNode {
  return {
    inlineStyles,
    classChain: classes.map((cls) => ({
      classId: cls.id,
      selector: cls.selector,
      styles: cls.styles,
    })),
  }
}

const PROPS = ['color', 'display', 'fontSize'] as const

describe('buildMultiSelectStyleBags — storedStyles (the inline editing target)', () => {
  it('collapses agreeing inline values to the shared value', () => {
    const { storedStyles } = buildMultiSelectStyleBags(
      [node({ color: 'red' }), node({ color: 'red' })],
      PROPS,
    )
    expect(storedStyles.color).toBe('red')
  })

  it('collapses disagreeing inline values to MIXED', () => {
    const { storedStyles } = buildMultiSelectStyleBags(
      [node({ color: 'red' }), node({ color: 'blue' })],
      PROPS,
    )
    expect(storedStyles.color).toBe(MIXED)
  })

  it('treats "set on one, unset on another" as MIXED, not as the set value', () => {
    const { storedStyles } = buildMultiSelectStyleBags([node({ color: 'red' }), node({})], PROPS)
    expect(storedStyles.color).toBe(MIXED)
  })

  it('leaves a property nothing declares out of the bag', () => {
    const { storedStyles } = buildMultiSelectStyleBags([node({}), node({})], PROPS)
    expect('color' in storedStyles).toBe(false)
  })

  it('MIXED reads as SET, so a mixed property still opens its section', () => {
    const { storedStyles } = buildMultiSelectStyleBags(
      [node({ display: 'flex' }), node({ display: 'grid' })],
      PROPS,
    )
    expect(hasStyleValue(storedStyles.display)).toBe(true)
  })
})

describe('buildMultiSelectStyleBags — currentStyles (the effective layer)', () => {
  it('lets an inline declaration outrank a class on the same node', () => {
    const withInline = node({ color: 'red' }, [{ id: 'c1', selector: '.a', styles: { color: 'blue' } }])
    const { currentStyles } = buildMultiSelectStyleBags([withInline, withInline], PROPS)
    expect(currentStyles.color).toBe('red')
  })

  it('uses a lone class declaration when nothing is set inline', () => {
    const withClass = node({}, [{ id: 'c1', selector: '.a', styles: { color: 'green' } }])
    const { currentStyles } = buildMultiSelectStyleBags([withClass, withClass], PROPS)
    expect(currentStyles.color).toBe('green')
  })

  it('reports MIXED when two nodes render different effective values', () => {
    const { currentStyles } = buildMultiSelectStyleBags(
      [
        node({}, [{ id: 'c1', selector: '.a', styles: { color: 'green' } }]),
        node({}, [{ id: 'c2', selector: '.b', styles: { color: 'purple' } }]),
      ],
      PROPS,
    )
    expect(currentStyles.color).toBe(MIXED)
  })

  it('refuses to crown a winner when several classes declare the property', () => {
    // No computed value is available for a multi-selection (see the module
    // doc), so an ambiguous cascade produces no effective value at all rather
    // than a plausible-looking guess.
    const ambiguous = node({}, [
      { id: 'c1', selector: '.a', styles: { color: 'green' } },
      { id: 'c2', selector: '.b', styles: { color: 'purple' } },
    ])
    const { currentStyles } = buildMultiSelectStyleBags([ambiguous, ambiguous], PROPS)
    expect('color' in currentStyles).toBe(false)
  })
})

describe('buildMultiSelectStyleBags — edges', () => {
  it('returns empty bags for an empty selection', () => {
    const { storedStyles, currentStyles } = buildMultiSelectStyleBags([], PROPS)
    expect(storedStyles).toEqual({})
    expect(currentStyles).toEqual({})
  })

  it('collapses a single-node selection to that node’s own values', () => {
    const { storedStyles } = buildMultiSelectStyleBags([node({ fontSize: '12px' })], PROPS)
    expect(storedStyles.fontSize).toBe('12px')
  })
})
