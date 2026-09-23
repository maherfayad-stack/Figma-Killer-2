/**
 * Dragging an element's edge — the pure geometry both resize hosts share.
 *
 * The assertions that matter:
 *   - a flow element's west/north drag inverts rather than moving an origin,
 *     and a drag only writes what it moved;
 *   - the size written is the CSS size, not the border box (IX-6a);
 *   - ⇧ / ⌥ are per-step inputs (IX-6c);
 *   - a positioned element's west/north drag keeps the OPPOSITE edge still by
 *     moving its offset (IX-6d), under both LTR and RTL.
 */
import { describe, it, expect } from 'bun:test'
import {
  MIN_ELEMENT_SIZE,
  resizeAxes,
  resizeElementBox,
  resizeModifiersOf,
  resizeStylePatch,
  type ResizeBoxStart,
  type ResizeModifiers,
} from '@core/studio-runtime'

const FREE: ResizeModifiers = { proportional: false, fromCenter: false }
const RATIO: ResizeModifiers = { proportional: true, fromCenter: false }
const CENTRE: ResizeModifiers = { proportional: false, fromCenter: true }

/** A 200×100 border-box flow element. */
const start: ResizeBoxStart = { width: 200, height: 100, insetWidth: 0, insetHeight: 0, offsets: null }

function box(overrides: Partial<ResizeBoxStart>): ResizeBoxStart {
  return { ...start, ...overrides }
}

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

describe('resizeElementBox — a flow element', () => {
  it('grows on an east drag and shrinks on the way back', () => {
    expect(resizeElementBox('e', start, 40, 0, FREE).width).toBe(240)
    expect(resizeElementBox('e', start, -40, 0, FREE).width).toBe(160)
  })

  it('INVERTS the west handle — dragging left grows the element', () => {
    expect(resizeElementBox('w', start, -40, 0, FREE).width).toBe(240)
    expect(resizeElementBox('w', start, 40, 0, FREE).width).toBe(160)
  })

  it('inverts the north handle the same way', () => {
    expect(resizeElementBox('n', start, 0, -30, FREE).height).toBe(130)
    expect(resizeElementBox('s', start, 0, -30, FREE).height).toBe(70)
  })

  it('leaves the dimension a handle does not own exactly as it was, and has no offsets', () => {
    expect(resizeElementBox('e', start, 40, 999, FREE)).toEqual({ width: 240, height: 100, inline: null, top: null })
  })

  it('clamps the border box to the floor instead of going negative', () => {
    expect(resizeElementBox('e', start, -10_000, 0, FREE).width).toBe(MIN_ELEMENT_SIZE)
    expect(resizeElementBox('s', start, 0, -10_000, FREE).height).toBe(MIN_ELEMENT_SIZE)
  })

  it('rounds to whole pixels', () => {
    expect(resizeElementBox('e', start, 12.6, 0, FREE).width).toBe(213)
  })
})

/**
 * IX-6a. A `content-box` element with 10px padding and a 1px border is 122px
 * wide on screen for a `width: 100px`. Dragging its east edge 40px makes the
 * BOX 162px, which is `width: 140px` — the old drag wrote 162.
 */
describe('resizeElementBox — box-sizing (IX-6a)', () => {
  const contentBox = box({ width: 100, height: 50, insetWidth: 22, insetHeight: 22 })

  it('writes the CSS width, not the border box, under content-box', () => {
    const step = resizeElementBox('e', contentBox, 40, 0, FREE)
    expect(step.width).toBe(140)
    expect(resizeStylePatch(contentBox, step)).toEqual({ width: '140px' })
  })

  it('writes the border box as-is under border-box (insets are 0)', () => {
    const borderBox = box({ width: 122, height: 72 })
    expect(resizeElementBox('e', borderBox, 40, 0, FREE).width).toBe(162)
  })

  it('never shrinks the border box below its own padding + border', () => {
    expect(resizeElementBox('e', contentBox, -10_000, 0, FREE).width).toBe(0)
  })

  it('keeps the VISUAL aspect ratio, not the content-box one', () => {
    // 122×72 on screen; +61 wide is ×1.5, so the box is 183×108 and the CSS
    // height is 108 - 22 = 86. Scaling the content box (100×50) would give 75.
    const step = resizeElementBox('e', contentBox, 61, 0, RATIO)
    expect(step).toEqual({ width: 161, height: 86, inline: null, top: null })
  })
})

describe('resizeElementBox — modifiers (IX-6c)', () => {
  it('⇧ drives the un-owned dimension from the start aspect ratio', () => {
    expect(resizeElementBox('e', start, 100, 0, RATIO)).toMatchObject({ width: 300, height: 150 })
    expect(resizeElementBox('s', start, 0, 50, RATIO)).toMatchObject({ width: 300, height: 150 })
  })

  it('⇧ from a corner follows the larger scale', () => {
    expect(resizeElementBox('se', start, 100, 10, RATIO)).toMatchObject({ width: 300, height: 150 })
  })

  it('⇧ degrades to a free resize when there is no ratio to preserve', () => {
    const flat = box({ width: 0, height: 0 })
    expect(resizeElementBox('e', flat, 40, 0, RATIO)).toMatchObject({ width: 40, height: 0 })
  })

  it('⌥ doubles the delta on each owned axis', () => {
    expect(resizeElementBox('e', start, 40, 0, CENTRE).width).toBe(280)
    expect(resizeElementBox('nw', start, -10, -20, CENTRE)).toMatchObject({ width: 220, height: 140 })
  })

  it('reads modifiers from the event, with the scale tool latched', () => {
    expect(resizeModifiersOf({ shiftKey: false, altKey: false }, false)).toEqual(FREE)
    expect(resizeModifiersOf({ shiftKey: true, altKey: false }, false)).toEqual(RATIO)
    expect(resizeModifiersOf({ shiftKey: false, altKey: false }, true)).toEqual(RATIO)
    expect(resizeModifiersOf({ shiftKey: false, altKey: true }, false)).toEqual(CENTRE)
  })
})

describe('resizeElementBox — a positioned element (IX-6d)', () => {
  const absolute = box({ width: 100, height: 60, offsets: { inlineProperty: 'left', inline: 50, top: 30 } })

  it('moves `left` with the west edge so the east edge stays put', () => {
    const step = resizeElementBox('w', absolute, -20, 0, FREE)
    expect(step).toEqual({ width: 120, height: 60, inline: 30, top: 30 })
    expect(resizeStylePatch(absolute, step)).toEqual({ width: '120px', left: '30px' })
  })

  it('moves `top` with the north edge', () => {
    const step = resizeElementBox('n', absolute, 0, 10, FREE)
    expect(resizeStylePatch(absolute, step)).toEqual({ height: '50px', top: '40px' })
  })

  it('writes no offset for an east/south drag', () => {
    expect(resizeStylePatch(absolute, resizeElementBox('se', absolute, 10, 10, FREE))).toEqual({
      width: '110px',
      height: '70px',
    })
  })

  it('⌥ grows about the centre: both edges move by half', () => {
    const step = resizeElementBox('e', absolute, 10, 0, CENTRE)
    expect(resizeStylePatch(absolute, step)).toEqual({ width: '120px', left: '40px' })
  })

  it('⇧ on an edge grows the other axis about its centre', () => {
    const step = resizeElementBox('e', absolute, 50, 0, RATIO)
    expect(resizeStylePatch(absolute, step)).toEqual({ width: '150px', height: '90px', top: '15px' })
  })

  it('under RTL the inline start is the RIGHT edge', () => {
    const rtl = box({ width: 100, height: 60, offsets: { inlineProperty: 'insetInlineStart', inline: 50, top: 0 } })
    // West edge: the right edge does not move, so neither does the offset.
    expect(resizeStylePatch(rtl, resizeElementBox('w', rtl, -20, 0, FREE))).toEqual({ width: '120px' })
    // East edge: the right edge moves right by 20, 20 closer to the far side.
    expect(resizeStylePatch(rtl, resizeElementBox('e', rtl, 20, 0, FREE))).toEqual({
      width: '120px',
      insetInlineStart: '30px',
    })
  })
})

describe('resizeStylePatch', () => {
  it('writes only what moved', () => {
    expect(resizeStylePatch(start, resizeElementBox('e', start, 40, 0, FREE))).toEqual({ width: '240px' })
    expect(resizeStylePatch(start, resizeElementBox('se', start, 40, 20, FREE))).toEqual({
      width: '240px',
      height: '120px',
    })
  })

  it('is null when the pointer moved but nothing did', () => {
    expect(resizeStylePatch(start, resizeElementBox('e', start, 0, 0, FREE))).toBeNull()
    const clamped = box({ width: MIN_ELEMENT_SIZE })
    expect(resizeStylePatch(clamped, resizeElementBox('e', clamped, -50, 0, FREE))).toBeNull()
  })

  it('never writes an untouched axis just because its computed size was fractional', () => {
    const fractional = box({ width: 233.33, height: 100.4 })
    expect(resizeStylePatch(fractional, resizeElementBox('s', fractional, 0, 20, FREE))).toEqual({
      height: '120px',
    })
  })
})
