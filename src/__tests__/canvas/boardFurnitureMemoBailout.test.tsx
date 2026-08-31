/**
 * `memo()` bailout gate for the hot, list-rendered board furniture views —
 * `BoardFrameView`, `StickyNoteView`, `DocBlockView` (React Compiler
 * exception #2, same justification `NodeRenderer.tsx` already documents).
 *
 * `boardLayerNarrowSelectorsScope.test.tsx` proves the LAYER (`BoardFramesLayer`
 * / `BoardNotesLayer` / `BoardDocsLayer`) only re-renders on a write to its
 * own collection. This file proves the other half: WITHIN a re-rendering
 * layer (its `.map()` re-executes because the collection it owns DID change),
 * only the ONE item that actually changed does real work — not every sibling
 * frame/note/doc on the board.
 *
 * `Profiler.onRender` is NOT a valid instrument for this half of the claim:
 * it fires once per commit for a `memo()`-wrapped child's `<Profiler>`
 * wrapper EVEN WHEN the child bails out and its function body never runs —
 * confirmed empirically before writing this file (React still "visits" the
 * fiber to perform the props-equality check, and that visit is itself
 * counted as the commit Profiler measures). What actually distinguishes "ran"
 * from "bailed" is whether the function BODY executed — so each test here
 * spies on something each component calls unconditionally at the top of its
 * own body (`useFramePosterCapture` / `useAutoFitText` / `sanitizeBoardDocHtml`)
 * and asserts on CALL COUNT, not commit count.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { useState } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import type { BoardFrame, StickyNote, DocBlock } from '@core/studio-board'
import * as posterMod from '@site/canvas/BoardFramesLayer/useFramePosterCapture'
import * as autoFitMod from '@site/canvas/BoardNotesLayer/useAutoFitText'
import * as sanitizeMod from '@core/sanitize'
import { BoardFrameView } from '@site/canvas/BoardFramesLayer/BoardFrameView'
import { StickyNoteView } from '@site/canvas/BoardNotesLayer/StickyNoteView'
import { DocBlockView } from '@site/canvas/BoardDocsLayer/DocBlockView'
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

describe('BoardFrameView memo() bailout', () => {
  it('an unaffected frame does no work when a sibling frame is dragged', () => {
    const spy = spyOn(posterMod, 'useFramePosterCapture')

    const pageA = makePage({ id: 'page-a', nodes: { root: makeNode({ id: 'root', moduleId: 'base.body', children: [] }) } })
    const pageB = makePage({ id: 'page-b', nodes: { root: makeNode({ id: 'root', moduleId: 'base.body', children: [] }) } })
    const site = makeSite({ pages: [pageA, pageB] })
    useEditorStore.setState({ site, activePageId: pageA.id } as Parameters<typeof useEditorStore.setState>[0])

    // Mirrors what `BoardFramesLayer.map()` actually hands each item:
    // `frame`/`page` object references that `boardsModel.ts`'s copy-on-write
    // keeps stable for every UNAFFECTED frame across a write (only the
    // touched array slot is replaced). `tick` mimics the layer's OWN
    // `.map()` re-executing for an unrelated reason (e.g. `zoom`/`panX`
    // changing) without touching either frame object.
    function Harness() {
      const [frameA, setFrameA] = useState<BoardFrame>({ id: 'frame-a', pageId: pageA.id, x: 100000, y: 0 })
      const [frameB] = useState<BoardFrame>({ id: 'frame-b', pageId: pageB.id, x: 100000, y: 2000 })
      const [, setTick] = useState(0)

      return (
        <>
          <button data-testid="move-a" onClick={() => setFrameA((f) => ({ ...f, x: f.x + 10 }))} />
          <button data-testid="tick" onClick={() => setTick((t) => t + 1)} />
          <BoardFrameView
            frame={frameA}
            page={pageA}
            x={frameA.x}
            y={frameA.y}
            width={1024}
            height={800}
            hasManualHeight={false}
            isActive={false}
            isSelected={false}
            isOnScreen={false}
          />
          <BoardFrameView
            frame={frameB}
            page={pageB}
            x={frameB.x}
            y={frameB.y}
            width={1024}
            height={800}
            hasManualHeight={false}
            isActive={false}
            isSelected={false}
            isOnScreen={false}
          />
        </>
      )
    }

    const { getByTestId } = render(<Harness />)
    expect(spy.mock.calls.length).toBe(2) // one call per mounted frame

    // Force the harness to re-render without touching either frame object.
    act(() => { getByTestId('tick').click() })
    expect(spy.mock.calls.length).toBe(2) // neither view re-executed

    // Move frame A only — its own view does real work, B's does not.
    act(() => { getByTestId('move-a').click() })
    expect(spy.mock.calls.length).toBe(3)
  })
})

describe('StickyNoteView memo() bailout', () => {
  it('an unaffected note does no work when a sibling note moves', () => {
    const spy = spyOn(autoFitMod, 'useAutoFitText')

    function Harness() {
      const [noteA, setNoteA] = useState<StickyNote>({ id: 'note-a', x: 0, y: 0, w: 120, h: 120, text: 'a', color: 'yellow' })
      const [noteB] = useState<StickyNote>({ id: 'note-b', x: 200, y: 0, w: 120, h: 120, text: 'b', color: 'blue' })
      const [, setTick] = useState(0)

      return (
        <>
          <button data-testid="move-a" onClick={() => setNoteA((n) => ({ ...n, x: n.x + 10 }))} />
          <button data-testid="tick" onClick={() => setTick((t) => t + 1)} />
          <StickyNoteView note={noteA} />
          <StickyNoteView note={noteB} />
        </>
      )
    }

    const { getByTestId } = render(<Harness />)
    expect(spy.mock.calls.length).toBe(2)

    act(() => { getByTestId('tick').click() })
    expect(spy.mock.calls.length).toBe(2)

    act(() => { getByTestId('move-a').click() })
    expect(spy.mock.calls.length).toBe(3)
  })
})

describe('DocBlockView memo() bailout', () => {
  it('an unaffected doc does no work when a sibling doc moves', () => {
    const spy = spyOn(sanitizeMod, 'sanitizeBoardDocHtml')

    function Harness() {
      const [docA, setDocA] = useState<DocBlock>({ id: 'doc-a', x: 0, y: 0, w: 200, h: 120, html: '<p>a</p>' })
      const [docB] = useState<DocBlock>({ id: 'doc-b', x: 300, y: 0, w: 200, h: 120, html: '<p>b</p>' })
      const [, setTick] = useState(0)

      return (
        <>
          <button data-testid="move-a" onClick={() => setDocA((d) => ({ ...d, x: d.x + 10 }))} />
          <button data-testid="tick" onClick={() => setTick((t) => t + 1)} />
          <DocBlockView doc={docA} />
          <DocBlockView doc={docB} />
        </>
      )
    }

    const { getByTestId } = render(<Harness />)
    // Baseline captured AFTER mount, not assumed as "one call per doc" — the
    // card's `ref={setCardEl}` callback (anchors the portaled `DocToolbar`)
    // sets its own state right after the initial commit, so each doc
    // genuinely re-renders (and re-sanitizes) TWICE on mount before settling.
    // That self-triggered settle is unrelated to this fix; what this test
    // asserts is what happens to a STEADY-STATE mounted doc afterward.
    const baseline = spy.mock.calls.length

    act(() => { getByTestId('tick').click() })
    expect(spy.mock.calls.length).toBe(baseline)

    act(() => { getByTestId('move-a').click() })
    expect(spy.mock.calls.length).toBe(baseline + 1)
  })
})
