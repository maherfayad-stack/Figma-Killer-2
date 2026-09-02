/**
 * loadBoards must not move the author off the board they have open.
 *
 * THE BUG THIS EXISTS FOR
 * ───────────────────────
 * `loadBoards` set `activeBoardId: file.boards[0].id` unconditionally, and
 * `AdminCanvasLayout`'s boards `load()` runs on EVERY `CMS_SITE_RELOAD_EVENT`
 * — after creating a page, after a project reload, after any structural save.
 * So a reload while curating Board 2 silently dropped the author onto Board 1.
 *
 * Reproduced in a browser: on a two-board project, "New page" from Board 2's
 * empty-state card ended with Board 1 active and showing three frames, while
 * Board 2 — the board that was open when the button was pressed — still read
 * "No screens on this board yet". Two independent defects produced that one
 * symptom; this file covers the client half. The server half (the frame being
 * written to `boards[0]` rather than the board the author named) is covered in
 * `server/handlers/studio/__tests__/pageScaffold.test.ts`.
 *
 * The rule is the one `lifecycleActions.ts` already applies to `activePageId`:
 * keep what is open when it still exists, fall back only when it is gone.
 */
import { describe, it, expect, beforeEach, afterAll } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import { createBoard, createBoardsFile, type BoardsFile } from '@core/studio-board'

function resetBoardState() {
  useEditorStore.setState({
    boards: createBoardsFile(),
    activeBoardId: null,
    boardsLoaded: false,
    boardsDirty: false,
    selectedFrameIds: [],
  })
}

beforeEach(resetBoardState)
// `useEditorStore` is a process-wide singleton shared across test files.
afterAll(resetBoardState)

function fileWith(...ids: string[]): BoardsFile {
  return { version: 1, boards: ids.map((id, i) => createBoard(id, `Board ${i + 1}`)) }
}

describe('loadBoards', () => {
  it('keeps the open board across a reload', () => {
    const store = useEditorStore.getState()
    store.loadBoards(fileWith('board-1', 'board-2'))
    store.setActiveBoard('board-2')

    // The reload every CMS_SITE_RELOAD_EVENT triggers.
    useEditorStore.getState().loadBoards(fileWith('board-1', 'board-2'))

    expect(useEditorStore.getState().activeBoardId).toBe('board-2')
  })

  it('falls back to the first board when the open one is gone', () => {
    // Deleted in another tab, or a project switch: the id names nothing in the
    // file that just loaded, so holding onto it would leave the canvas with no
    // board to render at all.
    const store = useEditorStore.getState()
    store.loadBoards(fileWith('board-1', 'board-2'))
    store.setActiveBoard('board-2')

    useEditorStore.getState().loadBoards(fileWith('board-1'))

    expect(useEditorStore.getState().activeBoardId).toBe('board-1')
  })

  it('picks the first board on the very first load, when nothing is open yet', () => {
    useEditorStore.getState().loadBoards(fileWith('board-1', 'board-2'))

    expect(useEditorStore.getState().activeBoardId).toBe('board-1')
  })

  it('still marks a load clean, so preserving the id does not resurrect a dirty flag', () => {
    const store = useEditorStore.getState()
    store.loadBoards(fileWith('board-1', 'board-2'))
    store.setActiveBoard('board-2')
    useEditorStore.setState({ boardsDirty: true })

    useEditorStore.getState().loadBoards(fileWith('board-1', 'board-2'))

    const next = useEditorStore.getState()
    expect(next.activeBoardId).toBe('board-2')
    expect(next.boardsDirty).toBe(false)
    expect(next.boardsLoadFailed).toBe(false)
  })
})
