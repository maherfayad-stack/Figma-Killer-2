/**
 * syncStoryBoardFrames — W5-3's board placement, pinned on the three
 * properties that make it non-surprising rather than on its coordinates:
 * it never touches the project's own board, it places each story exactly
 * once, and a board (or frame) the user deleted stays deleted.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createBoard, createBoardsFile, parseBoardsFile, serializeBoardsFile, upsertBoard } from '@core/studio-board'
import { boardsFilePath, syncStoryBoardFrames } from '../boardFrames'
import { readStudioMeta, writeStudioMeta } from '../studioMeta'
import type { StorySummary } from '../storyDiscovery'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'story-board-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function story(pageId: string, title: string): StorySummary {
  return { file: 'src/Chip.stories.tsx', exportName: pageId, title, storyName: pageId, frameTitle: `${title} / ${pageId}`, pageId }
}

function readBoards() {
  return parseBoardsFile(fs.readFileSync(boardsFilePath(tmpDir), 'utf8'))
}

/** Seeds a project board with one frame, the way a user who has been working would have. */
function seedProjectBoard(): void {
  const file = boardsFilePath(tmpDir)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const board = { ...createBoard('project-board', 'Board 1'), frames: [{ id: 'f1', pageId: 'home', x: 0, y: 0 }] }
  fs.writeFileSync(file, serializeBoardsFile(upsertBoard(createBoardsFile(), board)))
}

describe('syncStoryBoardFrames', () => {
  it('does nothing at all when the project has no stories', () => {
    seedProjectBoard()
    const before = fs.readFileSync(boardsFilePath(tmpDir), 'utf8')
    syncStoryBoardFrames(tmpDir, [])
    expect(fs.readFileSync(boardsFilePath(tmpDir), 'utf8')).toBe(before)
    expect(readStudioMeta(tmpDir).stories).toBeUndefined()
  })

  it('puts stories on their OWN board and leaves the project board untouched', () => {
    seedProjectBoard()
    syncStoryBoardFrames(tmpDir, [story('chip-primary', 'Data/Chip'), story('chip-critical', 'Data/Chip')])

    const boards = readBoards().boards
    expect(boards).toHaveLength(2)
    const project = boards.find((b) => b.id === 'project-board')!
    expect(project.frames.map((f) => f.pageId)).toEqual(['home'])

    const stories = boards.find((b) => b.name === 'Stories')!
    expect(stories.frames.map((f) => f.pageId)).toEqual(['chip-primary', 'chip-critical'])
    // One row per meta.title, variants left to right along it.
    expect(new Set(stories.frames.map((f) => f.y)).size).toBe(1)
    expect(stories.frames[0]!.x).toBeLessThan(stories.frames[1]!.x)
    expect(readStudioMeta(tmpDir).stories?.boardId).toBe(stories.id)
  })

  it('gives each meta.title its own row', () => {
    syncStoryBoardFrames(tmpDir, [
      story('chip-primary', 'Data/Chip'),
      story('badge-primary', 'Data/Badge'),
      story('badge-muted', 'Data/Badge'),
    ])
    const frames = readBoards().boards[0]!.frames
    const rows = new Map(frames.map((f) => [f.pageId, f.y]))
    expect(rows.get('chip-primary')).not.toBe(rows.get('badge-primary'))
    expect(rows.get('badge-primary')).toBe(rows.get('badge-muted'))
  })

  it('creates the Stories board from nothing when the project has no boards.json yet', () => {
    syncStoryBoardFrames(tmpDir, [story('chip-primary', 'Data/Chip')])
    expect(readBoards().boards.map((b) => b.name)).toEqual(['Stories'])
  })

  it('places a story exactly once — a frame the user deleted never comes back', () => {
    syncStoryBoardFrames(tmpDir, [story('chip-primary', 'Data/Chip')])
    const boardId = readStudioMeta(tmpDir).stories!.boardId!

    // The user removes the frame but keeps the board.
    const cleared = readBoards()
    fs.writeFileSync(
      boardsFilePath(tmpDir),
      serializeBoardsFile({ ...cleared, boards: cleared.boards.map((b) => ({ ...b, frames: [] })) }),
    )

    syncStoryBoardFrames(tmpDir, [story('chip-primary', 'Data/Chip')])
    expect(readBoards().boards.find((b) => b.id === boardId)!.frames).toEqual([])
  })

  it('still places a story written after the first sync, beside its already-placed siblings', () => {
    syncStoryBoardFrames(tmpDir, [story('chip-primary', 'Data/Chip')])
    syncStoryBoardFrames(tmpDir, [story('chip-primary', 'Data/Chip'), story('chip-critical', 'Data/Chip')])

    const frames = readBoards().boards[0]!.frames
    expect(frames.map((f) => f.pageId)).toEqual(['chip-primary', 'chip-critical'])
    expect(frames[1]!.x).toBeGreaterThan(frames[0]!.x)
    expect(frames[1]!.y).toBe(frames[0]!.y)
  })

  it('stops placing entirely once the Stories board itself has been deleted', () => {
    syncStoryBoardFrames(tmpDir, [story('chip-primary', 'Data/Chip')])
    fs.writeFileSync(boardsFilePath(tmpDir), serializeBoardsFile(createBoardsFile()))

    syncStoryBoardFrames(tmpDir, [story('chip-primary', 'Data/Chip'), story('chip-critical', 'Data/Chip')])
    expect(readBoards().boards).toEqual([])
  })

  it('honours the explicit off switch', () => {
    writeStudioMeta(tmpDir, { stories: { enabled: false } })
    syncStoryBoardFrames(tmpDir, [story('chip-primary', 'Data/Chip')])
    expect(fs.existsSync(boardsFilePath(tmpDir))).toBe(false)
  })
})
