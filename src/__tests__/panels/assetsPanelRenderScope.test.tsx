/**
 * The Assets panel does not re-render when the user clicks or types on the
 * canvas — P6-C, measured in a real browser by `canvas-edit-budgets.e2e.ts`.
 *
 * The insert hooks the panel runs (`useInsertInserterItem`, `useInsertModule`,
 * `useCanvasInsertionDrag`, `useModuleInsertionContext`) used to SUBSCRIBE to
 * the selection and to the active page object — state they only read at the
 * moment something is inserted. Every click changed the selection and every
 * keystroke made a new page object, so every click and every keystroke
 * re-rendered the whole panel: in the browser, 46 asset cards with their
 * previews and ~130 buttons and tooltips, most of the work of a click on the
 * large board. They now read that state through `getState()` when an insert
 * happens, and the insertion context subscribes to its four primitive answers.
 *
 * `bun test` runs without the React Compiler, so a subscription that changes
 * re-renders the panel here exactly as it did in the browser.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { Profiler } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { AssetsPanel } from '@site/panels/AssetsPanel'
import { useEditorStore } from '@site/store/store'
import { __resetAssetFavoritesForTests } from '@site/panels/AssetsPanel/assetsPrefs'
import { makeNode, makePage, makeSite } from '../fixtures'
import '@modules/base/index'

const originalFetch = globalThis.fetch

beforeEach(() => {
  localStorage.clear()
  __resetAssetFavoritesForTests()
  globalThis.fetch = mock(async () => new Response(JSON.stringify({ value: null }), { status: 200 })) as typeof fetch
  const page = makePage({
    id: 'page-home',
    title: 'Home',
    slug: 'index',
    rootNodeId: 'root',
    nodes: {
      root: makeNode({ id: 'root', moduleId: 'base.body', children: ['a', 'b'] }),
      a: makeNode({ id: 'a', moduleId: 'base.text', props: { text: 'First' } }),
      b: makeNode({ id: 'b', moduleId: 'base.text', props: { text: 'Second' } }),
    },
  })
  useEditorStore.setState({
    site: makeSite({ pages: [page], files: [] }),
    activePageId: 'page-home',
    selectedNodeId: null,
    selectedNodeIds: [],
    activeDocument: null,
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
    hasUnsavedChanges: false,
  } as Parameters<typeof useEditorStore.setState>[0])
})

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  globalThis.fetch = originalFetch
})

function renderCountingCommits(): { commits: () => number } {
  let commits = 0
  render(
    <Profiler id="assets" onRender={() => { commits += 1 }}>
      <AssetsPanel />
    </Profiler>,
  )
  return { commits: () => commits }
}

describe('the Assets panel stays still while the user works on the canvas', () => {
  it('selecting a node re-renders nothing in the panel', () => {
    const panel = renderCountingCommits()
    const before = panel.commits()
    act(() => useEditorStore.getState().selectNode('a'))
    act(() => useEditorStore.getState().selectNode('b'))
    expect(panel.commits() - before).toBe(0)
  })

  it('editing a node (a keystroke) re-renders nothing in the panel', () => {
    act(() => useEditorStore.getState().selectNode('a'))
    const panel = renderCountingCommits()
    const before = panel.commits()
    act(() => useEditorStore.getState().updateNodeProps('a', { text: 'Firstx' }))
    act(() => useEditorStore.getState().updateNodeProps('a', { text: 'Firstxy' }))
    expect(useEditorStore.getState().site?.pages[0]?.nodes.a?.props.text).toBe('Firstxy')
    expect(panel.commits() - before).toBe(0)
  })
})
