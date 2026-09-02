/**
 * WS-7.3 — bulk node actions (delete/wrap) and multi-selection across studio
 * board frames.
 *
 * Before this work order, `deleteNodes`/`wrapNodes` always routed through
 * `mutateActiveTree` (the single ACTIVE page), and `selectNode`'s toggle/range
 * modes refused to add a node from any page other than the active one
 * (`sameTree`). A `MultiSelectionInspector` selection therefore could never
 * actually span frames — clicking a node in a second frame replaced the
 * selection instead of extending it. These tests pin the fix:
 *   - `sameTree`/`filterMultiSelectableIds` allow toggle-selecting a node from
 *     any page curated as a frame on the ACTIVE studio board.
 *   - Outside board mode, cross-page multi-select is still refused (CMS/VC
 *     editing is unaffected — same-tree-only, exactly as before).
 *   - `deleteNodes` with a selection spanning two pages removes from BOTH in
 *     ONE undo entry, leaves-before-parents ordering preserved per page.
 *   - `wrapNodes` with a cross-page selection wraps each page's own subset
 *     independently (one wrapper node cannot hold children from two files).
 */
import { describe, it, expect, beforeEach, afterAll } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import { createBoard, createBoardsFile, type BoardsFile } from '@core/studio-board'
import { makeNode, makePage, makeSite } from '../fixtures'
import '@modules/base/index'

function freshStore(): void {
  useEditorStore.setState({
    site: null,
    activePageId: null,
    activeDocument: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    hoveredNodeId: null,
    boards: createBoardsFile(),
    activeBoardId: null,
    boardsLoaded: false,
    boardsDirty: false,
    selectedFrameIds: [],
    frameDefaults: {},
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
    hasUnsavedChanges: false,
  } as Parameters<typeof useEditorStore.setState>[0])
}

beforeEach(freshStore)
// `useEditorStore` is a process-wide singleton shared by every test file in
// this run (see boardSlice.test.ts's module doc) — an active board left
// behind here would make `selectActiveBoard` return non-null in unrelated
// test files, silently switching their `selectNode` calls onto the
// board-scoped multi-select path.
afterAll(freshStore)

/** A two-page site, each page with a distinct top-level text node, plus a board with BOTH pages curated as frames. */
function loadTwoFramePageSite() {
  const pageA = makePage({
    id: 'page-a',
    rootNodeId: 'root-a',
    nodes: {
      'root-a': makeNode({ id: 'root-a', moduleId: 'base.body', children: ['a-text'] }),
      'a-text': makeNode({ id: 'a-text', moduleId: 'base.text' }),
    },
  })
  const pageB = makePage({
    id: 'page-b',
    rootNodeId: 'root-b',
    nodes: {
      'root-b': makeNode({ id: 'root-b', moduleId: 'base.body', children: ['b-text'] }),
      'b-text': makeNode({ id: 'b-text', moduleId: 'base.text' }),
    },
  })
  useEditorStore.getState().loadSite(makeSite({ pages: [pageA, pageB] }))
  useEditorStore.setState({ activePageId: 'page-a' })

  const board = createBoard('board-1', 'Board 1')
  board.frames = [
    { pageId: 'page-a', x: 0, y: 0 },
    { pageId: 'page-b', x: 500, y: 0 },
  ]
  const file: BoardsFile = { version: 1, boards: [board] }
  useEditorStore.getState().loadBoards(file)
  useEditorStore.setState({ activeBoardId: board.id })
}

// ---------------------------------------------------------------------------
// Cross-frame multi-select eligibility
// ---------------------------------------------------------------------------

describe('cross-frame node multi-select (selectionSlice)', () => {
  it('toggle-selects a node from a DIFFERENT page when both pages are frames on the active board', () => {
    loadTwoFramePageSite()

    useEditorStore.getState().selectNode('a-text', 'replace')
    // Switching to frame B first, mirroring BoardFramesLayer's
    // activate-on-pointerdown-capture behaviour.
    useEditorStore.setState({ activePageId: 'page-b' })
    useEditorStore.getState().selectNode('b-text', 'toggle')

    expect(useEditorStore.getState().selectedNodeIds).toEqual(['a-text', 'b-text'])
  })

  it('refuses to extend across pages OUTSIDE studio board mode (no active board)', () => {
    loadTwoFramePageSite()
    useEditorStore.setState({ activeBoardId: null })

    useEditorStore.getState().selectNode('a-text', 'replace')
    useEditorStore.setState({ activePageId: 'page-b' })
    useEditorStore.getState().selectNode('b-text', 'toggle')

    // sameTree() fails (no board to widen scope, and page-b's node isn't in
    // page-a's tree) — toggle falls back to replace-select.
    expect(useEditorStore.getState().selectedNodeIds).toEqual(['b-text'])
  })
})

// ---------------------------------------------------------------------------
// deleteNodes across frames
// ---------------------------------------------------------------------------

describe('deleteNodes — cross-frame (WS-7.3)', () => {
  it('deletes nodes on two different pages in ONE undo entry', () => {
    loadTwoFramePageSite()
    const depthBefore = useEditorStore.getState()._historyPast.length

    useEditorStore.getState().deleteNodes(['a-text', 'b-text'])

    const pages = useEditorStore.getState().site!.pages
    expect(pages.find((p) => p.id === 'page-a')!.nodes['a-text']).toBeUndefined()
    expect(pages.find((p) => p.id === 'page-b')!.nodes['b-text']).toBeUndefined()
    expect(useEditorStore.getState()._historyPast.length).toBe(depthBefore + 1)

    // One undo restores BOTH pages.
    useEditorStore.getState().undo()
    const restored = useEditorStore.getState().site!.pages
    expect(restored.find((p) => p.id === 'page-a')!.nodes['a-text']).toBeDefined()
    expect(restored.find((p) => p.id === 'page-b')!.nodes['b-text']).toBeDefined()
  })

  it('the single-page case is unaffected (no cross-page grouping overhead changes behaviour)', () => {
    loadTwoFramePageSite()
    useEditorStore.getState().deleteNodes(['a-text'])

    const pages = useEditorStore.getState().site!.pages
    expect(pages.find((p) => p.id === 'page-a')!.nodes['a-text']).toBeUndefined()
    expect(pages.find((p) => p.id === 'page-b')!.nodes['b-text']).toBeDefined()
  })

  it('prunes the multi-selection across BOTH pages after a cross-frame delete', () => {
    loadTwoFramePageSite()
    useEditorStore.setState({ selectedNodeIds: ['a-text', 'b-text'], selectedNodeId: 'b-text' })

    useEditorStore.getState().deleteNodes(['a-text', 'b-text'])

    expect(useEditorStore.getState().selectedNodeIds).toEqual([])
    expect(useEditorStore.getState().selectedNodeId).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// wrapNodes across frames
// ---------------------------------------------------------------------------

describe('wrapNodes — cross-frame (WS-7.3)', () => {
  it('wraps each page\'s own subset independently instead of dropping the other page\'s node', () => {
    loadTwoFramePageSite()

    const wrapperId = useEditorStore.getState().wrapNodes(['a-text', 'b-text'], 'base.container')
    expect(wrapperId).not.toBeNull()

    const pages = useEditorStore.getState().site!.pages
    const pageA = pages.find((p) => p.id === 'page-a')!
    const pageB = pages.find((p) => p.id === 'page-b')!

    // Each page's own text node is now wrapped by a container that is a
    // child of that page's own root — two DIFFERENT wrapper nodes, since one
    // wrapper cannot span two files.
    const wrapperInA = pageA.nodes[pageA.nodes['a-text']!.parentId!]
    const wrapperInB = pageB.nodes[pageB.nodes['b-text']!.parentId!]
    expect(wrapperInA.moduleId).toBe('base.container')
    expect(wrapperInB.moduleId).toBe('base.container')
    expect(wrapperInA.id).not.toBe(wrapperInB.id)
    expect(pageA.nodes[pageA.rootNodeId].children).toContain(wrapperInA.id)
    expect(pageB.nodes[pageB.rootNodeId].children).toContain(wrapperInB.id)
  })
})
