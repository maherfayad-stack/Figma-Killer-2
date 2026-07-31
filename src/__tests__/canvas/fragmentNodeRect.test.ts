/**
 * fragmentNodeRect.test.ts — instance-ui-01.
 *
 * `studio.instance` (WS-4.2) renders a bare React Fragment, so no
 * `[data-node-id]` element exists for it (proved by `instanceNodes.test.tsx`).
 * Once instance-ui-01 made the instance the thing a canvas CLICK selects, that
 * became a user-visible hole: the overlay resolves every ring through
 * `[data-node-id="…"]`, found nothing, and drew no ring at all for the node the
 * user had just clicked.
 *
 * `fragmentNodeRectSource` closes it by spanning the node's shallowest RENDERED
 * descendants. What is asserted here is the DESCENDANT-RESOLUTION half — which
 * elements are chosen, and when the walk correctly declines. The pixel geometry
 * is a real-layout question happy-dom cannot answer at all (`standing-02`), and
 * is covered by `tests/e2e/instance-selection-ui.e2e.ts` instead; rects are
 * stubbed here so the union arithmetic is still exercised deterministically.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import type { NodeTree, PageNode } from '@core/page-tree'
import { fragmentNodeRectSource } from '@site/canvas/canvasNodeLookup'
import { makeNode, makePage } from '../fixtures'

/** Give an element a fixed layout box (happy-dom reports all-zero otherwise). */
function stubRect(element: Element, left: number, top: number, width: number, height: number): void {
  element.getBoundingClientRect = () => ({
    left, top, width, height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  }) as DOMRect
}

function makeElement(nodeId: string): HTMLElement {
  const el = document.createElement('div')
  el.setAttribute('data-node-id', nodeId)
  return el
}

/**
 * root (base.body)
 *  └─ wrap (base.container)
 *      └─ inst (studio.instance) — zero DOM
 *          ├─ a (base.container)
 *          └─ b (base.container)
 */
function makeInstanceTree(): NodeTree<PageNode> {
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

afterEach(() => {
  document.body.innerHTML = ''
  document.body.removeAttribute('data-node-id')
})

describe('fragmentNodeRectSource — measuring a node that rendered no element', () => {
  it('spans the union of the instance\'s rendered children', () => {
    document.body.setAttribute('data-node-id', 'root')
    const a = makeElement('a')
    const b = makeElement('b')
    document.body.append(a, b)
    stubRect(a, 10, 20, 100, 30) // → right 110, bottom 50
    stubRect(b, 40, 10, 100, 15) // → right 140, bottom 25

    const source = fragmentNodeRectSource(document, makeInstanceTree(), 'inst')
    expect(source).not.toBeNull()

    const rect = source!.getBoundingClientRect()
    expect(rect.left).toBe(10)
    expect(rect.top).toBe(10)
    expect(rect.right).toBe(140)
    expect(rect.bottom).toBe(50)
    expect(rect.width).toBe(130)
    expect(rect.height).toBe(40)
  })

  it('re-reads the DOM on every call, so the ring follows a reflow', () => {
    document.body.setAttribute('data-node-id', 'root')
    const a = makeElement('a')
    document.body.append(a)
    stubRect(a, 0, 0, 50, 50)

    const source = fragmentNodeRectSource(document, makeInstanceTree(), 'inst')!
    expect(source.getBoundingClientRect().width).toBe(50)

    // The element grows (content reflow). A source that had CAPTURED its rect
    // would keep reporting the stale box and the ring would lag behind.
    stubRect(a, 0, 0, 200, 50)
    expect(source.getBoundingClientRect().width).toBe(200)
  })

  it('descends THROUGH a nested fragment node to the first element below it', () => {
    const tree = makePage({
      id: 'page-1',
      rootNodeId: 'root',
      nodes: {
        root: makeNode({ id: 'root', moduleId: 'base.body', children: ['outer'] }),
        outer: makeNode({ id: 'outer', moduleId: 'studio.instance', children: ['inner'], parentId: 'root' }),
        inner: makeNode({ id: 'inner', moduleId: 'studio.instance', children: ['leaf'], parentId: 'outer' }),
        leaf: makeNode({ id: 'leaf', moduleId: 'base.container', children: [], parentId: 'inner' }),
      },
    })
    document.body.setAttribute('data-node-id', 'root')
    const leaf = makeElement('leaf')
    document.body.append(leaf)
    stubRect(leaf, 5, 5, 60, 70)

    const rect = fragmentNodeRectSource(document, tree, 'outer')!.getBoundingClientRect()
    expect(rect.left).toBe(5)
    expect(rect.width).toBe(60)
    expect(rect.height).toBe(70)
  })

  it('stops at a rendered descendant instead of descending past it', () => {
    const tree = makePage({
      id: 'page-1',
      rootNodeId: 'root',
      nodes: {
        root: makeNode({ id: 'root', moduleId: 'base.body', children: ['inst'] }),
        inst: makeNode({ id: 'inst', moduleId: 'studio.instance', children: ['a'], parentId: 'root' }),
        a: makeNode({ id: 'a', moduleId: 'base.container', children: ['deep'], parentId: 'inst' }),
        deep: makeNode({ id: 'deep', moduleId: 'base.container', children: [], parentId: 'a' }),
      },
    })
    document.body.setAttribute('data-node-id', 'root')
    const a = makeElement('a')
    const deep = makeElement('deep')
    a.append(deep)
    document.body.append(a)
    // `a` is the component's own rendered root — its box is what the instance
    // occupies. `deep` is a smaller box inside it and must not become the
    // measurement, which is what a "find any rendered descendant" walk would do.
    stubRect(a, 0, 0, 300, 200)
    stubRect(deep, 10, 10, 20, 20)

    const rect = fragmentNodeRectSource(document, tree, 'inst')!.getBoundingClientRect()
    expect(rect.width).toBe(300)
    expect(rect.height).toBe(200)
  })

  it('declines when this frame does not render the tree at all', () => {
    // No `[data-node-id="root"]` in the document — the O(1) ownership guard
    // that stops every non-owning board frame from walking the subtree on
    // every RAF tick.
    const a = makeElement('a')
    document.body.append(a)
    stubRect(a, 0, 0, 10, 10)

    expect(fragmentNodeRectSource(document, makeInstanceTree(), 'inst')).toBeNull()
  })

  it('declines when the instance has no rendered descendant', () => {
    document.body.setAttribute('data-node-id', 'root')
    expect(fragmentNodeRectSource(document, makeInstanceTree(), 'inst')).toBeNull()
  })
})
