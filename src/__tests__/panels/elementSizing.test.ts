/**
 * Fill / Hug / Fixed → the CSS that actually produces them.
 *
 * Every case here is one the naive translation ("Fill means width: 100%")
 * gets wrong, which is the whole reason the module takes the parent's layout
 * as a required argument.
 */
import { describe, it, expect } from 'bun:test'
import {
  currentSizingMode,
  isMainAxis,
  sizingPatch,
  type ParentLayout,
} from '@site/panels/PropertiesPanel/elementSizing'

const row: ParentLayout = { display: 'flex', flexDirection: 'row' }
const column: ParentLayout = { display: 'flex', flexDirection: 'column' }
const block: ParentLayout = { display: 'block', flexDirection: 'row' }

describe('isMainAxis', () => {
  it('follows the parent flex direction, and is false off a flex parent', () => {
    expect(isMainAxis('width', row)).toBe(true)
    expect(isMainAxis('height', row)).toBe(false)
    expect(isMainAxis('width', column)).toBe(false)
    expect(isMainAxis('height', column)).toBe(true)
    expect(isMainAxis('width', block)).toBe(false)
    expect(isMainAxis('width', null)).toBe(false)
  })

  it('treats row-reverse / column-reverse as their own axis', () => {
    expect(isMainAxis('width', { display: 'flex', flexDirection: 'row-reverse' })).toBe(true)
    expect(isMainAxis('height', { display: 'flex', flexDirection: 'column-reverse' })).toBe(true)
  })

  it('counts inline-flex', () => {
    expect(isMainAxis('width', { display: 'inline-flex', flexDirection: 'row' })).toBe(true)
  })
})

describe('sizingPatch — fill', () => {
  it('uses the flex shorthand on a main axis, and CLEARS the leftover width', () => {
    // The clear is the point: a stale `width: 148px` is the flex base size,
    // and the element would neither fill nor keep 148px.
    expect(sizingPatch('width', 'fill', row)).toEqual({ flex: '1 1 0%', width: null })
  })

  it('stretches on a cross axis rather than writing 100%', () => {
    // `width: 100%` in a column flex parent overflows the moment the parent
    // has padding and the child is border-box.
    expect(sizingPatch('width', 'fill', column)).toEqual({ width: null, alignSelf: 'stretch' })
  })

  it('writes 100% only off a flex parent', () => {
    expect(sizingPatch('width', 'fill', block)).toEqual({ width: '100%' })
    expect(sizingPatch('height', 'fill', null)).toEqual({ height: '100%' })
  })
})

describe('sizingPatch — hug', () => {
  it('stops the element growing or shrinking on a main axis', () => {
    expect(sizingPatch('width', 'hug', row)).toEqual({ flex: '0 0 auto', width: 'auto' })
  })

  it('uses fit-content on a cross axis, and never touches alignment', () => {
    // `align-self: flex-start` would also hug — and would silently move the
    // element. `stretch` only applies to an auto size, so `fit-content` wins
    // without changing where the element sits.
    const patch = sizingPatch('width', 'hug', column)
    expect(patch).toEqual({ width: 'fit-content', alignSelf: null })
    expect(patch.alignSelf).not.toBe('flex-start')
  })

  it('uses fit-content off a flex parent', () => {
    expect(sizingPatch('height', 'hug', block)).toEqual({ height: 'fit-content' })
  })
})

describe('sizingPatch — fixed', () => {
  it('freezes the measured size the caller passes', () => {
    expect(sizingPatch('width', 'fixed', block, '148px')).toEqual({ width: '148px' })
  })

  it('pins flex too on a main axis, or the container would resize past it', () => {
    expect(sizingPatch('width', 'fixed', row, '148px')).toEqual({
      width: '148px',
      flex: '0 0 auto',
    })
  })

  it('clears a stretch left behind by Fill', () => {
    expect(sizingPatch('width', 'fixed', column, '148px')).toEqual({
      width: '148px',
      alignSelf: null,
    })
  })
})

describe('currentSizingMode', () => {
  it('reads a grow factor as fill on a main axis', () => {
    expect(currentSizingMode('width', { flex: '1 1 0%' }, row)).toBe('fill')
    expect(currentSizingMode('width', { flex: '1' }, row)).toBe('fill')
  })

  it('reads a pinned flex with a declared length as fixed', () => {
    expect(currentSizingMode('width', { flex: '0 0 auto', width: '148px' }, row)).toBe('fixed')
  })

  it('reads a pinned flex with no length as hug', () => {
    expect(currentSizingMode('width', { flex: '0 0 auto', width: 'auto' }, row)).toBe('hug')
    expect(currentSizingMode('width', { flex: 'none' }, row)).toBe('hug')
  })

  it('reads stretch and 100% as fill on a cross axis', () => {
    expect(currentSizingMode('width', { alignSelf: 'stretch' }, column)).toBe('fill')
    expect(currentSizingMode('width', { width: '100%' }, column)).toBe('fill')
  })

  it('reads fit-content as hug', () => {
    expect(currentSizingMode('width', { width: 'fit-content' }, column)).toBe('hug')
    expect(currentSizingMode('height', { height: 'max-content' }, block)).toBe('hug')
  })

  it('reads a declared length as fixed', () => {
    expect(currentSizingMode('width', { width: '12rem' }, block)).toBe('fixed')
    expect(currentSizingMode('height', { height: '50vh' }, block)).toBe('fixed')
  })

  it("falls back to CSS's real initial behaviour when the axis is undeclared", () => {
    // Not `null`. Most elements on a page declare no size at all, and a blank
    // control reads as "this does nothing" — while the element genuinely IS
    // in one of the three modes already.
    expect(currentSizingMode('width', {}, row)).toBe('hug') // row MAIN axis: content-sized
    expect(currentSizingMode('height', {}, row)).toBe('fill') // row CROSS axis: align-items stretch
    expect(currentSizingMode('height', {}, column)).toBe('hug') // column MAIN axis: content-sized
    expect(currentSizingMode('width', {}, column)).toBe('fill') // column CROSS axis: stretched
    expect(currentSizingMode('width', {}, block)).toBe('fill') // block fills inline axis
    expect(currentSizingMode('height', {}, block)).toBe('hug') // and hugs vertically
  })

  it('never reports Fixed from a COMPUTED px height — the caller passes declarations', () => {
    // The bug this guards: `getComputedStyle` resolves every box to a concrete
    // px, so folding computed values in would make every auto-height element
    // on the page claim to be Fixed. The contract is "declared bag only".
    expect(currentSizingMode('height', {}, block)).toBe('hug')
    expect(currentSizingMode('height', { height: '48px' }, block)).toBe('fixed')
  })
})
