/**
 * `store-09` — board state is undoable, on the SAME stack as every site edit.
 *
 * THE BUG THIS EXISTS FOR
 * ───────────────────────
 * Verbatim: *"when moving sticky notes, and elements in the canvas and click
 * ctrl + z it doesn't get back to that position"*, against the standing rule
 * *"it should work on every action"*. `store-08`'s handoff named this exact
 * gap as a deliberate cut: board state lives outside `site` and
 * `runHistoricMutation` records only `site`-scoped patches, so a frame drag
 * and a sticky-note drag produced no history entry at all.
 *
 * What is pinned here:
 *  1. A frame move and an annotation move each undo to the position the
 *     gesture started from, and redo back.
 *  2. ONE entry per drag. Both gestures write on every `pointermove`, so
 *     without the coalesce key a drag would cost one undo step per tick — and
 *     without `endBoardGesture` closing the burst on pointer-up, two separate
 *     drags of the same thing would fold into one.
 *  3. The two domains interleave on one stack in strict LIFO order: a value
 *     edit, then a frame move, then two ⌘Z, undoes the frame move first and
 *     the value edit second.
 *  4. A `.tsx` reparse that invalidates the site-scoped stack leaves board
 *     entries alone, and a fresh `.studio/boards.json` READ drops them (the
 *     snapshots reference an object graph the read just replaced).
 *  5. Undo re-raises `boardsDirty` so the restored state actually persists,
 *     and re-raises `boardsPendingExplicitRemoval` when it shrinks the frame
 *     set — otherwise `boardsSaveGuard` refuses the save that would land it.
 */
import { describe, it, expect, beforeEach, afterAll } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import {
  createBoard,
  createBoardsFile,
  upsertBoard,
  upsertFrame,
  upsertNote,
  type BoardsFile,
} from '@core/studio-board'

const BOARD_ID = 'board-1'

function boardsWithOneFrameAndNote(): BoardsFile {
  let board = createBoard(BOARD_ID, 'Board 1')
  board = upsertFrame(board, { id: 'frame-1', pageId: 'page-1', x: 0, y: 0 })
  board = upsertNote(board, {
    id: 'note-1',
    x: 10,
    y: 10,
    width: 200,
    height: 160,
    text: '',
    color: 'yellow',
    z: 1,
  })
  return upsertBoard(createBoardsFile(), board)
}

function reset() {
  useEditorStore.setState({
    site: null,
    boards: boardsWithOneFrameAndNote(),
    activeBoardId: BOARD_ID,
    boardsLoaded: true,
    boardsDirty: false,
    boardsLoadFailed: false,
    boardsPendingExplicitRemoval: false,
    selectedFrameIds: [],
    selectedAnnotations: [],
    selectedNodeId: null,
    selectedNodeIds: [],
    _historyPast: [],
    _historyFuture: [],
    _historyCoalesceKey: null,
    canUndo: false,
    canRedo: false,
    hasUnsavedChanges: false,
  })
}

/** The active board, as the store currently holds it. */
function board() {
  return useEditorStore.getState().boards.boards.find((b) => b.id === BOARD_ID)!
}
function frame() {
  return board().frames.find((f) => f.id === 'frame-1')!
}
function note() {
  return board().notes.find((n) => n.id === 'note-1')!
}

beforeEach(reset)
// `useEditorStore` is a process-wide singleton shared across test files.
afterAll(reset)

describe('board undo — frame move', () => {
  it('undo returns the frame to where the drag started, redo puts it back', () => {
    useEditorStore.getState().setFramePosition('frame-1', 300, 200)
    expect(frame()).toMatchObject({ x: 300, y: 200 })
    expect(useEditorStore.getState().canUndo).toBe(true)

    useEditorStore.getState().undo()
    expect(frame()).toMatchObject({ x: 0, y: 0 })
    expect(useEditorStore.getState().canRedo).toBe(true)

    useEditorStore.getState().redo()
    expect(frame()).toMatchObject({ x: 300, y: 200 })
  })

  it('one drag is ONE undo entry, however many pointermoves it fired', () => {
    // A real drag calls `setFramePosition` on every move event.
    for (let i = 1; i <= 25; i++) useEditorStore.getState().setFramePosition('frame-1', i * 4, i * 2)
    expect(frame()).toMatchObject({ x: 100, y: 50 })
    expect(useEditorStore.getState()._historyPast).toHaveLength(1)

    useEditorStore.getState().undo()
    expect(frame()).toMatchObject({ x: 0, y: 0 })
    expect(useEditorStore.getState().canUndo).toBe(false)
  })

  it('endBoardGesture splits two drags of the same frame into two entries', () => {
    useEditorStore.getState().setFramePosition('frame-1', 100, 0)
    useEditorStore.getState().endBoardGesture() // pointer-up
    useEditorStore.getState().setFramePosition('frame-1', 100, 400)
    expect(useEditorStore.getState()._historyPast).toHaveLength(2)

    useEditorStore.getState().undo()
    expect(frame()).toMatchObject({ x: 100, y: 0 })
    useEditorStore.getState().undo()
    expect(frame()).toMatchObject({ x: 0, y: 0 })
  })

  it('a resize drag coalesces separately from the move drag of the same frame', () => {
    useEditorStore.getState().setFramePosition('frame-1', 50, 50)
    useEditorStore.getState().setFrameRect('frame-1', 50, 50, 900, 700)
    expect(useEditorStore.getState()._historyPast).toHaveLength(2)
  })
})

describe('board undo — sticky notes and docs', () => {
  it('undo returns a dragged note to where it started', () => {
    for (let i = 1; i <= 10; i++) useEditorStore.getState().moveNote('note-1', 10 + i, 10 + i * 3)
    expect(note()).toMatchObject({ x: 20, y: 40 })
    expect(useEditorStore.getState()._historyPast).toHaveLength(1)

    useEditorStore.getState().undo()
    expect(note()).toMatchObject({ x: 10, y: 10 })
  })

  it('undo of "add note" removes it again, and declares the removal to the save guard', () => {
    useEditorStore.getState().addNote(500, 500)
    expect(board().notes).toHaveLength(2)

    useEditorStore.getState().undo()
    expect(board().notes).toHaveLength(1)
    // The restore must reach `.studio/boards.json` — the autosave watches this.
    expect(useEditorStore.getState().boardsDirty).toBe(true)
  })

  it('undo of "add frame" re-raises boardsPendingExplicitRemoval', () => {
    useEditorStore.getState().addFrame('page-2')
    expect(board().frames).toHaveLength(2)
    useEditorStore.setState({ boardsPendingExplicitRemoval: false })

    useEditorStore.getState().undo()
    expect(board().frames).toHaveLength(1)
    // Without this, `boardsSaveGuard` refuses the save that persists the undo.
    expect(useEditorStore.getState().boardsPendingExplicitRemoval).toBe(true)
  })

  it('undo drops a selection pointing at an annotation that no longer exists', () => {
    useEditorStore.getState().addNote(500, 500)
    const created = board().notes.find((n) => n.id !== 'note-1')!
    useEditorStore.getState().selectAnnotation({ kind: 'note', id: created.id })
    expect(useEditorStore.getState().selectedAnnotations).toHaveLength(1)

    useEditorStore.getState().undo()
    expect(useEditorStore.getState().selectedAnnotations).toHaveLength(0)
  })
})

describe('board undo — one stack, two domains', () => {
  it('a value edit and a frame move undo in strict LIFO order', () => {
    const site = useEditorStore.getState().createSite('Interleave')
    const rootId = site.pages[0]!.rootNodeId
    useEditorStore.setState({ boards: boardsWithOneFrameAndNote(), activeBoardId: BOARD_ID })

    useEditorStore.getState().setNodeInlineStyles(rootId, { padding: '24px' })
    const styledPadding = useEditorStore.getState().site!.pages[0]!.nodes[rootId]!.inlineStyles?.padding
    expect(styledPadding).toBe('24px')

    useEditorStore.getState().setFramePosition('frame-1', 640, 480)
    expect(useEditorStore.getState()._historyPast).toHaveLength(2)

    // 1st ⌘Z — the frame move, the most recent thing the user did.
    useEditorStore.getState().undo()
    expect(frame()).toMatchObject({ x: 0, y: 0 })
    expect(useEditorStore.getState().site!.pages[0]!.nodes[rootId]!.inlineStyles?.padding).toBe('24px')

    // 2nd ⌘Z — the style value.
    useEditorStore.getState().undo()
    expect(useEditorStore.getState().site!.pages[0]!.nodes[rootId]!.inlineStyles?.padding).toBeUndefined()
    expect(frame()).toMatchObject({ x: 0, y: 0 })

    // …and redo walks back up the same stack.
    useEditorStore.getState().redo()
    expect(useEditorStore.getState().site!.pages[0]!.nodes[rootId]!.inlineStyles?.padding).toBe('24px')
    useEditorStore.getState().redo()
    expect(frame()).toMatchObject({ x: 640, y: 480 })
  })

  it('a board entry undoes with no site loaded at all', () => {
    expect(useEditorStore.getState().site).toBeNull()
    useEditorStore.getState().setFramePosition('frame-1', 12, 34)
    useEditorStore.getState().undo()
    expect(frame()).toMatchObject({ x: 0, y: 0 })
  })
})

describe('board undo — reload boundaries', () => {
  it('a site reload that invalidates the site stack keeps the board entries', () => {
    const site = useEditorStore.getState().createSite('Reload')
    const rootId = site.pages[0]!.rootNodeId
    useEditorStore.setState({ boards: boardsWithOneFrameAndNote(), activeBoardId: BOARD_ID })
    useEditorStore.getState().setNodeInlineStyles(rootId, { padding: '8px' })
    useEditorStore.getState().setFramePosition('frame-1', 77, 88)
    const past = useEditorStore.getState()._historyPast
    expect(past).toHaveLength(2)

    // A genuinely different document — the site-scoped entry can no longer be
    // replayed, so `historySurvivesReload` fails and the old code wiped BOTH.
    // `createSite` publishes a deeply-frozen document; `loadSite` reindexes in
    // place, so hand it a mutable copy.
    const other = JSON.parse(JSON.stringify(useEditorStore.getState().createSite('Other')))
    useEditorStore.setState({ _historyPast: past, _historyFuture: [], canUndo: true })
    useEditorStore.getState().loadSite(other)

    const kept = useEditorStore.getState()._historyPast
    expect(kept).toHaveLength(1)
    expect(kept[0]!.board).toBeDefined()
    useEditorStore.getState().undo()
    expect(frame()).toMatchObject({ x: 0, y: 0 })
  })

  it('a fresh boards.json read drops board entries rather than replaying a stale graph', () => {
    useEditorStore.getState().setFramePosition('frame-1', 55, 66)
    expect(useEditorStore.getState()._historyPast).toHaveLength(1)

    useEditorStore.getState().loadBoards(boardsWithOneFrameAndNote())

    expect(useEditorStore.getState()._historyPast).toHaveLength(0)
    expect(useEditorStore.getState().canUndo).toBe(false)
  })
})
