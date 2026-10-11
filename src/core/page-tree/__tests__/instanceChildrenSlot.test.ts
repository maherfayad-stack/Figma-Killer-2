/**
 * OD-22 - where a drop into a component instance is written.
 *
 * `<Shell title="x"><p/><q/></Shell>` renders, on the board,
 *
 *   Shell (instance, plain id)            <- the call site
 *     section (inlined, composite id)
 *       h1                                <- the component's own
 *       div.body (inlined)                <- `childrenHost`
 *         p, q                            <- the CALL SITE's children (plain ids)
 *       footer                            <- the component's own
 *
 * A drop into `div.body` is written between the `<Shell>` tags: the container
 * is the call site, the anchor is one of its own children, and the component's
 * elements are never an anchor - the call site cannot name them. A drop into a
 * component that renders no children has no such place, so it is refused as the
 * instance's own markup, about the instance, and the store detaches it.
 */
import { describe, expect, it } from 'bun:test'
import {
  instanceChildrenSlot,
  previewStructuralMove,
  resolveWriteContainer,
  type NodeTree,
  type PageNode,
} from '@core/page-tree'
import { makeNode, makePage } from '../../../__tests__/fixtures'

const FILE = 'pages/Bake.tsx'
const SHELL = `${FILE}:5:7`
const inShell = (line: number, col = 9) => `${SHELL}~components/Shell.tsx:${line}:${col}`
const SECTION = inShell(3)
const H1 = inShell(4)
const BODY = inShell(5)
const FOOT = inShell(6)
const P = `${FILE}:6:9`
const Q = `${FILE}:7:9`
const TIP = `${FILE}:9:7`
const MAIN = `${FILE}:4:5`

function build(options: { host?: boolean } = {}): NodeTree<PageNode> {
  const host = options.host ?? true
  const nodes: PageNode[] = [
    makeNode({ id: 'bake:body', moduleId: 'base.body', children: [MAIN] }),
    makeNode({ id: MAIN, moduleId: 'base.container', children: [SHELL, TIP], parentId: 'bake:body' }),
    makeNode({
      id: SHELL,
      moduleId: 'studio.instance',
      children: [SECTION],
      parentId: MAIN,
      props: { componentName: 'Shell', source: 'local', sourceFile: 'components/Shell.tsx', callSiteProps: {}, ...(host ? { childrenHost: BODY } : {}) },
    }),
    makeNode({ id: SECTION, moduleId: 'base.container', children: [H1, BODY, FOOT], parentId: SHELL }),
    makeNode({ id: H1, moduleId: 'base.text', parentId: SECTION }),
    makeNode({ id: BODY, moduleId: 'base.container', children: [P, Q], parentId: SECTION }),
    makeNode({ id: FOOT, moduleId: 'base.text', parentId: SECTION }),
    makeNode({ id: P, moduleId: 'base.text', parentId: BODY }),
    makeNode({ id: Q, moduleId: 'base.text', parentId: BODY }),
    makeNode({ id: TIP, moduleId: 'base.text', parentId: MAIN }),
  ]
  return makePage({ id: 'bake', rootNodeId: 'bake:body', nodes: Object.fromEntries(nodes.map((node) => [node.id, node])) }) as unknown as NodeTree<PageNode>
}

describe('instanceChildrenSlot', () => {
  it('finds the slot from the host element and from the instance itself', () => {
    const tree = build()
    expect(instanceChildrenSlot(tree, BODY)?.instance.id).toBe(SHELL)
    expect(instanceChildrenSlot(tree, SHELL)?.host.id).toBe(BODY)
  })

  it('finds nothing for an ordinary container, another element of the component, or an instance with no host', () => {
    const tree = build()
    expect(instanceChildrenSlot(tree, MAIN)).toBeNull()
    expect(instanceChildrenSlot(tree, SECTION)).toBeNull()
    expect(instanceChildrenSlot(build({ host: false }), SHELL)).toBeNull()
  })
})

describe('resolveWriteContainer', () => {
  it('writes into the call site and counts the host\'s own children', () => {
    const container = resolveWriteContainer(build(), BODY)
    expect(container.ok && container.node.id).toBe(SHELL)
    expect(container.ok && container.anchorOwner.id).toBe(BODY)
    expect(container.ok && container.slot).toBe(true)
    expect(container.ok && container.emptyAtCallSite).toBe(false)
  })

  it('leaves an ordinary container exactly as it was', () => {
    const container = resolveWriteContainer(build(), MAIN)
    expect(container.ok && container.node.id).toBe(MAIN)
    expect(container.ok && container.slot).toBe(false)
  })

  it('refuses a drop onto a component that renders no children, about the instance', () => {
    const container = resolveWriteContainer(build({ host: false }), SHELL)
    expect(container.ok).toBe(false)
    if (container.ok) return
    expect(container.refusal.reason).toBe('shared-component')
    expect(container.refusal.aboutNodeId).toBe(SHELL)
    expect(container.refusal.message).toContain('Shell does not render children')
  })
})

describe('previewStructuralMove into a children slot', () => {
  it('lands between the call site\'s own children: written at the call site, beside the child the drop line is next to', () => {
    // Between P and Q inside the host: index 1 of the host's children.
    const preview = previewStructuralMove(build(), [TIP], BODY, 1)
    expect(preview).toEqual({
      ok: true,
      commit: { nodeId: TIP, destinationParentNodeId: SHELL, anchorNodeId: P, position: 'after' },
    })
  })

  it('appends (no anchor) when the drop is past the last child', () => {
    const preview = previewStructuralMove(build(), [TIP], BODY, 2)
    expect(preview).toEqual({
      ok: true,
      commit: { nodeId: TIP, destinationParentNodeId: SHELL, anchorNodeId: null, position: 'after' },
    })
  })

  it('a drop onto the instance itself appends to its children', () => {
    const preview = previewStructuralMove(build(), [TIP], SHELL, 0)
    expect(preview).toEqual({
      ok: true,
      commit: { nodeId: TIP, destinationParentNodeId: SHELL, anchorNodeId: null, position: 'after' },
    })
  })

  it('refuses a drop onto a component without children as shared-component, about the instance - the store detaches it', () => {
    const preview = previewStructuralMove(build({ host: false }), [TIP], SHELL, 0)
    expect(preview.ok).toBe(false)
    if (preview.ok) return
    expect(preview.refusal.reason).toBe('shared-component')
    expect(preview.refusal.aboutNodeId).toBe(SHELL)
  })

  it('a drop into the component\'s OTHER elements is the component\'s own markup: refused about that element', () => {
    const preview = previewStructuralMove(build(), [TIP], SECTION, 0)
    expect(preview.ok).toBe(false)
    if (preview.ok) return
    expect(preview.refusal.reason).toBe('shared-component')
    expect(preview.refusal.aboutNodeId).toBe(SECTION)
  })

  it('reordering a call-site child past the component\'s own element anchors to the nearest call-site child', () => {
    // Q moved to the front of the host's children is still "before P", never "before the component's h1".
    const preview = previewStructuralMove(build(), [Q], BODY, 0)
    expect(preview).toEqual({
      ok: true,
      commit: { nodeId: Q, anchorNodeId: P, position: 'before' },
    })
  })
})
