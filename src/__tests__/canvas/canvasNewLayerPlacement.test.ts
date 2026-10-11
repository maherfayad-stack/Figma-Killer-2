/**
 * PA-3 — where a NEW layer (a draw, an Assets drop, a file drop) goes in its
 * parent: absolute at the pointer in a free frame, in flow elsewhere, absolute
 * anywhere under cmd/ctrl when the parent can hold an absolute child.
 */
import { describe, expect, it } from 'bun:test'
import { GlobalWindow } from 'happy-dom'
import {
  newLayerPlacementAt,
  newLayerPlacementStyles,
  placementKindOfElement,
  planNewLayerPlacement,
  type NewLayerParent,
} from '@site/canvas/canvasNewLayerPlacement'

const parent = (overrides: Partial<NewLayerParent> = {}): NewLayerParent => ({
  kind: 'free-frame',
  block: {
    rect: { left: 20, top: 30, width: 400, height: 300 },
    borderLeft: 0,
    borderTop: 0,
    borderRight: 0,
    borderBottom: 0,
    scale: 1,
    scrollLeft: 0,
    scrollTop: 0,
  },
  containsAbsolute: true,
  direction: 'ltr',
  ...overrides,
})
const at = { left: 120, top: 80, width: 0, height: 0 }

describe('planNewLayerPlacement', () => {
  it('lands absolute at the pointer in a free frame, with no modifier', () => {
    expect(planNewLayerPlacement(parent(), at, false)).toEqual({ kind: 'absolute', property: 'left', inline: 100, top: 50 })
  })

  it('measures from the padding box: a border and a scroll offset are accounted for', () => {
    const framed = parent({ block: { ...parent().block, borderLeft: 4, borderTop: 6, scrollTop: 10 } })
    expect(planNewLayerPlacement(framed, at, false)).toEqual({ kind: 'absolute', property: 'left', inline: 96, top: 54 })
  })

  it('divides a scaled parent out, so the offsets are CSS px', () => {
    const half = parent({ block: { ...parent().block, rect: { left: 20, top: 30, width: 200, height: 150 }, scale: 0.5 } })
    expect(planNewLayerPlacement(half, at, false)).toEqual({ kind: 'absolute', property: 'left', inline: 200, top: 100 })
  })

  it('writes the logical inline start, from the right edge, under RTL', () => {
    expect(planNewLayerPlacement(parent({ direction: 'rtl' }), { ...at, width: 50 }, false)).toEqual({
      kind: 'absolute',
      property: 'insetInlineStart',
      inline: 250,
      top: 50,
    })
  })

  it('inserts in flow into a flow or auto-layout parent without the modifier', () => {
    expect(planNewLayerPlacement(parent({ kind: 'flow' }), at, false)).toEqual({ kind: 'flow' })
    expect(planNewLayerPlacement(parent({ kind: 'auto-layout' }), at, false)).toEqual({ kind: 'flow' })
  })

  it('cmd places absolutely in a flow or auto-layout parent that is positioned', () => {
    for (const kind of ['flow', 'auto-layout'] as const) {
      expect(planNewLayerPlacement(parent({ kind }), at, true)).toEqual({ kind: 'absolute', property: 'left', inline: 100, top: 50 })
    }
  })

  it('cmd in a static parent refuses rather than placing against a distant ancestor', () => {
    expect(planNewLayerPlacement(parent({ kind: 'flow', containsAbsolute: false }), at, true)).toEqual({
      kind: 'refused',
      reason: 'static-parent',
    })
  })

  it('cmd with an unmeasurable parent refuses; a plain gesture still inserts in flow', () => {
    expect(planNewLayerPlacement(null, at, true)).toEqual({ kind: 'refused', reason: 'unmeasured' })
    expect(planNewLayerPlacement(null, at, false)).toEqual({ kind: 'flow' })
  })
})

describe('newLayerPlacementStyles', () => {
  it('spells an absolute placement and nothing else', () => {
    expect(newLayerPlacementStyles({ kind: 'absolute', property: 'left', inline: 100, top: 50 })).toEqual({
      position: 'absolute',
      left: '100px',
      top: '50px',
    })
    expect(newLayerPlacementStyles({ kind: 'flow' })).toEqual({})
    expect(newLayerPlacementStyles(null)).toEqual({})
  })
})

describe('placementKindOfElement', () => {
  const window = new GlobalWindow()
  const kindOf = (html: string) => {
    window.document.body.innerHTML = html
    return placementKindOfElement(window as unknown as Window, window.document.getElementById('p') as unknown as HTMLElement)
  }

  it('a positioned parent whose children are all absolute is a free frame', () => {
    expect(kindOf(`<div id="p" style="position:relative"><i style="position:absolute"></i></div>`)).toBe('free-frame')
  })

  it('an empty positioned parent is a free frame', () => {
    expect(kindOf(`<div id="p" style="position:relative"></div>`)).toBe('free-frame')
  })

  it('one in-flow child makes it a flow parent', () => {
    expect(kindOf(`<div id="p" style="position:relative"><i style="position:absolute"></i><b></b></div>`)).toBe('flow')
  })

  it('a hidden in-flow child decides nothing', () => {
    expect(kindOf(`<div id="p" style="position:relative"><b style="display:none"></b></div>`)).toBe('free-frame')
  })

  it('a flex parent is auto layout whatever its children', () => {
    expect(kindOf(`<div id="p" style="position:relative;display:flex"><i style="position:absolute"></i></div>`)).toBe('auto-layout')
  })

  it('a static parent is flow', () => {
    expect(kindOf(`<div id="p" style="position:static"></div>`)).toBe('flow')
  })
})

describe('newLayerPlacementAt', () => {
  it('stays a flow insert when the frame document is unreachable (a live frame)', () => {
    expect(newLayerPlacementAt(null, 'screen', { x: 10, y: 10, width: 0, height: 0 }, false)).toEqual({ kind: 'flow' })
  })
})
