/**
 * elementSizing — the parent-aware Fixed / Hug / Fill engine (W8-4).
 *
 * The defect this covers: Hug/Fill used to write `fit-content` / `100%` for
 * every element in every container. `width: 100%` on a flex child resolves
 * against the container's CONTENT box and ignores `gap`, so a "Fill" item in
 * a gapped row overflows it and shoves its siblings out — the control said
 * one thing and the source did another.
 *
 * Two properties are asserted throughout:
 *   1. The write is honest for the parent that is actually there.
 *   2. Read-back is the exact MIRROR of the write — `currentSizingMode` of
 *      `sizingPatch`'s own output returns the mode that produced it, for
 *      every axis × every parent layout × every mode. That round-trip is
 *      what keeps the mode picker from lying about what's in the source.
 */
import { describe, it, expect } from 'bun:test'
import {
  currentSizingMode,
  sizingAxisRole,
  sizingPatch,
  sizingUnavailableReason,
  type SizingAxis,
  type SizingMode,
  type SizingParentLayout,
} from '../elementSizing'

const FLEX_ROW: SizingParentLayout = { display: 'flex', flexDirection: 'row' }
const FLEX_COLUMN: SizingParentLayout = { display: 'flex', flexDirection: 'column' }
const GRID: SizingParentLayout = { display: 'grid', flexDirection: 'row' }
const BLOCK: SizingParentLayout = { display: 'block', flexDirection: 'row' }

// ---------------------------------------------------------------------------
// 1. Axis role — the one classification everything else reads
// ---------------------------------------------------------------------------

describe('sizingAxisRole', () => {
  it('splits a flex parent into main and cross by flex-direction', () => {
    expect(sizingAxisRole('width', FLEX_ROW)).toBe('flex-main')
    expect(sizingAxisRole('height', FLEX_ROW)).toBe('flex-cross')
    expect(sizingAxisRole('width', FLEX_COLUMN)).toBe('flex-cross')
    expect(sizingAxisRole('height', FLEX_COLUMN)).toBe('flex-main')
  })

  it('treats the inline- display variants and reversed directions the same', () => {
    expect(sizingAxisRole('width', { display: 'inline-flex', flexDirection: 'row-reverse' })).toBe('flex-main')
    expect(sizingAxisRole('height', { display: 'inline-flex', flexDirection: 'column-reverse' })).toBe('flex-main')
    expect(sizingAxisRole('width', { display: 'inline-grid', flexDirection: 'row' })).toBe('grid')
  })

  it('is grid on both axes of a grid parent, block for everything else', () => {
    expect(sizingAxisRole('width', GRID)).toBe('grid')
    expect(sizingAxisRole('height', GRID)).toBe('grid')
    expect(sizingAxisRole('width', BLOCK)).toBe('block')
    expect(sizingAxisRole('height', { display: 'inline-block', flexDirection: 'row' })).toBe('block')
  })

  it('is null when the parent layout is unknown', () => {
    expect(sizingAxisRole('width', null)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 2. Fill — the value that was wrong before
// ---------------------------------------------------------------------------

describe('sizingPatch — Fill', () => {
  it('writes flex: 1 1 0 on a flex MAIN axis, not 100%', () => {
    expect(sizingPatch('fill', 'width', FLEX_ROW, {}, '200px')).toEqual({ flex: '1 1 0' })
  })

  it('clears a stale literal length when the main axis switches to Fill', () => {
    expect(sizingPatch('fill', 'width', FLEX_ROW, { width: '200px' }, '200px')).toEqual({
      width: undefined,
      flex: '1 1 0',
    })
  })

  it('writes align-self: stretch on a flex CROSS axis and clears the size', () => {
    expect(sizingPatch('fill', 'height', FLEX_ROW, { height: '40px' }, '40px')).toEqual({
      height: undefined,
      alignSelf: 'stretch',
    })
  })

  it('uses justify-self for the grid inline axis and align-self for the block axis', () => {
    expect(sizingPatch('fill', 'width', GRID, {}, '0px')).toEqual({ justifySelf: 'stretch' })
    expect(sizingPatch('fill', 'height', GRID, {}, '0px')).toEqual({ alignSelf: 'stretch' })
  })

  it('keeps 100% for a block parent — the one container where it is right', () => {
    expect(sizingPatch('fill', 'width', BLOCK, {}, '200px')).toEqual({ width: '100%' })
  })

  it('writes NOTHING when the parent layout is unknown', () => {
    expect(sizingPatch('fill', 'width', null, {}, '200px')).toEqual({})
  })
})

// ---------------------------------------------------------------------------
// 3. Hug
// ---------------------------------------------------------------------------

describe('sizingPatch — Hug', () => {
  it('pins a flex main axis to its content and stops it shrinking', () => {
    expect(sizingPatch('hug', 'width', FLEX_ROW, {}, '200px')).toEqual({
      width: 'fit-content',
      flex: '0 0 auto',
    })
  })

  it('needs only fit-content on a stretch-by-default axis, and drops a prior Fill marker', () => {
    expect(sizingPatch('hug', 'height', FLEX_ROW, {}, '40px')).toEqual({ height: 'fit-content' })
    expect(sizingPatch('hug', 'height', FLEX_ROW, { alignSelf: 'stretch' }, '40px')).toEqual({
      height: 'fit-content',
      alignSelf: undefined,
    })
    expect(sizingPatch('hug', 'width', GRID, { justifySelf: 'stretch' }, '40px')).toEqual({
      width: 'fit-content',
      justifySelf: undefined,
    })
  })

  it('writes NOTHING when the parent layout is unknown', () => {
    expect(sizingPatch('hug', 'height', null, {}, '40px')).toEqual({})
  })
})

// ---------------------------------------------------------------------------
// 4. Fixed — freezes the measured size, drops only its OWN markers
// ---------------------------------------------------------------------------

describe('sizingPatch — Fixed', () => {
  it('freezes the measured value', () => {
    expect(sizingPatch('fixed', 'height', BLOCK, { height: 'fit-content' }, '325px')).toEqual({
      height: '325px',
    })
    expect(sizingPatch('fixed', 'width', BLOCK, {}, 266)).toEqual({ width: '266px' })
    expect(sizingPatch('fixed', 'width', BLOCK, {}, '266')).toEqual({ width: '266px' })
    expect(sizingPatch('fixed', 'width', BLOCK, {}, undefined)).toEqual({ width: '0px' })
  })

  it('clears the flex and stretch markers this model wrote', () => {
    expect(sizingPatch('fixed', 'width', FLEX_ROW, { flex: '1 1 0' }, '200px')).toEqual({
      width: '200px',
      flex: undefined,
    })
    expect(sizingPatch('fixed', 'height', FLEX_ROW, { alignSelf: 'stretch' }, '40px')).toEqual({
      height: '40px',
      alignSelf: undefined,
    })
  })

  it('leaves a hand-authored align-self alone — it is not a marker this model writes', () => {
    expect(sizingPatch('fixed', 'height', FLEX_ROW, { alignSelf: 'center' }, '40px')).toEqual({
      height: '40px',
    })
  })

  it('still works with an unknown parent — Fixed needs no parent', () => {
    expect(sizingPatch('fixed', 'width', null, {}, '120px')).toEqual({ width: '120px' })
  })
})

// ---------------------------------------------------------------------------
// 5. Read-back mirrors the write
// ---------------------------------------------------------------------------

describe('currentSizingMode', () => {
  const PARENTS: ReadonlyArray<[string, SizingParentLayout]> = [
    ['flex row', FLEX_ROW],
    ['flex column', FLEX_COLUMN],
    ['grid', GRID],
    ['block', BLOCK],
  ]
  const AXES: ReadonlyArray<SizingAxis> = ['width', 'height']
  const MODES: ReadonlyArray<SizingMode> = ['fixed', 'hug', 'fill']

  for (const [name, parent] of PARENTS) {
    for (const axis of AXES) {
      for (const mode of MODES) {
        it(`round-trips ${mode} on ${axis} under a ${name} parent`, () => {
          const stored: Record<string, unknown> = { width: '200px', height: '40px' }
          const patch = sizingPatch(mode, axis, parent, stored, stored[axis])
          const next = { ...stored }
          for (const [key, value] of Object.entries(patch)) {
            if (value === undefined) delete next[key]
            else next[key] = value
          }
          expect(currentSizingMode(axis, parent, next)).toBe(mode)
        })
      }
    }
  }

  it('reads a 100% on a flex child as Fixed, not Fill — there it IS a literal length', () => {
    expect(currentSizingMode('width', FLEX_ROW, { width: '100%' })).toBe('fixed')
    expect(currentSizingMode('width', BLOCK, { width: '100%' })).toBe('fill')
  })

  it('accepts the equivalent flex shorthands as a Fill marker', () => {
    for (const flex of ['1', '1 1 0', '1 1 0%', '1 1 0px', '  1  1  0 ']) {
      expect(currentSizingMode('width', FLEX_ROW, { flex })).toBe('fill')
    }
    expect(currentSizingMode('width', FLEX_ROW, { flex: '0 0 auto' })).toBe('fixed')
  })

  it('is always Fixed when the parent layout is unknown', () => {
    expect(currentSizingMode('width', null, { width: '100%' })).toBe('fixed')
    expect(currentSizingMode('width', null, { width: 'fit-content' })).toBe('fixed')
  })

  it('is Fixed for an unset axis', () => {
    expect(currentSizingMode('width', BLOCK, {})).toBe('fixed')
  })
})

describe('sizingUnavailableReason', () => {
  it('names a reason only when the parent is unknown', () => {
    expect(sizingUnavailableReason(BLOCK)).toBeUndefined()
    expect(sizingUnavailableReason(null)).toContain('parent')
  })
})
