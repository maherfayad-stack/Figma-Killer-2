/**
 * `studio_arrange_frames` (AI-17): frames can be placed — a row, a grid or
 * explicit x/y — with a note per frame, without resizing, creating or removing
 * anything.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBoard, createBoardsFile, upsertBoard, upsertFrame, type Board } from '@core/studio-board'
import { readBoardsFile, writeBoardsFile } from '../../../../handlers/studio/boardFrames'
import { layoutPlacements, studioArrangeFramesMcpTools } from './arrangeFramesTool'

const tool = studioArrangeFramesMcpTools[0]!

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'studio-arrange-frames-'))
  let board: Board = createBoard('b1', 'Board 1')
  board = upsertFrame(board, { id: 'f-a', pageId: 'HomeA', x: 0, y: 0, width: 393, height: 852 })
  board = upsertFrame(board, { id: 'f-b', pageId: 'HomeB', x: 1200, y: 900, width: 393, height: 852 })
  board = upsertFrame(board, { id: 'f-c', pageId: 'HomeC', x: 400, y: 2000, width: 393, height: 852 })
  // HomeB also shown dark, beside its light frame.
  board = upsertFrame(board, { id: 'f-b-dark', pageId: 'HomeB', x: 1650, y: 900, width: 393, height: 852, axes: { colorScheme: 'dark' } })
  board = upsertFrame(board, { id: 'f-x', pageId: 'Settings', x: 5000, y: 5000, width: 393, height: 852 })
  writeBoardsFile(dir, upsertBoard(createBoardsFile(), board))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

type Result = Record<string, unknown> & { ok: boolean; code?: string }

async function call(input: Record<string, unknown>): Promise<Result> {
  return (await tool.handler!({ dir, ...input } as never, { userId: 'u1' } as never)) as Result
}

function frames(): Record<string, { x: number; y: number; width?: number; height?: number }> {
  const board = readBoardsFile(dir).boards[0]!
  return Object.fromEntries(board.frames.map((f) => [f.id, { x: f.x, y: f.y, width: f.width, height: f.height }]))
}

describe('studio_arrange_frames', () => {
  it('lays variants out in a row, in order, at the given origin — and a page\'s second frame keeps its offset', async () => {
    const result = await call({ pageIds: ['HomeA', 'HomeB', 'HomeC'], layout: 'row', gap: 100, origin: { x: 0, y: 0 } })
    expect(result.ok).toBe(true)
    const after = frames()
    expect(after['f-a']).toMatchObject({ x: 0, y: 0 })
    expect(after['f-b']).toMatchObject({ x: 493, y: 0 })
    expect(after['f-c']).toMatchObject({ x: 986, y: 0 })
    expect(after['f-b-dark']).toMatchObject({ x: 943, y: 0 })
    // Untouched: a frame not named, and every size.
    expect(after['f-x']).toMatchObject({ x: 5000, y: 5000 })
    for (const frame of Object.values(after)) expect(frame).toMatchObject({ width: 393, height: 852 })
  })

  it('tidies in place by default: the group starts at its own top-left', async () => {
    await call({ pageIds: ['HomeB', 'HomeC'], layout: 'column' })
    const after = frames()
    expect(after['f-b']).toMatchObject({ x: 400, y: 900 })
    expect(after['f-c']).toMatchObject({ x: 400, y: 900 + 852 + 48 + 80 })
  })

  it('places explicit positions and writes one note per frame, reused on the next call', async () => {
    await call({ positions: [{ pageId: 'HomeA', x: 10, y: 400 }], notes: [{ pageId: 'HomeA', text: 'A · restrained' }] })
    await call({ positions: [{ pageId: 'HomeA', x: 20, y: 500 }], notes: [{ pageId: 'HomeA', text: 'A · confident' }] })
    const board = readBoardsFile(dir).boards[0]!
    expect(frames()['f-a']).toMatchObject({ x: 20, y: 500 })
    expect(board.notes).toHaveLength(1)
    expect(board.notes[0]).toMatchObject({ text: 'A · confident', x: 20 })
    expect(board.notes[0]!.y + board.notes[0]!.h).toBeLessThan(500)
  })

  it('refuses a page with no frame, and a call that mixes the two modes', async () => {
    const missing = await call({ pageIds: ['HomeA', 'Nope'], layout: 'row' })
    expect(missing.code).toBe('no-board-frame')
    const both = await call({ pageIds: ['HomeA'], layout: 'row', positions: [{ pageId: 'HomeA', x: 0, y: 0 }] })
    expect(both.code).toBe('invalid-input')
    expect(frames()['f-a']).toMatchObject({ x: 0, y: 0 })
  })
})

describe('layoutPlacements', () => {
  it('a grid of four is two by two, each row as tall as its tallest frame', () => {
    const frame = (width: number, height: number) => ({ id: 'x', pageId: 'x', x: 0, y: 0, width, height })
    const placements = layoutPlacements(
      [
        { pageId: 'a', frame: frame(100, 200) },
        { pageId: 'b', frame: frame(100, 300) },
        { pageId: 'c', frame: frame(100, 100) },
        { pageId: 'd', frame: frame(100, 100) },
      ],
      'grid',
      { gap: 10, origin: { x: 0, y: 0 }, noteBand: 0 },
    )
    expect(placements).toEqual([
      { pageId: 'a', x: 0, y: 0 },
      { pageId: 'b', x: 110, y: 0 },
      { pageId: 'c', x: 0, y: 300 + 48 + 10 },
      { pageId: 'd', x: 110, y: 300 + 48 + 10 },
    ])
  })
})
