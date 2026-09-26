/**
 * boardFrameAxesOverride.test.tsx — `canvas-16`. A frame with its own
 * `axes` override (`BoardFrame.axes`, `@core/studio-board`) always wins over
 * the board/toolbar preview axes (`BoardFrameView.tsx`'s `effectiveAxes` —
 * unchanged by this work order). What WAS missing: nothing on screen said a
 * frame was pinned, and nothing could clear it. This file proves both the
 * header badge and the context-menu reset item.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { BoardFrameView } from '@site/canvas/BoardFramesLayer/BoardFrameView'
import { useEditorStore } from '@site/store/store'
import { createBoard, type BoardsFile, type PreviewAxes } from '@core/studio-board'
import { makeNode, makePage } from '../fixtures'
import '@modules/base'

const originalFetch = globalThis.fetch

function resetStore() {
  useEditorStore.setState({
    site: null,
    activePageId: null,
    activeDocument: null,
    boards: { version: 1, boards: [] },
    activeBoardId: null,
    boardsLoaded: false,
    boardsDirty: false,
    selectedFrameIds: [],
    selectedAnnotations: [],
    frameDefaults: {},
    zoom: 1,
    panX: 0,
    panY: 0,
    boardSnapGuides: [],
    previewAxes: { direction: 'ltr', colorScheme: 'light' },
    selectedNodeId: null,
    selectedNodeIds: [],
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
    hasUnsavedChanges: false,
  } as Parameters<typeof useEditorStore.setState>[0])
}

beforeEach(() => {
  cleanup()
  resetStore()
  // Neither the badge nor the reset action needs a real network round trip —
  // same stub `boardFrameViewTierFork.test.tsx` uses, just to keep a stray
  // `console.error` from an unmockable relative fetch out of the output.
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ liveOrigin: null }), { status: 200 })) as typeof fetch
})

afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
  // Reset on the way OUT as well as on the way in. `bun test --parallel=4`
  // gives each WORKER a process, not each file, and `useEditorStore` is a
  // module singleton — so the board this file loads (`board-1`, holding a
  // frame for page `sms`) survived into the next canvas file in the same
  // worker. `CanvasRoot` then painted THAT board instead of the new file's
  // page, no `data-node-id` element ever appeared, and five unrelated tests
  // in `nodeRendererLockdown.test.tsx` timed out in `waitFor`. A file that
  // seeds the shared store clears it.
  resetStore()
})

function buildPage() {
  const button = makeNode({ id: 'cta', moduleId: 'base.button' })
  const root = makeNode({ id: 'root', moduleId: 'base.body', children: [button.id] })
  return makePage({ id: 'sms', rootNodeId: root.id, nodes: { [root.id]: root, [button.id]: button } })
}

/**
 * Renders `BoardFrameView` with an optional per-frame `axes` override, and —
 * only when `axes` is given — wires a real board into the store so
 * `setFrameAxes` (the reset action's own store call) has somewhere real to
 * write. Badge-only assertions don't need a board at all; the reset-click
 * assertions do.
 */
function renderFrame(axes?: Partial<PreviewAxes>) {
  const page = buildPage()
  const frame = { id: 'frame-1', pageId: page.id, x: 0, y: 0, ...(axes ? { axes } : {}) }

  if (axes) {
    const board = createBoard('board-1', 'Board 1')
    board.frames = [frame]
    const file: BoardsFile = { version: 1, boards: [board] }
    useEditorStore.getState().loadBoards(file)
    useEditorStore.setState({ activeBoardId: board.id })
  }

  return render(
    <BoardFrameView
      frame={frame}
      page={page}
      x={0}
      y={0}
      width={1024}
      height={800}
      hasManualHeight={false}
      isActive={false}
      isSelected={false}
      isOnScreen
    />,
  )
}

function openFrameContextMenu() {
  fireEvent.contextMenu(screen.getByTestId('board-frame-header'))
}

describe('BoardFrameView — pinned-axes badge', () => {
  it('renders no badge when the frame has no axes override', () => {
    renderFrame(undefined)
    expect(screen.queryByTestId('board-frame-axes-badge')).toBeNull()
  })

  it('renders only the ONE overridden axis for a one-key override', () => {
    // The exact shape "Duplicate as RTL" produces.
    renderFrame({ direction: 'rtl' })
    const badge = screen.getByTestId('board-frame-axes-badge')
    expect(badge.textContent).toBe('RTL')
  })

  it('renders every overridden key, in a stable order, for a full override', () => {
    // The exact shape diagnosed on the user's `sms` frame.
    renderFrame({ direction: 'ltr', locale: 'en', colorScheme: 'light' })
    const badge = screen.getByTestId('board-frame-axes-badge')
    expect(badge.textContent).toBe('LTR · Light · EN')
  })

  it('names the pinned value, not just "pinned"', () => {
    renderFrame({ colorScheme: 'dark' })
    const badge = screen.getByTestId('board-frame-axes-badge')
    expect(badge.textContent).toBe('Dark')
    expect(badge.textContent?.toLowerCase()).not.toBe('pinned')
  })
})

describe('BoardFrameView — reset-to-board-axes menu item', () => {
  it('is absent from the context menu when the frame has no override', () => {
    renderFrame(undefined)
    openFrameContextMenu()
    expect(screen.queryByTestId('board-frame-reset-axes')).toBeNull()
  })

  it('is present when the frame has an override', () => {
    renderFrame({ direction: 'rtl' })
    openFrameContextMenu()
    expect(screen.getByTestId('board-frame-reset-axes')).not.toBeNull()
  })

  it('clears frame.axes through the setFrameAxes store action on click', () => {
    renderFrame({ direction: 'rtl', colorScheme: 'dark' })
    openFrameContextMenu()

    fireEvent.click(screen.getByTestId('board-frame-reset-axes'))

    const board = useEditorStore.getState().boards.boards.find((b) => b.id === 'board-1')
    expect(board?.frames.find((f) => f.id === 'frame-1')?.axes).toBeUndefined()
    // Goes through `commitBoardChange` (`store-09`) — same undo stack and
    // autosave trigger as every other frame mutation, not a second path.
    expect(useEditorStore.getState().boardsDirty).toBe(true)
    expect(useEditorStore.getState().canUndo).toBe(true)
  })
})
