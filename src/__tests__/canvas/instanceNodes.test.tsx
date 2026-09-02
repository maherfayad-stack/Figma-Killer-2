/**
 * instanceNodes.test.tsx — WS-4.2. A `studio.instance` node (the fragment
 * model `inlineLocalComponents.ts` produces for an expanded local component
 * call site) renders ZERO DOM elements of its own: `NodeRenderer` mounts its
 * `component` (`InstanceEditor`) exactly like any other module, and that
 * component returns a bare `<>{children}</>` React Fragment.
 *
 * This is the regression the whole WS-4.2 design exists to prevent — see
 * `src/core/page-parser/inlineLocalComponents.ts`'s module header: a stray
 * wrapper element between an instance's parent and its own children would
 * break `%`/flex height chains and direct-child/sibling CSS combinators the
 * same way the OLD "wrap, don't splice" design did before §2's fix. A real
 * `%`-height chain resolving through layout is a browser/Playwright
 * question (happy-dom has no layout engine — `standing-02`); this suite
 * proves the DOM-SHAPE half, which happy-dom answers correctly.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, render } from '@testing-library/react'
import { DndContext } from '@dnd-kit/core'
import { useEditorStore } from '@site/store/store'
import { CanvasRoot } from '@site/canvas/CanvasRoot'
import { makeNode, makePage, makeSite } from '../fixtures'
import { queryCanvasElement, waitForCanvasElement } from './iframeCanvasQuery'
import '@modules/base'

function renderCanvas() {
  return render(
    <DndContext>
      <CanvasRoot />
    </DndContext>,
  )
}

/**
 * root (base.body)
 *  └─ wrap (base.container, id "wrap")
 *      └─ inst (studio.instance, id "inst1") — zero DOM
 *          └─ inner (base.container, id "inner")
 */
function setupInstancePage() {
  const root = makeNode({ id: 'root', moduleId: 'base.body', children: ['wrap'] })
  const wrap = makeNode({ id: 'wrap', moduleId: 'base.container', children: ['inst1'] })
  const inst = makeNode({
    id: 'inst1',
    moduleId: 'studio.instance',
    children: ['inner'],
    props: { componentName: 'Card', source: 'local', sourceFile: 'components/Card.tsx', callSiteProps: {} },
  })
  const inner = makeNode({ id: 'inner', moduleId: 'base.container', children: [] })

  const page = makePage({
    id: 'page-1',
    rootNodeId: 'root',
    nodes: { root, wrap, inst1: inst, inner },
  })

  useEditorStore.setState({
    site: makeSite({ pages: [page] }),
    activePageId: 'page-1',
    activeDocument: null,
    activeBreakpointId: 'mobile',
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
})

afterEach(cleanup)

describe('studio.instance — zero-DOM fragment node', () => {
  it('renders no element of its own — no [data-node-id="inst1"] exists on canvas', async () => {
    setupInstancePage()
    renderCanvas()

    // Wait for the subtree to actually mount (the instance's own child).
    await waitForCanvasElement('[data-node-id="inner"]')

    expect(queryCanvasElement('[data-node-id="inst1"]')).toBeNull()
  })

  it('its child is a DIRECT DOM child of the instance\'s own parent — no wrapper element in between', async () => {
    setupInstancePage()
    renderCanvas()

    const innerEl = await waitForCanvasElement('[data-node-id="inner"]')
    const wrapEl = queryCanvasElement('[data-node-id="wrap"]')
    expect(wrapEl).not.toBeNull()

    // If the instance rendered ANY element (even a `display:contents` one),
    // `innerEl.parentElement` would be that element, not `wrapEl` directly.
    expect(innerEl.parentElement).toBe(wrapEl)
  })
})
