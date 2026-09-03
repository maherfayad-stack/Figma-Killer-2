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
