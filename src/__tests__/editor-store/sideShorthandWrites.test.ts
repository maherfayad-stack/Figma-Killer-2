import { describe, expect, it } from 'bun:test'
import { coalesceCssSideChanges, coalesceInlineSideWrites } from '@site/studio/sideShorthandWrites'

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

describe('border stroke coalescing', () => {
  const sides = ['Top', 'Right', 'Bottom', 'Left']
  const inlineStroke = Object.fromEntries(
    sides.flatMap((side) => [
      [`border${side}Width`, '1px'],
      [`border${side}Style`, 'solid'],
      [`border${side}Color`, '#808080'],
    ]),
  )

  it('writes twelve equal border longhands as ONE `border` shorthand', () => {
    const wire = coalesceInlineSideWrites(inlineStroke, [])
    expect(wire.style).toEqual({ border: '1px solid #808080' })
    expect(wire.remove).toHaveLength(12)
  })

  it('keeps longhands when the sides disagree on a field', () => {
    const wire = coalesceInlineSideWrites({ ...inlineStroke, borderTopWidth: '2px' }, [])
    expect(wire.style.border).toBeUndefined()
    expect(wire.style.borderTopWidth).toBe('2px')
  })

  it('removing all twelve longhands also removes the `border` shorthand', () => {
    const wire = coalesceInlineSideWrites({}, Object.keys(inlineStroke))
    expect(wire.remove).toContain('border')
  })

  it('does the same for stylesheet declarations', () => {
    const changes = sides.flatMap((side) =>
      ['width', 'style', 'color'].map((field) => ({
        property: `border-${side.toLowerCase()}-${field}`,
        value: field === 'width' ? '1px' : field === 'style' ? 'solid' : '#808080',
      })),
    )
    const out = coalesceCssSideChanges(changes)
    expect(out.at(-1)).toEqual({ property: 'border', value: '1px solid #808080' })
    expect(out.filter((change) => change.value === null)).toHaveLength(12)
  })
})
