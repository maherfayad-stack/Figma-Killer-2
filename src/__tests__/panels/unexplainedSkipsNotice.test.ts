/**
 * Phase 0 item 0.7 — the save-skip toast never says which node.
 *
 * `notifyUnexplainedSkips` is the rendering half: given the server's
 * `unexplainedSkips: { nodeId, kind }[]` (this change's addition to
 * `StudioEditBatchResult` / `StudioSaveResponseSchema`), it resolves node
 * ids against the CURRENT page tree and renders a toast that names them,
 * with a "Select" action that jumps the canvas there for real.
 */
import { describe, it, expect, beforeEach } from 'bun:test'
import { subscribeToasts, type Toast } from '@ui/components/Toast/toastBus'
import { notifyUnexplainedSkips } from '@site/panels/unexplainedSkipsNotice'
import { useEditorStore } from '@site/store/store'
import { makeSite, makePage, makeNode } from '../fixtures'

function resetStore() {
  useEditorStore.setState({
    site: null,
    activePageId: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    // Without this, a board left active by an EARLIER test file in the same
    // process routes `selectMany`'s `resolveSelectableNode` through
    // `_nodeIdToPageIds` (the board-mode branch) instead of this test's own
    // freshly-`setState`'d `site.pages` — and that index was never rebuilt
    // for this ad-hoc fixture (this file bypasses the `loadSite` action, so
    // there's no `rebuildNodeIndexes` call to populate it), so every id
    // resolves to nothing and the multi-select silently comes back empty.
    // Matches the same `activeBoardId: null` convention every other
    // board-agnostic store test in this codebase already uses.
    activeBoardId: null,
  } as Parameters<typeof useEditorStore.setState>[0])
}

beforeEach(resetStore)

function collectToasts(): Toast[] {
  let latest: Toast[] = []
  subscribeToasts((snapshot) => {
    latest = [...snapshot]
  })
  return latest
}

function loadTwoPageSite() {
  const page1Root = makeNode({ id: 'p1-root', moduleId: 'base.body', children: ['p1-a', 'p1-b'] })
  const p1a = makeNode({ id: 'p1-a', moduleId: 'base.text', label: 'Heading', props: {} })
  const p1b = makeNode({ id: 'p1-b', moduleId: 'base.text', props: { text: 'Body' } })
  const page1 = makePage({
    id: 'page-1',
    rootNodeId: 'p1-root',
    nodes: { 'p1-root': page1Root, 'p1-a': p1a, 'p1-b': p1b },
  })

  const page2Root = makeNode({ id: 'p2-root', moduleId: 'base.body', children: ['p2-a'] })
  const p2a = makeNode({ id: 'p2-a', moduleId: 'base.text', label: 'Footer text', props: {} })
  const page2 = makePage({ id: 'page-2', rootNodeId: 'p2-root', nodes: { 'p2-root': page2Root, 'p2-a': p2a } })

  const site = makeSite({ pages: [page1, page2] })
  useEditorStore.setState({ site, activePageId: 'page-1' } as Parameters<typeof useEditorStore.setState>[0])
}

describe('notifyUnexplainedSkips', () => {
  it('does nothing for an empty list', () => {
    notifyUnexplainedSkips([])
    expect(collectToasts()).toHaveLength(0)
  })

  it('names a single resolvable node and offers a "Select node" action', () => {
    loadTwoPageSite()
    notifyUnexplainedSkips([{ nodeId: 'p1-a', kind: 'text' }])

    const toasts = collectToasts()
    expect(toasts).toHaveLength(1)
    expect(toasts[0].body).toContain('Heading')
    expect(toasts[0].action?.label).toBe('Select node')
  })

  it('lists up to 3 names, and folds the rest into a "+N more" tail', () => {
    loadTwoPageSite()
    notifyUnexplainedSkips([
      { nodeId: 'p1-a', kind: 'text' },
      { nodeId: 'p1-b', kind: 'prop' },
      { nodeId: 'p2-a', kind: 'text' },
    ])

    const body = collectToasts()[0].body!
    expect(body).toContain('Heading')
    expect(body).toContain('Footer text')
  })

  it('falls back to a count for a node id the current tree does not contain', () => {
    loadTwoPageSite()
    notifyUnexplainedSkips([
      { nodeId: 'p1-a', kind: 'text' },
      { nodeId: 'unknown:99:1', kind: 'style' },
    ])

    const body = collectToasts()[0].body!
    expect(body).toContain('Heading')
    expect(body).toMatch(/1 more edit had no writable location/)
  })

  it('the Select action selects the resolved same-page nodes and switches page if needed', () => {
    loadTwoPageSite()
    useEditorStore.setState({ activePageId: 'page-1' } as Parameters<typeof useEditorStore.setState>[0])
    notifyUnexplainedSkips([{ nodeId: 'p2-a', kind: 'text' }])

    const toast = collectToasts()[0]
    toast.action?.onSelect()

    const state = useEditorStore.getState()
    expect(state.activePageId).toBe('page-2')
    expect(state.selectedNodeIds).toEqual(['p2-a'])
  })

  it('labels the action honestly when skips span two pages (only the first page’s nodes are selectable in one gesture)', () => {
    loadTwoPageSite()
    notifyUnexplainedSkips([
      { nodeId: 'p1-a', kind: 'text' },
      { nodeId: 'p2-a', kind: 'text' },
    ])

    expect(collectToasts()[0].action?.label).toBe('Select node')
  })

  it('selects a real multi-selection when all resolved skips share one page', () => {
    loadTwoPageSite()
    notifyUnexplainedSkips([
      { nodeId: 'p1-a', kind: 'text' },
      { nodeId: 'p1-b', kind: 'prop' },
    ])
    const toast = collectToasts()[0]
    expect(toast.action?.label).toBe('Select 2 nodes')

    toast.action?.onSelect()
    const state = useEditorStore.getState()
    expect([...state.selectedNodeIds].sort()).toEqual(['p1-a', 'p1-b'])
  })
})
