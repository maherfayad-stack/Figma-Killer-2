import { describe, expect, it } from 'bun:test'
import { dropSlotAt, paintIndexForDrop } from '@admin/pages/site/panels/ExplorerPanel/canvasLayerRowDrop'

// Four 28px rows, top-first: rows 0..3 span 0-28, 28-56, 56-84, 84-112.
const rows = [0, 1, 2, 3].map((i) => ({ top: i * 28, bottom: i * 28 + 28 }))

describe('dropSlotAt', () => {
  it('picks the gap by row midpoint', () => {
    expect(dropSlotAt(rows, 2)).toBe(0)
    expect(dropSlotAt(rows, 13)).toBe(0)
    expect(dropSlotAt(rows, 15)).toBe(1)
    expect(dropSlotAt(rows, 60)).toBe(2)
    expect(dropSlotAt(rows, 111)).toBe(4)
    expect(dropSlotAt(rows, 500)).toBe(4)
  })
})

describe('paintIndexForDrop', () => {
  // Display order is front-first, so display row 0 is paint index 3 of 4.
  it('dropping a row where it is changes nothing', () => {
    for (let from = 0; from < 4; from += 1) {
      const own = 3 - from
      expect(paintIndexForDrop(from, from, 4)).toBe(own)
      expect(paintIndexForDrop(from, from + 1, 4)).toBe(own)
    }
  })

  it('the top slot is the front and the bottom slot is the back', () => {
    expect(paintIndexForDrop(2, 0, 4)).toBe(3)
    expect(paintIndexForDrop(1, 4, 4)).toBe(0)
  })

  it('a drop between two other rows lands between them (no off-by-one in either direction)', () => {
    // Move display row 0 into the gap between rows 2 and 3 (slot 3): two rows end up above it.
    expect(paintIndexForDrop(0, 3, 4)).toBe(1)
    // Move display row 3 into the gap between rows 0 and 1 (slot 1): one row stays above it.
    expect(paintIndexForDrop(3, 1, 4)).toBe(2)
  })
})
