/**
 * boardsSaveGuard — unit tests.
 *
 * Regression coverage for the boards-autosave data-loss hazard named in
 * `STATE.md` → `store-02`'s landmine: a whole-file overwrite must never ship
 * a frame set that silently drops a frame the store last confirmed was real,
 * unless the removal was an explicit user (or confirmed-deletion) action.
 */
import { describe, it, expect } from 'bun:test'
import { collectFrameIds, shouldRefuseBoardsSave } from '../boardsSaveGuard'
import { createBoard, createBoardsFile, type BoardsFile, type BoardFrame } from '@core/studio-board'

function frame(id: string, pageId = id): BoardFrame {
  return { id, pageId, x: 0, y: 0 }
}

function fileWithFrames(frames: BoardFrame[]): BoardsFile {
  const board = createBoard('board-1', 'Board 1')
  return { ...createBoardsFile(), boards: [{ ...board, frames }] }
}

describe('collectFrameIds', () => {
  it('collects frame ids across every board in the file', () => {
    const file: BoardsFile = {
      ...createBoardsFile(),
      boards: [
        { ...createBoard('a', 'A'), frames: [frame('f1'), frame('f2')] },
        { ...createBoard('b', 'B'), frames: [frame('f3')] },
      ],
    }
    expect(collectFrameIds(file)).toEqual(new Set(['f1', 'f2', 'f3']))
  })

  it('returns an empty set for a file with no frames', () => {
    expect(collectFrameIds(createBoardsFile())).toEqual(new Set())
  })
})

describe('shouldRefuseBoardsSave', () => {
  it('does NOT refuse when there is no baseline yet (first save of a session)', () => {
    expect(
      shouldRefuseBoardsSave({
        baselineFrameIds: null,
        nextFrameIds: new Set(),
        explicitRemovalPending: false,
      }),
    ).toBe(false)
  })

  it('does NOT refuse when the baseline is empty (a genuinely new project)', () => {
    expect(
      shouldRefuseBoardsSave({
        baselineFrameIds: new Set(),
        nextFrameIds: new Set(['f1', 'f2']),
        explicitRemovalPending: false,
      }),
    ).toBe(false)
  })

  it('does NOT refuse a superset write (new frames added, nothing lost)', () => {
    expect(
      shouldRefuseBoardsSave({
        baselineFrameIds: new Set(['f1']),
        nextFrameIds: new Set(['f1', 'f2']),
        explicitRemovalPending: false,
      }),
    ).toBe(false)
  })

  it('does NOT refuse an unrelated 1:1 same-size edit (no id disappeared)', () => {
    expect(
      shouldRefuseBoardsSave({
        baselineFrameIds: new Set(['f1', 'f2']),
        nextFrameIds: new Set(['f1', 'f2']),
        explicitRemovalPending: false,
      }),
    ).toBe(false)
  })

  it('REFUSES a save whose frame set is a strict subset of the baseline, with no explicit removal', () => {
    expect(
      shouldRefuseBoardsSave({
        baselineFrameIds: new Set(['f1', 'f2', 'f3']),
        nextFrameIds: new Set(['f1']),
        explicitRemovalPending: false,
      }),
    ).toBe(true)
  })

  it('REFUSES even a single missing id (not just a total wipe)', () => {
    expect(
      shouldRefuseBoardsSave({
        baselineFrameIds: new Set(['f1', 'f2']),
        nextFrameIds: new Set(['f1']),
        explicitRemovalPending: false,
      }),
    ).toBe(true)
  })

  it('ALLOWS a real user deletion through when the explicit-removal flag is set', () => {
    const refuse = shouldRefuseBoardsSave({
      baselineFrameIds: new Set(['f1', 'f2', 'f3']),
      nextFrameIds: new Set(['f1']),
      explicitRemovalPending: true,
    })
    expect(refuse).toBe(false)
  })

  it('reproduces the store-02 incident shape end-to-end: a reduced frame set with no explicit removal is refused', () => {
    const loaded = fileWithFrames([frame('home'), frame('about'), frame('contact')])
    const baseline = collectFrameIds(loaded)
    // A synthesized/raced board carries only ONE of the three real frames.
    const corrupted = fileWithFrames([frame('home')])
    const refuse = shouldRefuseBoardsSave({
      baselineFrameIds: baseline,
      nextFrameIds: collectFrameIds(corrupted),
      explicitRemovalPending: false,
    })
    expect(refuse).toBe(true)
  })
})
