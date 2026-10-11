/**
 * frameChromeRects — where a node's selection chrome goes, from the frame's rect
 * index (SB-4). Replaces `fragmentNodeRect.test.ts` (instance-ui-01), which pinned
 * the same fallback against the frame's DOM: `studio.instance` (WS-4.2) renders a
 * bare React Fragment, so no `[data-node-id]` element exists for it, and once the
 * instance became what a canvas CLICK selects the chrome needed a box for a node
 * with no element at all. The index lists boxed nodes only, so the chrome falls
 * back to the shallowest listed descendants through the PAGE TREE.
 *
 * What is asserted is the descendant resolution - which boxes are chosen and when
 * the walk correctly declines. The pixel geometry of a real frame is a
 * layout-engine question (`standing-02`), covered by
 * `tests/e2e/instance-selection-ui.e2e.ts`.
 */
import { describe, expect, it } from 'bun:test'
import type { Page } from '@core/page-tree'
import { chromeRectOf } from '@site/canvas/frameChromeRects'
import { FrameGeometryIndex } from '@site/canvas/frameGeometry/frameGeometryIndex'
import type { NodeGeometry } from '@site/canvas/frameGeometry/frameGeometryTypes'
import { makeNode, makePage } from '../fixtures'

function listed(nodeId: string, x: number, y: number, width: number, height: number, parent = -1): NodeGeometry {
  return { nodeId, rect: { x, y, width, height }, parent, clips: false, inert: false, transformed: false, paint: 0 }
}

function indexOf(nodes: NodeGeometry[], origin = { x: 0, y: 0 }): FrameGeometryIndex {
  return FrameGeometryIndex.fromSnapshot({ origin, nodes, truncated: false }, { x: 500, y: 700 })
}

/**
 * root (base.body)
 *  └─ wrap (base.container)
 *      └─ inst (studio.instance) — zero DOM
 *          ├─ a (base.container)
 *          └─ b (base.container)
 */
function instanceTree(): Page {
  return makePage({
    id: 'page-1',
    rootNodeId: 'root',
    nodes: {
      root: makeNode({ id: 'root', moduleId: 'base.body', children: ['wrap'] }),
      wrap: makeNode({ id: 'wrap', moduleId: 'base.container', children: ['inst'], parentId: 'root' }),
      inst: makeNode({ id: 'inst', moduleId: 'studio.instance', children: ['a', 'b'], parentId: 'wrap' }),
      a: makeNode({ id: 'a', moduleId: 'base.container', children: [], parentId: 'inst' }),
      b: makeNode({ id: 'b', moduleId: 'base.container', children: [], parentId: 'inst' }),
    },
  })
}

describe('chromeRectOf', () => {
  it('is the listed box in the FRAME\'s viewport px, whatever the frame\'s place on the board', () => {
    const index = indexOf([listed('root', 0, 0, 400, 300), listed('wrap', 10, 20, 100, 50, 0)], { x: 8, y: 8 })
    // body margin (origin) is part of the viewport position; the board origin (500, 700) is not.
    expect(chromeRectOf(index, null, 'wrap')).toEqual({ x: 18, y: 28, width: 100, height: 50 })
  })

  it('a node with a box of its own never looks at its children', () => {
    const index = indexOf([listed('root', 0, 0, 400, 300), listed('wrap', 10, 20, 100, 50, 0), listed('a', 0, 0, 5, 5, 1)])
    expect(chromeRectOf(index, instanceTree(), 'wrap')).toEqual({ x: 10, y: 20, width: 100, height: 50 })
  })

  it('a zero-DOM fragment node spans the union of its shallowest rendered children', () => {
    const index = indexOf([
      listed('root', 0, 0, 400, 300),
      listed('wrap', 0, 0, 400, 100, 0),
      listed('a', 10, 20, 60, 30, 1),
      listed('b', 90, 40, 50, 60, 1),
    ])
    expect(chromeRectOf(index, instanceTree(), 'inst')).toEqual({ x: 10, y: 20, width: 130, height: 80 })
  })

  it('descends through a fragment nested in a fragment, and stops at the first box down each branch', () => {
    const tree = makePage({
      id: 'page-2',
      rootNodeId: 'root',
      nodes: {
        root: makeNode({ id: 'root', moduleId: 'base.body', children: ['outer'] }),
        outer: makeNode({ id: 'outer', moduleId: 'studio.instance', children: ['inner'], parentId: 'root' }),
        inner: makeNode({ id: 'inner', moduleId: 'studio.instance', children: ['leaf'], parentId: 'outer' }),
        leaf: makeNode({ id: 'leaf', moduleId: 'base.container', children: ['deep'], parentId: 'inner' }),
        deep: makeNode({ id: 'deep', moduleId: 'base.container', children: [], parentId: 'leaf' }),
      },
    })
    const index = indexOf([listed('root', 0, 0, 400, 300), listed('leaf', 12, 14, 80, 40, 0), listed('deep', 0, 0, 999, 999, 1)])
    // The rendered root of the component is measured, not every box inside it.
    expect(chromeRectOf(index, tree, 'outer')).toEqual({ x: 12, y: 14, width: 80, height: 40 })
  })

  it('declines when nothing down the tree is boxed in this frame, and without an index or a tree', () => {
    const index = indexOf([listed('root', 0, 0, 400, 300)])
    expect(chromeRectOf(index, instanceTree(), 'inst')).toBeNull()
    expect(chromeRectOf(index, null, 'inst')).toBeNull()
    expect(chromeRectOf(null, instanceTree(), 'inst')).toBeNull()
    expect(chromeRectOf(index, instanceTree(), 'not-a-node')).toBeNull()
  })
})
