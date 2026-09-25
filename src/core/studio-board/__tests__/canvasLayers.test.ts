/**
 * P5-G (FC-1) — the free canvas's id and path grammar. The write-path
 * exception in `studioEditRouting.ts` is exactly as narrow as
 * `canvasLayerIdFromRel`, so this is the table that says how narrow that is.
 */
import { describe, expect, it } from 'bun:test'
import {
  canvasLayerEditNodeId,
  canvasLayerIdFromPageId,
  canvasLayerIdFromRel,
  canvasLayerPageId,
  canvasLayerRelPath,
  isCanvasLayerEditNodeId,
  isCanvasLayerId,
  isCanvasLayerPageId,
  mintCanvasLayerId,
  parseBoardsFile,
  serializeBoardsFile,
  upsertLayerPlacement,
  removeLayerPlacements,
  moveLayerPlacements,
  findLayerPlacement,
  layerPaintOrder,
  nextLayerZ,
  createBoard,
} from '@core/studio-board'

describe('layer ids', () => {
  it('mints ids of the one fixed shape, never twice', () => {
    const ids = new Set<string>()
    for (let i = 0; i < 200; i++) {
      const id = mintCanvasLayerId()
      expect(id).toMatch(/^cl[a-z0-9]{10}$/)
      expect(isCanvasLayerId(id)).toBe(true)
      ids.add(id)
    }
    expect(ids.size).toBe(200)
  })

  it.each(['', 'cl', 'cl012345678', 'cl01234567890', 'CL0123456789', 'cl012345678A', 'xx0123456789', 'cl0123456789 ', 'cl01234/6789', 'cl0123.56789'])(
    'rejects %j',
    (value) => {
      expect(isCanvasLayerId(value)).toBe(false)
    },
  )

  it('refuses to build a path from anything but a valid id', () => {
    expect(canvasLayerRelPath('cl0123456789')).toBe('.studio/canvas/cl0123456789.tsx')
    expect(() => canvasLayerRelPath('../meta')).toThrow()
    expect(() => canvasLayerRelPath('cl0123456789/../x')).toThrow()
  })
})

describe('canvasLayerIdFromRel accepts only the exact module path', () => {
  it('accepts the exact spelling', () => {
    expect(canvasLayerIdFromRel('.studio/canvas/cl0123456789.tsx')).toBe('cl0123456789')
  })

  it.each([
    '.studio/canvas/../x.tsx',
    '.studio/canvas/cl0123456789.ts',
    '.studio/canvas/cl0123456789.tsx.bak',
    '.studio/canvas/sub/cl0123456789.tsx',
    '.studio/canvas/CL0123456789.tsx',
    '.STUDIO/canvas/cl0123456789.tsx',
    '.studio\\canvas\\cl0123456789.tsx',
    './.studio/canvas/cl0123456789.tsx',
    'x/.studio/canvas/cl0123456789.tsx',
    '/.studio/canvas/cl0123456789.tsx',
    '.studio/canvas/cl0123456789.tsx/',
    '.studio/canvas/cl0123456789.tsx\n',
  ])('rejects %j', (rel) => {
    expect(canvasLayerIdFromRel(rel)).toBeNull()
  })
})

describe('page ids and edit node ids', () => {
  it('round-trips the page id and never mistakes a route id for a layer', () => {
    expect(canvasLayerIdFromPageId(canvasLayerPageId('cl0123456789'))).toBe('cl0123456789')
    expect(isCanvasLayerPageId('home')).toBe(false)
    expect(isCanvasLayerPageId('canvas:../x')).toBe(false)
    expect(isCanvasLayerEditNodeId(canvasLayerEditNodeId('cl0123456789'))).toBe(true)
    expect(isCanvasLayerEditNodeId('pages/Home.tsx:1:1')).toBe(false)
  })
})

describe('placements in boards.json', () => {
  it('round-trips layers and drops every entry that fails the TypeBox schema instead of carrying or repairing it', () => {
    const file = parseBoardsFile({
      version: 1,
      boards: [
        {
          id: 'b1',
          name: 'Board 1',
          frames: [],
          notes: [],
          docs: [],
          layers: [
            { id: 'cl0123456789', x: 10, y: 20, w: 360, z: 2, name: 'Hero', locked: true, hidden: false },
            { id: '../../etc', x: 0, y: 0 },
            { id: 'cl0123456789', x: 99, y: 99 },
            { id: 'clabcdefghij', x: 'nope', y: 5, w: 0 },
            { id: 'clzzzzzzzzzz', x: 1, y: 2, extra: 'dropped', hidden: true },
          ],
        },
      ],
    })
    expect(file.boards[0]!.layers).toEqual([
      { id: 'cl0123456789', x: 10, y: 20, w: 360, z: 2, name: 'Hero', locked: true },
      { id: 'clzzzzzzzzzz', x: 1, y: 2, hidden: true },
    ])
    expect(parseBoardsFile(serializeBoardsFile(file))).toEqual(file)
  })

  it('omits the key for a board without loose layers, so old files round-trip unchanged', () => {
    const file = parseBoardsFile({ version: 1, boards: [{ id: 'b1', name: 'B', frames: [], notes: [], docs: [] }] })
    expect('layers' in file.boards[0]!).toBe(false)
    expect(serializeBoardsFile(file)).not.toContain('layers')
  })

  it('transforms placements copy-on-write and drops the key with the last layer', () => {
    const board = createBoard('b1', 'B')
    const one = upsertLayerPlacement(board, { id: 'cl0123456789', x: 1, y: 2 })
    const two = upsertLayerPlacement(one, { id: 'clabcdefghij', x: 3, y: 4, z: nextLayerZ(one) })
    expect(two.layers!.map((layer) => layer.id)).toEqual(['cl0123456789', 'clabcdefghij'])
    expect(two.layers![1]!.z).toBe(1)

    const moved = moveLayerPlacements(two, new Map([['cl0123456789', { x: 50, y: 60 }]]))
    expect(moved.layers![0]).toEqual({ id: 'cl0123456789', x: 50, y: 60 })
    expect(moved.layers![1]).toBe(two.layers![1]!)
    expect(moveLayerPlacements(moved, new Map([['cl0123456789', { x: 50, y: 60 }]]))).toBe(moved)

    const file = { version: 1 as const, boards: [moved] }
    expect(findLayerPlacement(file, 'clabcdefghij')).toEqual({ boardId: 'b1', placement: moved.layers![1]! })
    expect(findLayerPlacement(file, 'clzzzzzzzzzz')).toBeNull()

    const emptied = removeLayerPlacements(moved, new Set(['cl0123456789', 'clabcdefghij']))
    expect('layers' in emptied).toBe(false)
  })

  it('paints unordered layers first, then by z', () => {
    const order = layerPaintOrder([
      { id: 'cl000000000a', x: 0, y: 0, z: 5 },
      { id: 'cl000000000b', x: 0, y: 0 },
      { id: 'cl000000000c', x: 0, y: 0, z: 1 },
    ])
    expect(order.map((layer) => layer.id)).toEqual(['cl000000000b', 'cl000000000c', 'cl000000000a'])
  })
})
