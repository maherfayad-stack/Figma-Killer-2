import { describe, it, expect, beforeEach } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import { makeNode, makePage, makeSite } from '../fixtures'

function freshStore() {
  useEditorStore.setState({
    site: null,
    activePageId: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    hoveredNodeId: null,
    activeClassId: null,
    previewClassAssignment: null,
    propertiesPanel: { collapsed: false, x: 0, y: 0, width: 280 },
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
    hasUnsavedChanges: false,
  } as Parameters<typeof useEditorStore.setState>[0])
}

beforeEach(freshStore)

describe('selectionSlice.selectNode', () => {
  it('activates the first assigned class when selecting a node with classes', () => {
    const store = useEditorStore.getState()
    const site = store.createSite('Selection Test')
    const rootId = site.pages[0].rootNodeId
    const nodeId = useEditorStore.getState().insertNode('base.text', {}, rootId)
    const cls = useEditorStore.getState().createClass('hero-title')
    useEditorStore.getState().addNodeClass(nodeId, cls.id)

    useEditorStore.getState().selectNode(nodeId)

    expect(useEditorStore.getState().activeClassId).toBe(cls.id)
  })
})

// ---------------------------------------------------------------------------
// findSelectableNode — `STUDIO-FIGMA-PARITY-PLAN.md` C4 / audit E10.
// Used to be an O(pages) `for (const page of state.site.pages)` scan; now
// reads the `_nodeIdToPageIds` index (WS-5.2), mirroring
// `canvas/InPlaceInspector/findNodeById.ts`'s "prefer the active page for a
// node id shared across pages" tie-break.
// ---------------------------------------------------------------------------

describe('selectionSlice — findSelectableNode resolves a shared node id via the ACTIVE page', () => {
  it('prefers the active page copy over the first-in-array-order page when a node id is shared', () => {
    // Simulates a composed Next.js `layout.tsx` node — one id, present as a
    // DIFFERENT node object (different classIds) on two pages.
    const pageA = makePage({
      id: 'page-a',
      rootNodeId: 'root-a',
      nodes: {
        'root-a': makeNode({ id: 'root-a', moduleId: 'base.body', children: ['shared-node'] }),
        'shared-node': makeNode({ id: 'shared-node', moduleId: 'base.text', classIds: ['class-a'] }),
      },
    })
    const pageB = makePage({
      id: 'page-b',
      rootNodeId: 'root-b',
      nodes: {
        'root-b': makeNode({ id: 'root-b', moduleId: 'base.body', children: ['shared-node'] }),
        'shared-node': makeNode({ id: 'shared-node', moduleId: 'base.text', classIds: ['class-b'] }),
      },
    })
    const site = makeSite({
      pages: [pageA, pageB],
      styleRules: {
        'class-a': { id: 'class-a', name: 'a', kind: 'class', styles: {}, contextStyles: {} } as never,
        'class-b': { id: 'class-b', name: 'b', kind: 'class', styles: {}, contextStyles: {} } as never,
      },
    })
    useEditorStore.getState().loadSite(site)
    useEditorStore.getState().setActivePage('page-b')

    useEditorStore.getState().selectNode('shared-node')

    // Resolves 'class-b' (page-b's copy, the ACTIVE page) — proving the
    // lookup didn't just take whichever page happened to be first in
    // `site.pages` (which would have returned 'class-a').
    expect(useEditorStore.getState().activeClassId).toBe('class-b')
  })
})
