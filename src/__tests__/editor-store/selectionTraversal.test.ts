/**
 * selectionTraversalActions + nudgeSelectedFrames — unit tests (viewport-01).
 *
 * Covers the two store seams behind the new keyboard staples:
 *   - `selectParentNode` / `selectChildNodes` (⇧Enter / Enter, and the
 *     `layers.selectParent` / `layers.selectChildren` palette commands,
 *     which now call the same actions instead of walking the tree themselves).
 *     P5-E (IX-7): both act on the WHOLE selection — Enter selects every
 *     child, ⇧Enter every selected layer's parent (Penpot's
 *     `data/workspace.cljs:891-947`)
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

describe('selectChildNodes (IX-7)', () => {
  it('steps into EVERY child, in child order — not just the first', () => {
    seedThreeLevelPage()
    useEditorStore.getState().selectNode('root')

    expect(useEditorStore.getState().selectChildNodes()).toBe(true)
    expect(useEditorStore.getState().selectedNodeIds).toEqual(['section'])

    expect(useEditorStore.getState().selectChildNodes()).toBe(true)
    // Both children, 'text' before 'image' — the pre-P5-E first-child walk
    // stopped at 'text'.
    expect(useEditorStore.getState().selectedNodeIds).toEqual(['text', 'image'])
  })

  it('collects the children of every selected layer', () => {
    const page = makePage({
      id: 'page-1',
      rootNodeId: 'root',
      nodes: {
        root: makeNode({ id: 'root', moduleId: 'base.body', children: ['a', 'b'] }),
        a: makeNode({ id: 'a', moduleId: 'base.container', children: ['a1'] }),
        b: makeNode({ id: 'b', moduleId: 'base.container', children: ['b1', 'b2'] }),
        a1: makeNode({ id: 'a1', moduleId: 'base.text' }),
        b1: makeNode({ id: 'b1', moduleId: 'base.text' }),
        b2: makeNode({ id: 'b2', moduleId: 'base.text' }),
      },
    })
    useEditorStore.setState({ site: makeSite({ pages: [page] }), activePageId: 'page-1' })
    useEditorStore.getState().selectMany(['a', 'b'])

    expect(useEditorStore.getState().selectChildNodes()).toBe(true)
    expect(useEditorStore.getState().selectedNodeIds).toEqual(['a1', 'b1', 'b2'])
  })

  it('skips hidden and locked children, and no-ops on a leaf', () => {
    seedThreeLevelPage()
    useEditorStore.getState().setNodesHidden(['image'], true)
    useEditorStore.getState().selectNode('section')
    expect(useEditorStore.getState().selectChildNodes()).toBe(true)
    expect(useEditorStore.getState().selectedNodeIds).toEqual(['text'])

    expect(useEditorStore.getState().selectChildNodes()).toBe(false)
    expect(useEditorStore.getState().selectedNodeId).toBe('text')
  })

  it('round-trips with selectParentNode', () => {
    seedThreeLevelPage()
    useEditorStore.getState().selectNode('section')
    useEditorStore.getState().selectChildNodes()
    useEditorStore.getState().selectParentNode()
    expect(useEditorStore.getState().selectedNodeIds).toEqual(['section'])
  })
})

describe('selectParentNode on a multi-selection (IX-7)', () => {
  it('selects the parent of EVERY selected layer, once each', () => {
    const page = makePage({
      id: 'page-1',
      rootNodeId: 'root',
      nodes: {
        root: makeNode({ id: 'root', moduleId: 'base.body', children: ['a', 'b'] }),
        a: makeNode({ id: 'a', moduleId: 'base.container', children: ['a1', 'a2'] }),
        b: makeNode({ id: 'b', moduleId: 'base.container', children: ['b1'] }),
        a1: makeNode({ id: 'a1', moduleId: 'base.text' }),
        a2: makeNode({ id: 'a2', moduleId: 'base.text' }),
        b1: makeNode({ id: 'b1', moduleId: 'base.text' }),
      },
    })
    useEditorStore.setState({ site: makeSite({ pages: [page] }), activePageId: 'page-1' })
    useEditorStore.getState().selectMany(['a1', 'a2', 'b1'])

    expect(useEditorStore.getState().selectParentNode()).toBe(true)
    // Before P5-E only the ANCHOR's parent ('b') was selected.
    expect(useEditorStore.getState().selectedNodeIds).toEqual(['a', 'b'])
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
