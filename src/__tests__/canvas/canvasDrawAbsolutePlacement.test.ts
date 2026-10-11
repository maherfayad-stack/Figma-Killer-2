import { describe, expect, it } from 'bun:test'
import {
  absoluteOffsetWithin,
  absolutePlacementForDraw,
  absolutePlacementStyles,
} from '@site/canvas/canvasDrawAbsolutePlacement'

describe('canvasDrawAbsolutePlacement', () => {
  it('writes the drawn top-left relative to the containing block, whole CSS px', () => {
    expect(absoluteOffsetWithin({ x: 120.4, y: 300.6 }, { x: 20, y: 100 })).toEqual({ left: 100, top: 201 })
    expect(absolutePlacementStyles({ left: 100, top: 201 })).toEqual({ position: 'absolute', left: '100px', top: '201px' })
  })

  it('stays a flow insert when the frame document is unreachable (a live frame)', () => {
    expect(absolutePlacementForDraw(null, 'screen', { x: 10, y: 10 })).toBeNull()
  })
})
