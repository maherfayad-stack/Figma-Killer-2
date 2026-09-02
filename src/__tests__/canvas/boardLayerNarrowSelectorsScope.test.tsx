/**
 * Board layer sibling-isolation gate — the fix for the O(frames + notes +
 * docs) re-render cascade on every pointermove while dragging or resizing a
 * board frame.
 *
 * Before this change every board layer (`BoardFramesLayer`,
 * `BoardNotesLayer`, `BoardDocsLayer`, `RulerGuidesLayer`, `CanvasRulers`)
 * subscribed to `selectActiveBoard`, which returns the whole `Board` object.
 * Every board-mutating helper in `@core/studio-board`'s `boardsModel.ts`
 * (`moveFrame`, `moveNote`, `moveDoc`, `resizeFrame`, …) does correct
 * copy-on-write on the WHOLE `Board` for Mutative/history correctness, so
 * `selectActiveBoard` changed reference on ANY board write — a note drag
 * re-rendered the frames layer, a frame drag re-rendered the notes/docs/
 * guides layers, etc. This is the sibling half of that fix: each layer now
 * subscribes to only its own sub-collection (`selectActiveBoardFrames` /
 * `selectActiveBoardNotes` / `selectActiveBoardDocs` / `selectActiveBoardGuides`
 * in `boardSlice.ts`), which stay referentially stable across a write to a
 * DIFFERENT collection because `boardsModel.ts`'s transforms reuse the
 * untouched sibling arrays unchanged (`{ ...board, notes }` leaves `frames`/
 * `docs`/`guides` exactly as they were).
 *
 * Same Profiler technique as `boardFramesLayerRenderScope.test.tsx` (Track
 * C2's sibling gate): the Bun test runtime does not run the app's Vite/Babel
 * React Compiler transform, so a re-render of a layer happens if and only if
 * one of ITS OWN zustand subscriptions actually changed — the Profiler
 * wrapping each layer is a direct, unconfounded proxy for exactly the
 * question this test asks.
 *
 * Counts are compared as DELTAS from a post-mount baseline, not absolute
 * values — `DocBlockView`'s `ref={setCardEl}` callback-ref pattern (unrelated
 * to this fix; it hands the mounted card element to the portaled toolbar)
 * causes one extra commit for `BoardDocsLayer` right after mount, which would
 * make a hardcoded "renders exactly once on mount" assertion flaky for that
 * one layer specifically. What this test actually asserts — that a write to
 * collection X bumps ONLY layer X's count — doesn't care what the baseline is.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Profiler, type ProfilerOnRenderCallback } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { createBoard, type BoardsFile } from '@core/studio-board'
import { BoardFramesLayer } from '@site/canvas/BoardFramesLayer'
import { BoardNotesLayer } from '@site/canvas/BoardNotesLayer'
import { BoardDocsLayer } from '@site/canvas/BoardDocsLayer'
import { RulerGuidesLayer } from '@site/canvas/RulerGuidesLayer/RulerGuidesLayer'
import { useEditorStore } from '@site/store/store'
import { makeNode, makePage, makeSite } from '../fixtures'
import '@modules/base'

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
    selectedNodeId: null,
    selectedNodeIds: [],
    hoveredNodeId: null,
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
})

afterEach(() => {
  cleanup()
  resetStore()
})

function setUpBoard() {
  const page = makePage({
    id: 'page-a',
    nodes: {
      root: makeNode({ id: 'root', moduleId: 'base.body', children: [] }),
    },
  })
  const site = makeSite({ pages: [page] })

  const board = createBoard('board-1', 'Board 1')
  // Off-screen at zoom 1 / pan 0 — mirrors `boardFramesLayerRenderScope.test.tsx`:
  // BoardFrameView still fully mounts (header, drag handle) but skips the
  // live iframe, keeping this test fast.
  board.frames = [{ id: 'frame-a', pageId: page.id, x: 100000, y: 0 }]
  board.notes = [{ id: 'note-a', x: 0, y: 0, w: 120, h: 120, text: 'hi', color: 'yellow' }]
  board.docs = [{ id: 'doc-a', x: 0, y: 200, w: 200, h: 120, html: '<p>doc</p>' }]

  const file: BoardsFile = { version: 1, boards: [board] }
  useEditorStore.setState({ site, activePageId: page.id } as Parameters<typeof useEditorStore.setState>[0])
  useEditorStore.getState().loadBoards(file)
  useEditorStore.setState({ activeBoardId: board.id })
}

type Counts = { frames: number; notes: number; docs: number; guides: number }

function mountAllLayers() {
  const counts: Counts = { frames: 0, notes: 0, docs: 0, guides: 0 }
  const onRender = (key: keyof Counts): ProfilerOnRenderCallback => () => { counts[key] += 1 }

  render(
    <>
      <Profiler id="frames" onRender={onRender('frames')}><BoardFramesLayer /></Profiler>
      <Profiler id="notes" onRender={onRender('notes')}><BoardNotesLayer /></Profiler>
      <Profiler id="docs" onRender={onRender('docs')}><BoardDocsLayer /></Profiler>
      <Profiler id="guides" onRender={onRender('guides')}><RulerGuidesLayer /></Profiler>
    </>,
  )

  return counts
}

describe('Board layer sibling isolation (O(frames+notes+docs) cascade fix)', () => {
  it('a frame move/resize bumps only BoardFramesLayer\'s count', () => {
    setUpBoard()
    const counts = mountAllLayers()
    const baseline = { ...counts }

    // The pointermove mutation itself — `setFramePosition`. Stays off-screen
    // (`x` still ≥ 100000) so the assertion below isolates the POSITION-write
    // render cost from the unrelated, legitimate extra commits a frame's own
    // `BreakpointFrame`/iframe produces the moment it first scrolls on
    // screen (`isFrameOnScreen` flipping true mounts real content — a
    // separate, real cost this test is not about).
    act(() => { useEditorStore.getState().setFramePosition('frame-a', 100010, 20) })

    expect(counts.frames).toBe(baseline.frames + 1)
    expect(counts.notes).toBe(baseline.notes)
    expect(counts.docs).toBe(baseline.docs)
    expect(counts.guides).toBe(baseline.guides)

    // The combined resize write — `setFrameRect` — must ALSO only touch the
    // frames layer, and must do it in ONE commit (one Profiler firing), not
    // two (see boardSlice.test.ts's `setFrameRect` test for the underlying
    // single-`set()` proof).
    act(() => { useEditorStore.getState().setFrameRect('frame-a', 100020, 30, 500, 400) })

    expect(counts.frames).toBe(baseline.frames + 2)
    expect(counts.notes).toBe(baseline.notes)
    expect(counts.docs).toBe(baseline.docs)
    expect(counts.guides).toBe(baseline.guides)
  })

  it('a note move bumps only BoardNotesLayer\'s count', () => {
    setUpBoard()
    const counts = mountAllLayers()
    const baseline = { ...counts }

    act(() => { useEditorStore.getState().moveNote('note-a', 5, 5) })

    expect(counts.notes).toBe(baseline.notes + 1)
    expect(counts.frames).toBe(baseline.frames)
    expect(counts.docs).toBe(baseline.docs)
    expect(counts.guides).toBe(baseline.guides)
  })

  it('a doc move bumps only BoardDocsLayer\'s count', () => {
    setUpBoard()
    const counts = mountAllLayers()
    const baseline = { ...counts }

    act(() => { useEditorStore.getState().moveDoc('doc-a', 5, 5) })

    expect(counts.docs).toBe(baseline.docs + 1)
    expect(counts.frames).toBe(baseline.frames)
    expect(counts.notes).toBe(baseline.notes)
    expect(counts.guides).toBe(baseline.guides)
  })

  it('a guide write bumps only RulerGuidesLayer\'s count', () => {
    setUpBoard()
    const counts = mountAllLayers()
    const baseline = { ...counts }

    act(() => { useEditorStore.getState().addGuide('x', 100) })

    expect(counts.guides).toBe(baseline.guides + 1)
    expect(counts.frames).toBe(baseline.frames)
    expect(counts.notes).toBe(baseline.notes)
    expect(counts.docs).toBe(baseline.docs)
  })
})
