import { describe, expect, it } from 'bun:test'
import { axisSelection, DEFAULT_PREVIEW_AXES, getAxisMode, mergePreviewAxes, withAxisMode } from '../previewAxes'
import { parseBoardsFile, serializeBoardsFile } from '../serialize'

describe('the generalised axes model (CT-4)', () => {
  it('reads and writes the three named axes through the same door as modes', () => {
    let axes = withAxisMode({}, 'color-scheme', 'dark')
    axes = withAxisMode(axes, 'direction', 'rtl')
    axes = withAxisMode(axes, 'locale', 'ar')
    axes = withAxisMode(axes, 'density', 'compact')
    expect(axes).toEqual({ colorScheme: 'dark', direction: 'rtl', locale: 'ar', modes: { density: 'compact' } })
    expect(getAxisMode(axes, 'color-scheme')).toBe('dark')
    expect(getAxisMode(axes, 'density')).toBe('compact')
    expect(getAxisMode(axes, 'theme')).toBeUndefined()
  })

  it('refuses a value the named fields cannot hold, instead of persisting it', () => {
    expect(withAxisMode({ colorScheme: 'light' }, 'color-scheme', 'sepia')).toEqual({ colorScheme: 'light' })
    expect(withAxisMode({ direction: 'ltr' }, 'direction', 'sideways')).toEqual({ direction: 'ltr' })
  })

  it('puts an axis back on its default by writing undefined, dropping an empty modes record', () => {
    const pinned = withAxisMode({}, 'density', 'compact')
    expect(withAxisMode(pinned, 'density', undefined)).toEqual({})
    expect(withAxisMode({ colorScheme: 'dark' }, 'color-scheme', undefined)).toEqual({})
  })

  it('merges a frame override onto the board PER AXIS, modes included', () => {
    const board = { ...DEFAULT_PREVIEW_AXES, modes: { density: 'compact', theme: 'brand' } }
    const merged = mergePreviewAxes(board, { colorScheme: 'dark', modes: { theme: 'plain' } })
    expect(merged.direction).toBe('ltr')
    expect(merged.colorScheme).toBe('dark')
    expect(merged.modes).toEqual({ density: 'compact', theme: 'plain' })
    expect(mergePreviewAxes(board, undefined)).toBe(board)
  })

  it('flattens to the catalog selection: named axes always, locale only when set', () => {
    expect(axisSelection({ ...DEFAULT_PREVIEW_AXES, modes: { density: 'compact' } })).toEqual({
      density: 'compact',
      'color-scheme': 'light',
      direction: 'ltr',
    })
    expect(axisSelection({ ...DEFAULT_PREVIEW_AXES, locale: 'ar' }).locale).toBe('ar')
  })
})

describe('modes persist in boards.json', () => {
  const file = {
    version: 1 as const,
    boards: [
      {
        id: 'b',
        name: 'Main',
        notes: [],
        docs: [],
        frames: [
          { id: 'f1', pageId: 'home', x: 0, y: 0, axes: { colorScheme: 'light' as const, modes: { density: 'compact' } } },
          { id: 'f2', pageId: 'home', x: 1100, y: 0, axes: { colorScheme: 'dark' as const } },
        ],
      },
    ],
  }

  it("round-trips a frame's modes", () => {
    const back = parseBoardsFile(serializeBoardsFile(file))
    expect(back.boards[0]!.frames[0]!.axes).toEqual({ colorScheme: 'light', modes: { density: 'compact' } })
    expect(back.boards[0]!.frames[1]!.axes).toEqual({ colorScheme: 'dark' })
  })

  it('drops a hand-edited malformed modes record without losing the frame', () => {
    const raw = JSON.stringify({
      version: 1,
      boards: [{ id: 'b', name: 'Main', frames: [{ id: 'f', pageId: 'home', x: 0, y: 0, axes: { modes: { density: 7, '': 'x', theme: 'brand' } } }] }],
    })
    expect(parseBoardsFile(raw).boards[0]!.frames[0]!.axes).toEqual({ modes: { theme: 'brand' } })
  })
})
