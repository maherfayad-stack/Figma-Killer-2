/**
 * selectionTraversalActions + nudgeSelectedFrames — unit tests (viewport-01).
 *
 * Covers the two store seams behind the new keyboard staples:
 *   - `selectParentNode` / `selectFirstChildNode` (⇧Enter / Enter, and the
 *     `layers.selectParent` / `layers.selectFirstChild` palette commands,
 *     which now call the same actions instead of walking the tree themselves)
 *   - `nudgeSelectedFrames` (arrow keys with board frames selected)
 *
 * The keyboard HOOKS that call these are DOM-level and live inside the canvas
 * iframes; these tests pin the logic that decides what moves and by how much.
 */
import { describe, it, expect, beforeEach, afterAll } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import { selectActiveBoardFrames } from '@site/store/slices/boardSelectors'
import { createBoard, createBoardsFile, upsertFrame } from '@core/studio-board'
import { makeNode, makePage, makeSite } from '../fixtures'

function resetStore() {
  useEditorStore.setState({
    site: null,
    activePageId: null,
    activeDocument: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    selectedNodeFrameId: null,
    selectedFrameIds: [],
    boards: createBoardsFile(),
    activeBoardId: null,
    boardsLoaded: false,
    boardsDirty: false,
  } as Parameters<typeof useEditorStore.setState>[0])
}

beforeEach(resetStore)
// `useEditorStore` is a process-wide singleton shared by every test file in
// the run — leave it neutral on the way out too.
afterAll(resetStore)

/** root → section → [text, image] */
function seedThreeLevelPage() {
  const page = makePage({
    id: 'page-1',
    rootNodeId: 'root',
    nodes: {
      root: makeNode({ id: 'root', moduleId: 'base.body', children: ['section'] }),
      section: makeNode({ id: 'section', moduleId: 'base.container', children: ['text', 'image'] }),
      text: makeNode({ id: 'text', moduleId: 'base.text' }),
      image: makeNode({ id: 'image', moduleId: 'base.image' }),
    },
  })
  useEditorStore.setState({ site: makeSite({ pages: [page] }), activePageId: 'page-1' })
}

describe('selectParentNode', () => {
  it('walks the selection up one level and reports that it moved', () => {
    seedThreeLevelPage()
    useEditorStore.getState().selectNode('text')

    expect(useEditorStore.getState().selectParentNode()).toBe(true)
    expect(useEditorStore.getState().selectedNodeId).toBe('section')

    expect(useEditorStore.getState().selectParentNode()).toBe(true)
    expect(useEditorStore.getState().selectedNodeId).toBe('root')
  })

  it('stops at the root instead of clearing — Escape is what deselects', () => {
    seedThreeLevelPage()
    useEditorStore.getState().selectNode('root')

    expect(useEditorStore.getState().selectParentNode()).toBe(false)
    // Unchanged: the caller falls through, and the selection stays put.
    expect(useEditorStore.getState().selectedNodeId).toBe('root')
  })

  it('no-ops with nothing selected', () => {
    seedThreeLevelPage()
    expect(useEditorStore.getState().selectParentNode()).toBe(false)
    expect(useEditorStore.getState().selectedNodeId).toBeNull()
  })

  it('preserves the frame the selection came from (WS-10 variant frames)', () => {
    seedThreeLevelPage()
    useEditorStore.getState().selectNode('text', 'replace', { frameId: 'frame-b' })
    expect(useEditorStore.getState().selectedNodeFrameId).toBe('frame-b')

    useEditorStore.getState().selectParentNode()
    expect(useEditorStore.getState().selectedNodeId).toBe('section')
    expect(useEditorStore.getState().selectedNodeFrameId).toBe('frame-b')
  })
})

describe('selectFirstChildNode', () => {
  it('steps into the first child, in child order', () => {
    seedThreeLevelPage()
    useEditorStore.getState().selectNode('root')

    expect(useEditorStore.getState().selectFirstChildNode()).toBe(true)
    expect(useEditorStore.getState().selectedNodeId).toBe('section')

    expect(useEditorStore.getState().selectFirstChildNode()).toBe(true)
    // 'text' is first, 'image' second — never the other way round.
    expect(useEditorStore.getState().selectedNodeId).toBe('text')
  })

  it('no-ops on a leaf', () => {
    seedThreeLevelPage()
    useEditorStore.getState().selectNode('image')
    expect(useEditorStore.getState().selectFirstChildNode()).toBe(false)
    expect(useEditorStore.getState().selectedNodeId).toBe('image')
  })

  it('round-trips with selectParentNode', () => {
    seedThreeLevelPage()
    useEditorStore.getState().selectNode('section')
    useEditorStore.getState().selectFirstChildNode()
    useEditorStore.getState().selectParentNode()
    expect(useEditorStore.getState().selectedNodeId).toBe('section')
  })
})

describe('nudgeSelectedFrames', () => {
  function seedBoardWithFrames() {
    let board = createBoard('board-1', 'Board 1')
    board = upsertFrame(board, { id: 'frame-a', pageId: 'page-a', x: 0, y: 0 })
    board = upsertFrame(board, { id: 'frame-b', pageId: 'page-b', x: 500, y: 0 })
    useEditorStore.setState({
      boards: { ...createBoardsFile(), boards: [board] },
      activeBoardId: 'board-1',
      boardsLoaded: true,
      boardsDirty: false,
    })
    return board
  }

  it('moves every selected frame by the delta, in one dirty flip', () => {
    seedBoardWithFrames()
    useEditorStore.getState().setSelectedFrameIds(['page-a', 'page-b'])

    useEditorStore.getState().nudgeSelectedFrames(1, -1)

    const frames = selectActiveBoardFrames(useEditorStore.getState())
    expect(frames.find((f) => f.pageId === 'page-a')).toMatchObject({ x: 1, y: -1 })
    expect(frames.find((f) => f.pageId === 'page-b')).toMatchObject({ x: 501, y: -1 })
    expect(useEditorStore.getState().boardsDirty).toBe(true)
  })

  it('leaves unselected frames alone', () => {
    seedBoardWithFrames()
    useEditorStore.getState().setSelectedFrameIds(['page-a'])

    useEditorStore.getState().nudgeSelectedFrames(0, 10)

    const frames = selectActiveBoardFrames(useEditorStore.getState())
    expect(frames.find((f) => f.pageId === 'page-a')).toMatchObject({ x: 0, y: 10 })
    expect(frames.find((f) => f.pageId === 'page-b')).toMatchObject({ x: 500, y: 0 })
  })

  it('never flips boardsDirty for a no-op (empty selection, or a zero delta)', () => {
    seedBoardWithFrames()

    useEditorStore.getState().nudgeSelectedFrames(1, 0)
    expect(useEditorStore.getState().boardsDirty).toBe(false)

    useEditorStore.getState().setSelectedFrameIds(['page-a'])
    useEditorStore.getState().nudgeSelectedFrames(0, 0)
    expect(useEditorStore.getState().boardsDirty).toBe(false)

    // A selection of ids that no longer resolve to frames is also a no-op —
    // it must not persist an unchanged board.
    useEditorStore.getState().setSelectedFrameIds(['page-gone'])
    useEditorStore.getState().nudgeSelectedFrames(0, 1)
    expect(useEditorStore.getState().boardsDirty).toBe(false)
  })

  it('no-ops with no active board', () => {
    useEditorStore.setState({ selectedFrameIds: ['page-a'] })
    useEditorStore.getState().nudgeSelectedFrames(1, 1)
    expect(useEditorStore.getState().boardsDirty).toBe(false)
  })
})
