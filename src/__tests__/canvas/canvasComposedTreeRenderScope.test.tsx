/**
 * Track C3 regression gate — `CanvasComposedTree` must not re-render for a
 * frame showing a DIFFERENT page than the one that was just edited.
 *
 * Before the fix, `CanvasComposedTree` subscribed directly to the WHOLE
 * `s.site` object purely to call `resolveEditorWrapperTemplates(site, page)`.
 * `site`'s top-level reference changes on every site-touching mutation
 * anywhere in the document (Mutative mints a new root object per mutation),
 * so a `useEditorStore((s) => s.site)` subscription forces a re-render of
 * EVERY mounted instance, regardless of which page's `page` prop it was
 * actually handed — this is exactly the "≤ 1 re-render per visible frame, not
 * per mounted frame" budget in STUDIO-FIGMA-PARITY-PLAN.md's Track C.
 *
 * This test mounts two frames (mirroring two board frames showing two
 * different pages) and asserts that editing one page's node content via the
 * REAL `updateNodeProps` store action (so Mutative's actual structural
 * sharing is exercised, not a hand-rolled spread) only re-renders the edited
 * frame's `CanvasComposedTree`, never the other one's.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Profiler, type ProfilerOnRenderCallback } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { CanvasComposedTree } from '@site/canvas/CanvasComposedTree'
import { CanvasPageContext } from '@site/canvas/CanvasContexts'
import { useEditorStore } from '@site/store/store'
import { makeNode, makePage, makeSite } from '../fixtures'
import '@modules/base'

function resetStore() {
  useEditorStore.setState({
    site: null,
    activePageId: null,
    activeDocument: null,
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

/**
 * Mirrors a real board frame: provides `CanvasPageContext` (so `NodeRenderer`
 * resolves against THIS frame's page, not "the active document") and re-reads
 * its own page from the store the same way `BoardFramesLayer` would.
 */
function FrameHarness({ pageId, onRender }: { pageId: string; onRender: ProfilerOnRenderCallback }) {
  const page = useEditorStore((s) => s.site!.pages.find((p) => p.id === pageId)!)
  return (
    <CanvasPageContext.Provider value={pageId}>
      <Profiler id={pageId} onRender={onRender}>
        <CanvasComposedTree page={page} />
      </Profiler>
    </CanvasPageContext.Provider>
  )
}

function makeTextPage(id: string, text: string) {
  return makePage({
    id,
    nodes: {
      root: makeNode({ id: 'root', moduleId: 'base.body', children: [`${id}-text`] }),
      [`${id}-text`]: makeNode({ id: `${id}-text`, moduleId: 'base.text', props: { text } }),
    },
  })
}

describe('CanvasComposedTree render scope (Track C3)', () => {
  it('editing the active page does not re-render a CanvasComposedTree mounted for a different page', () => {
    const pageA = makeTextPage('page-a', 'A')
    const pageB = makeTextPage('page-b', 'B')
    const site = makeSite({ pages: [pageA, pageB] })

    useEditorStore.setState({
      site,
      activePageId: 'page-a',
    } as Parameters<typeof useEditorStore.setState>[0])

    const renderCounts: Record<string, number> = { 'page-a': 0, 'page-b': 0 }
    const onRender: ProfilerOnRenderCallback = (id) => {
      renderCounts[id] = (renderCounts[id] ?? 0) + 1
    }

    render(
      <>
        <FrameHarness pageId="page-a" onRender={onRender} />
        <FrameHarness pageId="page-b" onRender={onRender} />
      </>,
    )

    expect(renderCounts['page-a']).toBe(1)
    expect(renderCounts['page-b']).toBe(1)

    // A real keystroke on the ACTIVE page's own text node — `updateNodeProps`
    // resolves against `activePageId` (page-a) via `mutateActiveTree`, the
    // exact path a Properties Panel edit takes.
    act(() => {
      useEditorStore.getState().updateNodeProps('page-a-text', { text: 'A edited' })
    })

    // The edited frame legitimately re-renders (its own `page` prop changed).
    expect(renderCounts['page-a']).toBeGreaterThan(1)
    // The untouched frame's CanvasComposedTree must NOT re-render — this is
    // the regression this file exists to catch.
    expect(renderCounts['page-b']).toBe(1)
  })
})
