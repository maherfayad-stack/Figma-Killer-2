/**
 * boardFrameModeChips.test.tsx - CT-4. A frame header shows one chip per mode
 * axis the project's CSS declares, choosing a mode pins it on that frame
 * (`BoardFrame.axes`), and "+ Mode" duplicates the frame into another mode.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { FrameModeChips } from '@site/canvas/BoardFramesLayer/FrameModeChips'
import { publishStudioTokenState } from '@site/studio/studioTokenCatalogStore'
import { useEditorStore } from '@site/store/store'
import { createBoard, type BoardFrame } from '@core/studio-board'
import type { TokenCatalog } from '@core/studio-tokens'

const CATALOG: TokenCatalog = {
  tokens: [],
  collections: [],
  axes: [
    { id: 'color-scheme', label: 'Color scheme', modes: [{ id: 'dark', label: 'Dark', gate: { kind: 'attr', attr: 'data-theme', value: 'dark' } }] },
    { id: 'density', label: 'Density', modes: [{ id: 'compact', label: 'compact', gate: { kind: 'class', className: 'compact' } }] },
  ],
}

function seedBoard(frame: BoardFrame) {
  const board = createBoard('board-1', 'Board 1')
  board.frames = [frame]
  useEditorStore.getState().loadBoards({ version: 1, boards: [board] })
  useEditorStore.setState({ activeBoardId: board.id, previewAxes: { direction: 'ltr', colorScheme: 'light' } })
}

const framesOnBoard = () => useEditorStore.getState().boards.boards[0]!.frames

beforeEach(() => {
  cleanup()
  publishStudioTokenState({ catalog: CATALOG, usage: null })
})

afterEach(() => {
  cleanup()
  publishStudioTokenState({ catalog: null, usage: null })
})

describe('FrameModeChips', () => {
  it('renders nothing for a project that declares no mode', () => {
    publishStudioTokenState({ catalog: { ...CATALOG, axes: [] }, usage: null })
    const frame = { id: 'f1', pageId: 'home', x: 0, y: 0 }
    seedBoard(frame)
    render(<FrameModeChips frame={frame} />)
    expect(screen.queryByTestId('board-frame-mode-chip')).toBeNull()
    expect(screen.queryByTestId('board-frame-add-mode')).toBeNull()
  })

  it('names the mode each axis is on, from the frame override over the board default', () => {
    const frame = { id: 'f1', pageId: 'home', x: 0, y: 0, axes: { colorScheme: 'dark' as const } }
    seedBoard(frame)
    render(<FrameModeChips frame={frame} />)
    const chips = screen.getAllByTestId('board-frame-mode-chip')
    expect(chips.map((chip) => [chip.getAttribute('data-axis'), chip.textContent])).toEqual([
      ['color-scheme', 'Dark'],
      ['density', 'Default'],
    ])
  })

  it('choosing a mode pins it on this frame only', () => {
    const frame = { id: 'f1', pageId: 'home', x: 0, y: 0 }
    seedBoard(frame)
    render(<FrameModeChips frame={frame} />)
    fireEvent.click(screen.getAllByTestId('board-frame-mode-chip')[0]!)
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Dark' }))
    expect(framesOnBoard()[0]!.axes).toEqual({ colorScheme: 'dark' })
    // The board default is untouched.
    expect(useEditorStore.getState().previewAxes.colorScheme).toBe('light')
  })

  it('+ Mode duplicates the frame into the other mode, keeping the source as it was', () => {
    const frame = { id: 'f1', pageId: 'home', x: 0, y: 0 }
    seedBoard(frame)
    render(<FrameModeChips frame={frame} />)
    fireEvent.click(screen.getByTestId('board-frame-add-mode'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Color scheme: Dark' }))
    const frames = framesOnBoard()
    expect(frames).toHaveLength(2)
    expect(frames[0]!.axes).toBeUndefined()
    expect(frames[1]!.pageId).toBe('home')
    expect(frames[1]!.axes).toEqual({ colorScheme: 'dark' })
  })
})
