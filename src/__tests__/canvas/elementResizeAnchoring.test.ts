/**
 * IX-21 (P5-E) — CONFIRMED by P2-D: a resize of a positioned layer anchored
 * by `right` / `bottom` wrote a `left` / `top` beside it (the shared rules
 * keep the opposite edge still by moving `left` / `top`), so the source
 * carried both insets. `anchorResizePatch` writes the edge movement onto the
 * offsets the source actually anchors the layer by.
 */
import { describe, expect, it } from 'bun:test'
import { resizeElementBox, type ResizeBoxStart, type ResizeHandle } from '@core/studio-runtime'
import { anchorResizePatch, resizeEdgeShifts } from '@site/canvas/elementResizeAnchoring'
import { resizeInlinePatch } from '@site/canvas/elementResizeSizing'
import { authoredOffsets, planNudge, type ArrowTargetStyle } from '@site/canvas/canvasNodeArrowMove'

const NO_COMPANIONS = { width: {}, height: {} }
const FREE = { proportional: false, fromCenter: false }

/** A 200 × 100 absolute layer, `left: 76px; right: 24px; top: 10px; bottom: 90px` used, in a 300 × 200 block. */
const START: ResizeBoxStart = {
  width: 200,
  height: 100,
  insetWidth: 0,
  insetHeight: 0,
  offsets: { inlineProperty: 'left', inline: 76, top: 10 },
}
const USED: ArrowTargetStyle = { position: 'absolute', direction: 'ltr', left: '76px', right: '24px', top: '10px', bottom: '90px' }

function drag(handle: ResizeHandle, dx: number, dy: number, authoredStyles: Record<string, string>) {
  const step = resizeElementBox(handle, START, dx, dy, FREE)
  const anchors = planNudge(USED, authoredOffsets({ classIds: [], inlineStyles: authoredStyles }, undefined))
  return anchorResizePatch(resizeInlinePatch(START, step, NO_COMPANIONS), START, step, anchors)
}

describe('IX-21 — a resize writes the offsets the source anchors the layer by', () => {
  it('W handle on a RIGHT-anchored layer: the width grows leftward, nothing else is written', () => {
    // The shared rules alone would add `left: 56px` beside the authored `right`.
    expect(drag('w', -20, 0, { right: '24px', top: '10px' })).toEqual({ width: '220px' })
  })

  it('E handle on a right-anchored layer: `right` shrinks by the growth, no `left`', () => {
    expect(drag('e', 20, 0, { right: '24px', top: '10px' })).toEqual({ width: '220px', right: '4px' })
  })

  it('N handle on a BOTTOM-anchored layer: height only; S handle: bottom shrinks', () => {
    expect(drag('n', 0, -10, { left: '76px', bottom: '90px' })).toEqual({ height: '110px' })
    expect(drag('s', 0, 10, { left: '76px', bottom: '90px' })).toEqual({ height: '110px', bottom: '80px' })
  })

  it('a left / top anchored layer keeps the pre-P5-E behaviour (W moves left)', () => {
    expect(drag('w', -20, 0, { left: '76px', top: '10px' })).toEqual({ width: '220px', left: '56px' })
  })

  it('a stretched layer (left AND right) moves only the edge the handle drags', () => {
    expect(drag('e', 20, 0, { left: '76px', right: '24px', top: '10px' })).toEqual({ width: '220px', right: '4px' })
  })
})

describe('resizeEdgeShifts', () => {
  it('reads an RTL step (inline start = distance from the right) back as edge moves', () => {
    const rtlStart: ResizeBoxStart = { ...START, offsets: { inlineProperty: 'insetInlineStart', inline: 24, top: 10 } }
    // E handle, +20: the right edge moves right by 20, so the inline start shrinks by 20.
    const step = resizeElementBox('e', rtlStart, 20, 0, FREE)
    expect(resizeEdgeShifts(rtlStart, step)).toEqual({ left: 0, right: 20, top: 0, bottom: 0 })
  })

  it('a flow element (no offsets) moves its end edges only', () => {
    const flow: ResizeBoxStart = { ...START, offsets: null }
    const step = resizeElementBox('se', flow, 10, 5, FREE)
    expect(resizeEdgeShifts(flow, step)).toEqual({ left: 0, right: 10, top: 0, bottom: 5 })
  })
})
