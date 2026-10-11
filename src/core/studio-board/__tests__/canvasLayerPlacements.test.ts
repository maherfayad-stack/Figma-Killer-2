import { describe, expect, it } from 'bun:test'
import {
  boardLayers,
  layerPaintOrder,
  renameLayerPlacement,
  reorderLayerPlacements,
  type Board,
  type CanvasLayerPlacement,
} from '..'

const board = (layers: CanvasLayerPlacement[]): Board => ({ id: 'b', name: 'Board', frames: [], notes: [], docs: [], layers })
const ids = (b: Board) => layerPaintOrder(boardLayers(b)).map((layer) => layer.id)

describe('renameLayerPlacement', () => {
  it('sets, trims and clears a name, and leaves the board alone when nothing changes', () => {
    const start = board([{ id: 'canvas-a1', x: 0, y: 0 }])
    const named = renameLayerPlacement(start, 'canvas-a1', '  Hero  ')
    expect(boardLayers(named)[0]?.name).toBe('Hero')
    expect(renameLayerPlacement(named, 'canvas-a1', 'Hero')).toBe(named)
    expect(boardLayers(renameLayerPlacement(named, 'canvas-a1', ''))[0]).not.toHaveProperty('name')
    expect(renameLayerPlacement(start, 'missing', 'x')).toBe(start)
  })
})

describe('reorderLayerPlacements', () => {
  const three = () =>
    board([
      { id: 'canvas-a1', x: 0, y: 0 },
      { id: 'canvas-b2', x: 0, y: 0 },
      { id: 'canvas-c3', x: 0, y: 0 },
    ])

  it('moves a layer to the front, to the back, and into the middle (index counted without the layer)', () => {
    expect(ids(reorderLayerPlacements(three(), 'canvas-a1', 2))).toEqual(['canvas-b2', 'canvas-c3', 'canvas-a1'])
    expect(ids(reorderLayerPlacements(three(), 'canvas-c3', 0))).toEqual(['canvas-c3', 'canvas-a1', 'canvas-b2'])
    expect(ids(reorderLayerPlacements(three(), 'canvas-c3', 1))).toEqual(['canvas-a1', 'canvas-c3', 'canvas-b2'])
  })

  it('writes the order as z = 1..n and does not touch a layer whose z is already right', () => {
    const ordered = reorderLayerPlacements(three(), 'canvas-a1', 2)
    expect(layerPaintOrder(boardLayers(ordered)).map((layer) => layer.z)).toEqual([1, 2, 3])
    const again = reorderLayerPlacements(ordered, 'canvas-a1', 2)
    expect(again).toBe(ordered)
  })

  it('clamps an out-of-range index and ignores an unknown id', () => {
    expect(ids(reorderLayerPlacements(three(), 'canvas-a1', 99))).toEqual(['canvas-b2', 'canvas-c3', 'canvas-a1'])
    const start = three()
    expect(reorderLayerPlacements(start, 'missing', 0)).toBe(start)
  })

  it('keeps an existing explicit order stable when an unordered layer joins it', () => {
    const mixed = board([
      { id: 'canvas-a1', x: 0, y: 0, z: 5 },
      { id: 'canvas-b2', x: 0, y: 0 },
      { id: 'canvas-c3', x: 0, y: 0, z: 2 },
    ])
    // Paint order: b2 (no z) first, then c3 (2), then a1 (5).
    expect(ids(mixed)).toEqual(['canvas-b2', 'canvas-c3', 'canvas-a1'])
    expect(ids(reorderLayerPlacements(mixed, 'canvas-b2', 1))).toEqual(['canvas-c3', 'canvas-b2', 'canvas-a1'])
  })
})
