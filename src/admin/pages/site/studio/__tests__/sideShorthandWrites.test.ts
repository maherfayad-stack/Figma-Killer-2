import { describe, expect, it } from 'bun:test'
import { coalesceCssSideChanges, coalesceInlineSideWrites } from '../sideShorthandWrites'

describe('coalesceInlineSideWrites', () => {
  it('turns four equal padding sides into one shorthand and removes the longhands', () => {
    const wire = coalesceInlineSideWrites(
      { paddingTop: '16px', paddingRight: '16px', paddingBottom: '16px', paddingLeft: '16px', color: 'red' },
      [],
    )
    expect(wire.style).toEqual({ color: 'red', padding: '16px' })
    expect([...wire.remove].sort()).toEqual(['paddingBottom', 'paddingLeft', 'paddingRight', 'paddingTop'])
  })

  it('writes the shortest shorthand for unequal sides', () => {
    const wire = coalesceInlineSideWrites(
      { marginTop: '8px', marginRight: '16px', marginBottom: '8px', marginLeft: '16px' },
      [],
    )
    expect(wire.style).toEqual({ margin: '8px 16px' })
  })

  it('leaves a partial patch as longhands', () => {
    const wire = coalesceInlineSideWrites({ paddingTop: '4px', paddingLeft: '4px' }, [])
    expect(wire.style).toEqual({ paddingTop: '4px', paddingLeft: '4px' })
    expect(wire.remove).toEqual([])
  })

  it('removing all four sides also removes the shorthand an earlier save wrote', () => {
    const wire = coalesceInlineSideWrites({}, ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'])
    expect(wire.remove).toContain('padding')
  })

  it('removing fewer than four sides does not touch the shorthand', () => {
    const wire = coalesceInlineSideWrites({}, ['paddingTop'])
    expect(wire.remove).toEqual(['paddingTop'])
  })
})

describe('coalesceCssSideChanges', () => {
  it('replaces four padding longhand sets with unsets then one shorthand', () => {
    const out = coalesceCssSideChanges([
      { property: 'padding-top', value: '12px' },
      { property: 'padding-right', value: '12px' },
      { property: 'padding-bottom', value: '12px' },
      { property: 'padding-left', value: '12px' },
      { property: 'color', value: 'red' },
    ])
    expect(out.at(-1)).toEqual({ property: 'padding', value: '12px' })
    expect(out.filter((c) => c.value === null).map((c) => c.property).sort()).toEqual([
      'padding-bottom',
      'padding-left',
      'padding-right',
      'padding-top',
    ])
    expect(out.find((c) => c.property === 'color')).toEqual({ property: 'color', value: 'red' })
    // Unsets come before the shorthand set so a stale longhand cannot out-rank it.
    expect(out.findIndex((c) => c.property === 'padding-top')).toBeLessThan(
      out.findIndex((c) => c.property === 'padding'),
    )
  })

  it('leaves three sides alone', () => {
    const changes = [
      { property: 'padding-top', value: '12px' },
      { property: 'padding-right', value: '12px' },
      { property: 'padding-bottom', value: '12px' },
    ]
    expect(coalesceCssSideChanges(changes)).toEqual(changes)
  })

  it('removing all four sides also removes the shorthand', () => {
    const out = coalesceCssSideChanges(
      ['top', 'right', 'bottom', 'left'].map((side) => ({ property: `margin-${side}`, value: null })),
    )
    expect(out).toContainEqual({ property: 'margin', value: null })
  })
})
