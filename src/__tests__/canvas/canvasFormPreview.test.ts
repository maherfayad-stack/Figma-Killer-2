/**
 * canvasFormPreview — nearest-form resolution + parent-index caching.
 *
 * Both form-preview selectors run for every `base.form-message` node on every
 * store set in every breakpoint frame, so the parent index must be built at
 * most once per `page.nodes` identity (Mutative structural sharing mints a
 * new identity exactly when the tree changes).
 */

import { describe, it, expect } from 'bun:test'
import type { PageNode } from '@core/page-tree'
import {
  nearestFormNode,
  resolveEditorFormPreviewState,
  resolveEditorFormPreviewSuccessMessage,
} from '@site/canvas/canvasFormPreview'
import type { EditorStore } from '@site/store/store'

function node(id: string, moduleId: string, children: string[] = []): PageNode {
  return {
    id,
    moduleId,
    props: {},
    breakpointOverrides: {},
    children,
  } as unknown as PageNode
}

function makeNodes(): Record<string, PageNode> {
  return {
    root: node('root', 'base.body', ['form', 'aside']),
    form: node('form', 'base.form', ['fieldset']),
    fieldset: node('fieldset', 'base.container', ['message']),
    message: node('message', 'base.form-message'),
    aside: node('aside', 'base.container', ['orphanMessage']),
    orphanMessage: node('orphanMessage', 'base.form-message'),
  }
}

/** Wrap a nodes map so `Object.values` walks (ownKeys) are countable. */
function countingNodes(nodes: Record<string, PageNode>) {
  let ownKeysCalls = 0
  const proxied = new Proxy(nodes, {
    ownKeys(target) {
      ownKeysCalls++
      return Reflect.ownKeys(target)
    },
  })
  return { nodes: proxied, ownKeysCalls: () => ownKeysCalls }
}

describe('nearestFormNode', () => {
  it('finds the nearest enclosing base.form across intermediate containers', () => {
    const nodes = makeNodes()
    expect(nearestFormNode({ nodes }, 'message')?.id).toBe('form')
  })

  it('returns null when no enclosing form exists', () => {
    const nodes = makeNodes()
    expect(nearestFormNode({ nodes }, 'orphanMessage')).toBeNull()
    expect(nearestFormNode({ nodes }, 'root')).toBeNull()
  })

  it('builds the parent index once per nodes identity', () => {
    const counted = countingNodes(makeNodes())
    const page = { nodes: counted.nodes }

    nearestFormNode(page, 'message')
    const buildsAfterFirst = counted.ownKeysCalls()
    expect(buildsAfterFirst).toBeGreaterThan(0)

    // A selector sweep resolves every form-message node repeatedly with the
    // SAME tree identity — no further full-tree walks allowed.
    for (let i = 0; i < 50; i++) {
      nearestFormNode(page, 'message')
      nearestFormNode(page, 'orphanMessage')
    }
    expect(counted.ownKeysCalls()).toBe(buildsAfterFirst)
  })

  it('rebuilds the parent index when the nodes identity changes', () => {
    const first = countingNodes(makeNodes())
    nearestFormNode({ nodes: first.nodes }, 'message')
    const firstBuilds = first.ownKeysCalls()

    const second = countingNodes(makeNodes())
    expect(nearestFormNode({ nodes: second.nodes }, 'message')?.id).toBe('form')
    expect(second.ownKeysCalls()).toBe(firstBuilds)
  })
})

/**
 * The "no preview anywhere" short-circuit. Both resolvers run once per mounted
 * node per store commit, and on a board with no active form preview — which is
 * every board, almost all of the time — the answer is fixed. Resolving the
 * active canvas page and indexing into its node map to arrive at that fixed
 * answer, 2 × N times per commit, was pure waste.
 */
describe('form-preview resolvers with no preview active', () => {
  function stateWith(formPreviewStates: Record<string, string>, nodes: Record<string, PageNode>) {
    let pageReads = 0
    const page = { id: 'p1', title: 'p', slug: 'p', rootNodeId: 'root', nodes }
    const pages = new Proxy([page], {
      get(target, prop, receiver) {
        if (prop === 'find') pageReads++
        return Reflect.get(target, prop, receiver)
      },
    })
    const state = {
      site: { pages },
      activePageId: 'p1',
      activeDocument: null,
      formPreviewStates,
    } as unknown as EditorStore
    return { state, pageReads: () => pageReads }
  }

  it('never resolves the active page when formPreviewStates is empty', () => {
    const nodes = makeNodes()
    nodes.form!.props.successMessage = 'Custom thanks'
    const { state, pageReads } = stateWith({}, nodes)

    for (let i = 0; i < 100; i++) {
      expect(resolveEditorFormPreviewState(state, 'message')).toBe('default')
      expect(resolveEditorFormPreviewSuccessMessage(state, 'message')).toBe(
        'Thanks. Your submission was received.',
      )
    }
    expect(pageReads()).toBe(0)
  })

  it('still resolves normally once a form IS being previewed', () => {
    const nodes = makeNodes()
    nodes.form!.props.successMessage = 'Custom thanks'
    const { state } = stateWith({ form: 'success' }, nodes)

    expect(resolveEditorFormPreviewState(state, 'message')).toBe('success')
    expect(resolveEditorFormPreviewSuccessMessage(state, 'message')).toBe('Custom thanks')
    // A node outside the previewed form is unaffected.
    expect(resolveEditorFormPreviewState(state, 'orphanMessage')).toBe('default')
  })
})
