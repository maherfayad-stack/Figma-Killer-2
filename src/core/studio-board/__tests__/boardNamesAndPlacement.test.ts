import { describe, expect, test } from 'bun:test'
import {
  createBoard,
  createBoardsFile,
  freeSlotBeside,
  parseBoardsFile,
  serializeBoardsFile,
  setLayerName,
  setPageName,
  upsertBoard,
  upsertFrame,
  type BoardFrame,
  type BoardsFile,
} from '../index'

const hint = { nodeId: 'pages/Home.tsx:4:7', indexPath: [0, 1], moduleId: 'base.text', textSnippet: 'Hello' }

describe('page and layer names in the boards file', () => {
  test('a file with no names reads and writes exactly as before', () => {
    const file = upsertBoard(createBoardsFile(), createBoard('b', 'B'))
    const text = serializeBoardsFile(file)
    expect(text).not.toContain('pageNames')
    expect(text).not.toContain('layerNames')
    expect(serializeBoardsFile(parseBoardsFile(text))).toBe(text)
  })

  test('names round-trip, and an emptied name removes its key', () => {
    let file: BoardsFile = createBoardsFile()
    file = setPageName(file, 'home', 'Checkout')
    file = setLayerName(file, { pageId: 'home', hint }, 'Hero Title')
    const reread = parseBoardsFile(serializeBoardsFile(file))
    expect(reread.pageNames).toEqual({ home: 'Checkout' })
    expect(reread.layerNames).toEqual([{ pageId: 'home', hint, name: 'Hero Title' }])

    const cleared = setLayerName(setPageName(reread, 'home', ''), { pageId: 'home', hint }, '')
    expect(cleared).toEqual({ version: 1, boards: [] })
  })

  test('setting the same name again changes nothing (same reference)', () => {
    const file = setPageName(createBoardsFile(), 'home', 'Checkout')
    expect(setPageName(file, 'home', 'Checkout')).toBe(file)
    const named = setLayerName(file, { pageId: 'home', hint }, 'Hero')
    expect(setLayerName(named, { pageId: 'home', hint }, 'Hero')).toBe(named)
  })

  test('a layer name that supersedes a moved entry replaces it', () => {
    const named = setLayerName(createBoardsFile(), { pageId: 'home', hint }, 'Hero')
    const movedHint = { ...hint, nodeId: 'pages/Home.tsx:6:7' }
    const renamed = setLayerName(named, { pageId: 'home', hint: movedHint, supersedes: hint.nodeId }, 'Hero 2')
    expect(renamed.layerNames).toEqual([{ pageId: 'home', hint: movedHint, name: 'Hero 2' }])
  })

  test('hand-edited junk is dropped, not thrown on', () => {
    const file = parseBoardsFile({ version: 1, boards: [], pageNames: { home: '', other: 3, ok: ' Named ' }, layerNames: [{ nope: true }] })
    expect(file.pageNames).toEqual({ ok: 'Named' })
    expect(file.layerNames).toBeUndefined()
  })
})

describe('freeSlotBeside', () => {
  const frameAt = (id: string, x: number, width = 400): BoardFrame => ({ id, pageId: id, x, y: 0, width, height: 500 })

  test('starts one gap to the right of the source when that space is free', () => {
    const board = upsertFrame(createBoard('b', 'B'), frameAt('a', 0))
    expect(freeSlotBeside(board, board.frames[0]!)).toEqual({ x: 448, y: 0 })
  })

  test('steps past a neighbour that sits in the way', () => {
    let board = createBoard('b', 'B')
    board = upsertFrame(board, frameAt('a', 0))
    board = upsertFrame(board, frameAt('b', 500))
    // 448..848 would land on b (500..900): the copy goes past it.
    expect(freeSlotBeside(board, board.frames[0]!)).toEqual({ x: 948, y: 0 })
  })

  test('a second copy lands beside the first, not on it', () => {
    let board = createBoard('b', 'B')
    board = upsertFrame(board, frameAt('a', 0))
    board = upsertFrame(board, frameAt('copy', 448))
    expect(freeSlotBeside(board, board.frames[0]!)).toEqual({ x: 896, y: 0 })
  })

  test('a sticky note in the way is stepped over too', () => {
    const board = {
      ...upsertFrame(createBoard('b', 'B'), frameAt('a', 0)),
      notes: [{ id: 'n', x: 460, y: 100, w: 200, h: 120, text: '', color: 'yellow' as const }],
    }
    expect(freeSlotBeside(board, board.frames[0]!).x).toBe(708)
  })
})
