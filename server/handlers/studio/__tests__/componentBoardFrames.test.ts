/**
 * syncComponentBoardFrames — CV-2's "Components" board: its own board, each
 * gallery placed exactly once, a deleted board stays deleted.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { parseBoardsFile, serializeBoardsFile, upsertBoard } from '@core/studio-board'
import { syncComponentBoardFrames, syncStoryBoardFrames } from '../boardFrames'
import { boardsFilePath, readBoardsFile } from '../boardGeometry'
import type { GallerySummary } from '../componentGallery'
import { readStudioMeta } from '../studioMeta'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'component-board-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function gallery(name: string, dir = 'src/ui'): GallerySummary {
  return {
    file: `${dir}/${name}.tsx`,
    componentName: name,
    title: `Components / ${name}`,
    pageId: `component-${name.toLowerCase()}`,
    rowKey: dir,
    shown: 4,
    total: 4,
  }
}

function readBoards() {
  return parseBoardsFile(fs.readFileSync(boardsFilePath(tmpDir), 'utf8'))
}

describe('syncComponentBoardFrames', () => {
  it('writes nothing when no component has a gallery', () => {
    syncComponentBoardFrames(tmpDir, [])
    expect(fs.existsSync(boardsFilePath(tmpDir))).toBe(false)
    expect(readStudioMeta(tmpDir).components).toBeUndefined()
  })

  it('places galleries on a board named Components, one row per folder', () => {
    syncComponentBoardFrames(tmpDir, [gallery('Button'), gallery('Badge'), gallery('Card', 'src/cards')])
    const board = readBoards().boards.find((b) => b.name === 'Components')!
    const frame = (pageId: string) => board.frames.find((f) => f.pageId === pageId)!
    expect(frame('component-button').y).toBe(frame('component-badge').y)
    expect(frame('component-button').x).toBeLessThan(frame('component-badge').x)
    expect(frame('component-card').y).toBeGreaterThan(frame('component-button').y)
    expect(readStudioMeta(tmpDir).components?.boardId).toBe(board.id)
  })

  it('places each gallery once: a deleted frame stays deleted, a new component appears', () => {
    syncComponentBoardFrames(tmpDir, [gallery('Button'), gallery('Badge')])
    const first = readBoards().boards[0]!
    const without = { ...first, frames: first.frames.filter((f) => f.pageId !== 'component-button') }
    fs.writeFileSync(boardsFilePath(tmpDir), serializeBoardsFile(upsertBoard(readBoardsFile(tmpDir), without)))

    syncComponentBoardFrames(tmpDir, [gallery('Button'), gallery('Badge'), gallery('Chip')])
    const board = readBoards().boards[0]!
    expect(board.frames.map((f) => f.pageId).sort()).toEqual(['component-badge', 'component-chip'])
  })

  it('does not rewrite boards.json on a load that places nothing', () => {
    syncComponentBoardFrames(tmpDir, [gallery('Button')])
    const before = fs.readFileSync(boardsFilePath(tmpDir), 'utf8')
    syncComponentBoardFrames(tmpDir, [gallery('Button')])
    expect(fs.readFileSync(boardsFilePath(tmpDir), 'utf8')).toBe(before)
  })

  it('keeps the Stories and Components ledgers apart', () => {
    syncStoryBoardFrames(tmpDir, [
      { file: 'a.stories.tsx', exportName: 'P', title: 'T', storyName: 'P', frameTitle: 'T / P', pageId: 'story-p' },
    ])
    syncComponentBoardFrames(tmpDir, [gallery('Button')])
    const meta = readStudioMeta(tmpDir)
    expect(meta.stories?.boardId).not.toBe(meta.components?.boardId)
    expect(readBoards().boards.map((b) => b.name).sort()).toEqual(['Components', 'Stories'])
  })

  it('does not re-create a Components board the user deleted', () => {
    syncComponentBoardFrames(tmpDir, [gallery('Button')])
    fs.writeFileSync(boardsFilePath(tmpDir), serializeBoardsFile({ ...readBoardsFile(tmpDir), boards: [] }))
    syncComponentBoardFrames(tmpDir, [gallery('Button'), gallery('Badge')])
    expect(readBoards().boards).toEqual([])
  })
})
