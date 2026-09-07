/**
 * The third write-lock state: a count, not a boolean (W8-3 phase 2).
 *
 * The failure this pins: `setNodesInlineStyles` deliberately skips the
 * individual nodes whose source refuses a property and writes the rest, so a
 * bulk edit can land on three of five layers. A boolean lock can only call
 * that "unlocked" (the panel claiming a clean write to all five) or "locked"
 * (disabling a control that works for three). The reach carries the numbers
 * so the row can stay editable AND say what it did.
 */
import { describe, expect, it } from 'bun:test'
import {
  blockedProperties,
  buildInlineStyleWriteReach,
  describeReach,
  reachForProperty,
} from '../styleWriteReach'

const REASON = 'set from an expression in code'

describe('buildInlineStyleWriteReach', () => {
  it('counts only style: entries, per property', () => {
    const reach = buildInlineStyleWriteReach(
      [
        { codeProps: ['style:width', 'children'] },
        { codeProps: ['style:width', 'style:color'] },
        {},
      ],
      REASON,
    )

    expect(reach.total).toBe(3)
    expect(reach.blockedByProperty.get('width')).toBe(2)
    expect(reach.blockedByProperty.get('color')).toBe(1)
    // `children` is a prop lock, not a style lock — it must not appear.
    expect(reach.blockedByProperty.has('children')).toBe(false)
    expect(blockedProperties(reach)).toEqual(['width', 'color'])
  })

  it('reports full reach for a property nothing refuses', () => {
    const reach = buildInlineStyleWriteReach([{ codeProps: ['style:width'] }, {}], REASON)
    expect(reachForProperty(reach, 'color')).toEqual({ writable: 2, total: 2, blocked: 0 })
  })
})

describe('describeReach', () => {
  it('says nothing when the write reaches every target', () => {
    const reach = buildInlineStyleWriteReach([{}, {}, {}], REASON)
    expect(describeReach(reach, 'color')).toBeNull()
  })

  it('states the count for a partial reach', () => {
    const reach = buildInlineStyleWriteReach(
      [{ codeProps: ['style:width'] }, { codeProps: ['style:width'] }, {}, {}, {}],
      REASON,
    )
    expect(describeReach(reach, 'width')).toBe(
      'Writes to 3 of 5 selected layers — 2 are set from an expression in code.',
    )
  })

  it('does not count to zero when nothing takes the edit', () => {
    const reach = buildInlineStyleWriteReach(
      [{ codeProps: ['style:width'] }, { codeProps: ['style:width'] }],
      REASON,
    )
    expect(describeReach(reach, 'width')).toBe(
      'No selected layer takes this edit — all are set from an expression in code.',
    )
  })
})
