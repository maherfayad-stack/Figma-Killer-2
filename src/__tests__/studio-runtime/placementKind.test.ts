/**
 * PA-2 — the single parent-placement classifier and the resolver every
 * placement gesture (drag, nudge, draw, drop, inspector) calls.
 */
import { describe, expect, it } from 'bun:test'
import {
  autoLayoutFamily,
  isAutoLayoutDisplay,
  parentPlacementKind,
  resolvePlacement,
} from '@core/studio-runtime'

describe('isAutoLayoutDisplay', () => {
  it('flex and grid, inline or not, place their children; block, inline and flow-root do not', () => {
    for (const display of ['flex', 'inline-flex', 'grid', 'inline-grid']) expect(isAutoLayoutDisplay(display)).toBe(true)
    for (const display of ['block', 'inline', 'flow-root', 'table-cell', 'list-item', 'contents']) {
      expect(isAutoLayoutDisplay(display)).toBe(false)
    }
  })

  it('names the family', () => {
    expect(autoLayoutFamily('inline-flex')).toBe('flex')
    expect(autoLayoutFamily('inline-grid')).toBe('grid')
    expect(autoLayoutFamily('block')).toBeNull()
  })
})

describe('parentPlacementKind', () => {
  it('flex / grid is auto-layout whatever its children do', () => {
    expect(parentPlacementKind({ display: 'flex', position: 'relative' }, ['absolute'])).toBe('auto-layout')
    expect(parentPlacementKind({ display: 'grid', position: 'static' }, [])).toBe('auto-layout')
  })

  it('a positioned block whose children are all out of flow is a free frame, empty included', () => {
    expect(parentPlacementKind({ display: 'block', position: 'relative' }, ['absolute', 'fixed'])).toBe('free-frame')
    expect(parentPlacementKind({ display: 'block', position: 'relative' }, [])).toBe('free-frame')
  })

  it('one in-flow child makes it flow', () => {
    expect(parentPlacementKind({ display: 'block', position: 'relative' }, ['absolute', 'static'])).toBe('flow')
    expect(parentPlacementKind({ display: 'block', position: 'relative' }, ['relative'])).toBe('flow')
  })

  it('a static parent is flow: nothing contains an absolute child', () => {
    expect(parentPlacementKind({ display: 'block', position: 'static' }, ['absolute'])).toBe('flow')
  })

  it('unmeasured children never read as a free frame', () => {
    expect(parentPlacementKind({ display: 'block', position: 'relative' }, null)).toBe('flow')
  })
})

describe('resolvePlacement', () => {
  it('an absolute / fixed child moves freely with no modifier, in any parent', () => {
    for (const parentKind of ['auto-layout', 'free-frame', 'flow'] as const) {
      expect(resolvePlacement({ parentKind, childPosition: 'absolute', modifierHeld: false })).toBe('free')
      expect(resolvePlacement({ parentKind, childPosition: 'fixed', modifierHeld: false })).toBe('free')
    }
  })

  it('an in-flow child reorders, unless the modifier asks for a position', () => {
    expect(resolvePlacement({ parentKind: 'flow', childPosition: 'static', modifierHeld: false })).toBe('reorder')
    expect(resolvePlacement({ parentKind: 'auto-layout', childPosition: 'relative', modifierHeld: false })).toBe('reorder')
    expect(resolvePlacement({ parentKind: 'auto-layout', childPosition: 'static', modifierHeld: true })).toBe('free-from-flow')
  })

  it('a NEW layer (draw / drop) is placed by position only in a free frame, or with the modifier (OD-P4)', () => {
    expect(resolvePlacement({ parentKind: 'free-frame', childPosition: null, modifierHeld: false })).toBe('free')
    expect(resolvePlacement({ parentKind: 'flow', childPosition: null, modifierHeld: false })).toBe('reorder')
    expect(resolvePlacement({ parentKind: 'auto-layout', childPosition: null, modifierHeld: false })).toBe('reorder')
    expect(resolvePlacement({ parentKind: 'flow', childPosition: null, modifierHeld: true })).toBe('free-from-flow')
  })
})
