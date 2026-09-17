/**
 * Dragging an element's edge.
 *
 * The assertions that matter are the two that separate this from the board's
 * `rectResize`: a west/north drag inverts rather than moving an origin, and a
 * drag only ever writes the dimension its handle owns.
 */
import { describe, it, expect } from 'bun:test'
import {
  MIN_ELEMENT_SIZE,
  resizeAxes,
  resizeElementSize,
  resizeStylePatch,
} from '@site/canvas/elementResize'

const start = { width: 200, height: 100 }

describe('resizeAxes', () => {
  it('gives each handle only the dimensions it owns', () => {
    expect(resizeAxes('e')).toEqual({ width: true, height: false })
    expect(resizeAxes('w')).toEqual({ width: true, height: false })
    expect(resizeAxes('n')).toEqual({ width: false, height: true })
    expect(resizeAxes('s')).toEqual({ width: false, height: true })
    expect(resizeAxes('se')).toEqual({ width: true, height: true })
    expect(resizeAxes('nw')).toEqual({ width: true, height: true })
  })
})

describe('resizeElementSize', () => {
  it('grows on an east drag and shrinks on the way back', () => {
    expect(resizeElementSize('e', start, 40, 0).width).toBe(240)
    expect(resizeElementSize('e', start, -40, 0).width).toBe(160)
  })

  it('INVERTS the west handle — dragging left grows the element', () => {
    // The element has no origin of its own to move (layout owns that), so the
    // whole west/north gesture is expressed as a size change.
    expect(resizeElementSize('w', start, -40, 0).width).toBe(240)
    expect(resizeElementSize('w', start, 40, 0).width).toBe(160)
  })

  it('inverts the north handle the same way', () => {
    expect(resizeElementSize('n', start, 0, -30).height).toBe(130)
    expect(resizeElementSize('s', start, 0, -30).height).toBe(70)
  })

  it('leaves the dimension a handle does not own exactly as it was', () => {
    // Not "roughly" — identical, so `resizeStylePatch` can compare and write
    // nothing for that axis.
    expect(resizeElementSize('e', start, 40, 999)).toEqual({ width: 240, height: 100 })
    expect(resizeElementSize('s', start, 999, 40)).toEqual({ width: 200, height: 140 })
  })

  it('moves both dimensions from a corner', () => {
    expect(resizeElementSize('se', start, 40, 20)).toEqual({ width: 240, height: 120 })
    expect(resizeElementSize('nw', start, -40, -20)).toEqual({ width: 240, height: 120 })
  })

  it('clamps to the floor instead of going negative', () => {
    expect(resizeElementSize('e', start, -10_000, 0).width).toBe(MIN_ELEMENT_SIZE)
    expect(resizeElementSize('s', start, 0, -10_000).height).toBe(MIN_ELEMENT_SIZE)
  })

  it('rounds to whole pixels', () => {
    expect(resizeElementSize('e', start, 12.6, 0).width).toBe(213)
  })
})

describe('resizeStylePatch', () => {
  it('writes only the dimension the handle changed', () => {
    const next = resizeElementSize('e', start, 40, 0)
    expect(resizeStylePatch('e', start, next)).toEqual({ width: '240px' })
  })

  it('writes both from a corner', () => {
    const next = resizeElementSize('se', start, 40, 20)
    expect(resizeStylePatch('se', start, next)).toEqual({ width: '240px', height: '120px' })
  })

  it('is null when the pointer moved but the size did not', () => {
    // Held against the clamp, or a sub-pixel wobble: committing here would
    // write a no-op edit into the user's source.
    expect(resizeStylePatch('e', start, start)).toBeNull()
    const clamped = { width: MIN_ELEMENT_SIZE, height: 100 }
    expect(resizeStylePatch('e', clamped, resizeElementSize('e', clamped, -50, 0))).toBeNull()
  })

  it('spells the unit', () => {
    const next = resizeElementSize('s', start, 0, 20)
    expect(resizeStylePatch('s', start, next)).toEqual({ height: '120px' })
  })
})

/**
 * `K4`'s scale tool (`K`). The point of the lock is that the dimension the
 * handle does NOT own moves too, and that the shape is still the same shape
 * afterwards — so both halves (the size, and what gets written) are pinned.
 */
describe('proportional (the scale tool)', () => {
  it('drives the un-owned dimension from the start aspect ratio', () => {
    // 200×100 dragged 100px wider is 300×150, not 300×100.
    expect(resizeElementSize('e', start, 100, 0, MIN_ELEMENT_SIZE, true)).toEqual({
      width: 300,
      height: 150,
    })
    // And the same in the other direction, from a north/south handle.
    expect(resizeElementSize('s', start, 0, 50, MIN_ELEMENT_SIZE, true)).toEqual({
      width: 300,
      height: 150,
    })
  })

  it('follows the larger relative movement from a corner', () => {
    // dx=+100 is +50% of width; dy=+10 is only +10% of height. The pointer
    // went sideways, so the box follows width.
    expect(resizeElementSize('se', start, 100, 10, MIN_ELEMENT_SIZE, true)).toEqual({
      width: 300,
      height: 150,
    })
  })

  it('inverts for a west/north handle exactly as the free resize does', () => {
    expect(resizeElementSize('w', start, -100, 0, MIN_ELEMENT_SIZE, true)).toEqual({
      width: 300,
      height: 150,
    })
  })

  it('degrades to a free resize when there is no ratio to preserve', () => {
    // A `display: contents` host or an empty inline element measures 0 — there
    // is no shape to lock, and dividing by it would produce NaN.
    const flat = { width: 0, height: 0 }
    expect(resizeElementSize('e', flat, 40, 0, MIN_ELEMENT_SIZE, true)).toEqual({
      width: 40,
      height: 0,
    })
  })

  it('commits the dimension the handle does not own', () => {
    const next = resizeElementSize('e', start, 100, 0, MIN_ELEMENT_SIZE, true)
    expect(resizeStylePatch('e', start, next, true)).toEqual({ width: '300px', height: '150px' })
  })

  it('still writes nothing when the size did not actually change', () => {
    expect(resizeStylePatch('e', start, start, true)).toBeNull()
  })
})
