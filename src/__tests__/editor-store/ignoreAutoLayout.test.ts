/**
 * Ignore auto layout (PA-4): the plan (which writes, which refusals) and the
 * store action (one undo step, bytes restored on the way back).
 *
 * The facts a browser would measure (offsets, whether the container already
 * contains an absolute child) arrive on the request, so every case here is a
 * claim about what lands in the user's tree.
 */
import { describe, it, expect, beforeEach } from 'bun:test'
import type { PageNode } from '@core/page-tree'
import { useEditorStore } from '@site/store/store'
import { planIgnoreAutoLayout, planReinstateAutoLayout } from '@site/store/slices/site/ignoreAutoLayoutPlan'
import '@modules/base/index'

function freshStore() {
  useEditorStore.setState({
    site: null,
    activePageId: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
    hasUnsavedChanges: false,
  } as Parameters<typeof useEditorStore.setState>[0])
}

beforeEach(freshStore)

/** root > container (flex) > [first, child, last] */
function seedFlexRow(): { container: string; first: string; child: string; last: string } {
  const store = useEditorStore.getState()
  const site = store.createSite('Ignore')
  const root = site.pages[0].rootNodeId
  const container = store.insertNode('base.container', {}, root)
  store.setNodeInlineStyles(container, { display: 'flex', gap: '8px' })
  const first = store.insertNode('base.text', {}, container)
  const child = store.insertNode('base.text', {}, container)
  const last = store.insertNode('base.text', {}, container)
  return { container, first, child, last }
}

const page = () => useEditorStore.getState().site!.pages[0]
const inlineOf = (id: string) => page().nodes[id]?.inlineStyles

describe('setIgnoreAutoLayout', () => {
  it('on: absolute child at its measured place, container made relative, ONE undo step', () => {
    const { container, child } = seedFlexRow()
    const before = useEditorStore.getState()._historyPast.length

    const outcome = useEditorStore.getState().setIgnoreAutoLayout(child, {
      ignore: true,
      parentContains: false,
      offsets: { left: 42, top: 7 },
    })

    expect(outcome).toBe('applied')
    expect(inlineOf(child)).toEqual({ position: 'absolute', left: '42px', top: '7px' })
    expect(inlineOf(container)).toEqual({ display: 'flex', gap: '8px', position: 'relative' })
    expect(useEditorStore.getState()._historyPast.length).toBe(before + 1)

    useEditorStore.getState().undo()
    expect(inlineOf(child)).toBeUndefined()
    expect(inlineOf(container)).toEqual({ display: 'flex', gap: '8px' })
  })

  it('on: leaves a container that already contains the child alone', () => {
    const { container, child } = seedFlexRow()
    useEditorStore.getState().setNodeInlineStyles(container, { position: 'relative' })

    useEditorStore.getState().setIgnoreAutoLayout(child, { ignore: true, parentContains: true, offsets: { left: 0, top: 0 } })

    expect(inlineOf(container)).toEqual({ display: 'flex', gap: '8px', position: 'relative' })
    expect(inlineOf(child)?.position).toBe('absolute')
  })

  it('on then off restores the tree byte for byte, and the child keeps its source index', () => {
    const { child } = seedFlexRow()
    const before = JSON.stringify(page())
    const order = [...page().nodes[page().nodes[child]!.parentId!]!.children]

    useEditorStore.getState().setIgnoreAutoLayout(child, { ignore: true, parentContains: false, offsets: { left: 5, top: 9 } })
    const off = useEditorStore.getState().setIgnoreAutoLayout(child, { ignore: false, releaseParent: true })

    expect(off).toBe('applied')
    expect(JSON.stringify(page())).toBe(before)
    expect(page().nodes[page().nodes[child]!.parentId!]!.children).toEqual(order)
  })

  it('off keeps a container position that something else still needs', () => {
    const { container, child } = seedFlexRow()
    useEditorStore.getState().setIgnoreAutoLayout(child, { ignore: true, parentContains: false, offsets: { left: 5, top: 9 } })

    useEditorStore.getState().setIgnoreAutoLayout(child, { ignore: false, releaseParent: false })

    expect(inlineOf(child)).toBeUndefined()
    expect(inlineOf(container)?.position).toBe('relative')
  })

  it('off on a layer whose position comes from a class refuses instead of pretending', () => {
    const { child } = seedFlexRow()

    const outcome = useEditorStore.getState().setIgnoreAutoLayout(child, { ignore: false, releaseParent: true })

    expect(outcome).toBe('refused')
    expect(inlineOf(child)).toBeUndefined()
  })
})

function node(id: string, inlineStyles?: Record<string, unknown>): PageNode {
  return { id, moduleId: 'base.container', props: {}, children: [], inlineStyles } as unknown as PageNode
}

describe('planIgnoreAutoLayout refusals (OD-P2)', () => {
  const child = node('src/Card.tsx:9:5')

  it('refuses a container shared by several places, naming how many, with the write as an explicit remedy', () => {
    const parent = node('src/Home.tsx:4:3~src/Card.tsx:2:3')
    const plan = planIgnoreAutoLayout({
      child,
      parent: { node: parent, sharedCount: 3 },
      parentContains: false,
      offsets: { left: 1, top: 2 },
    })
    if (plan.ok) throw new Error('expected a refusal')
    expect(plan.refusal.constraint.explanation).toContain('3 places')
    expect(plan.refusal.constraint.actions).toEqual([
      expect.objectContaining({ kind: 'position-parent-relative', label: expect.stringContaining('all 3') }),
    ])
    expect(plan.refusal.remedyNodeId).toBe(parent.id)
  })

  it('refuses a container that renders once per .map row', () => {
    const parent = node('src/List.tsx:12:5#2')
    const plan = planIgnoreAutoLayout({
      child,
      parent: { node: parent, sharedCount: 1 },
      parentContains: false,
      offsets: { left: 1, top: 2 },
    })
    if (plan.ok) throw new Error('expected a refusal')
    expect(plan.refusal.constraint.explanation).toContain('row')
    expect(plan.refusal.remedyNodeId).toBe(parent.id)
  })

  it('does not ask about the container at all when it already contains the child', () => {
    const parent = node('src/Home.tsx:4:3~src/Card.tsx:2:3')
    const plan = planIgnoreAutoLayout({
      child,
      parent: { node: parent, sharedCount: 3 },
      parentContains: true,
      offsets: { left: 1, top: 2 },
    })
    expect(plan.ok).toBe(true)
    if (plan.ok) expect(plan.writes.map((write) => write.nodeId)).toEqual([child.id])
  })

  it('refuses a position the source resolves from an expression, and writes nothing', () => {
    const codeChild = { ...child, codeProps: ['style:position'] } as PageNode
    const plan = planIgnoreAutoLayout({
      child: codeChild,
      parent: { node: node('src/Card.tsx:1:1'), sharedCount: 1 },
      parentContains: true,
      offsets: { left: 0, top: 0 },
    })
    expect(plan.ok).toBe(false)
  })
})

describe('planReinstateAutoLayout', () => {
  it('releases the container only when it is inline-relative, unshared, and nothing else needs it', () => {
    const child = node('src/Card.tsx:9:5', { position: 'absolute', left: '4px', top: '4px' })
    const relativeParent = node('src/Card.tsx:1:1', { position: 'relative' })
    const written = (parent: PageNode, sharedCount: number, releaseParent: boolean) => {
      const plan = planReinstateAutoLayout({ child, parent: { node: parent, sharedCount }, releaseParent })
      if (!plan.ok) throw new Error('unexpected refusal')
      return plan.writes.map((write) => write.nodeId)
    }

    expect(written(relativeParent, 1, true)).toEqual([child.id, relativeParent.id])
    expect(written(relativeParent, 1, false)).toEqual([child.id])
    expect(written(relativeParent, 2, true)).toEqual([child.id])
    expect(written(node('src/Card.tsx:1:1', { position: 'absolute' }), 1, true)).toEqual([child.id])
  })
})
