/**
 * PA-7 / PA-8 — the `convertLayout` store action: the container and every
 * child restyled in ONE undo step, undo restores the tree exactly, and a
 * reorder follows the visual order.
 */
import { describe, it, expect, beforeEach } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import { reorderMoves } from '@site/store/slices/site/layoutConversionActions'
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

/** root > frame (relative) > [a, b, c], each absolute: a free frame. */
function seedFreeFrame() {
  const store = useEditorStore.getState()
  const site = store.createSite('Convert')
  const frame = store.insertNode('base.container', {}, site.pages[0].rootNodeId)
  store.setNodeInlineStyles(frame, { position: 'relative', width: '400px', height: '200px' })
  const ids = [0, 1, 2].map((index) => {
    const id = store.insertNode('base.text', {}, frame)
    store.setNodeInlineStyles(id, { position: 'absolute', left: `${index * 100}px`, top: '10px' })
    return id
  })
  return { frame, ids: ids as [string, string, string] }
}

const page = () => useEditorStore.getState().site!.pages[0]
const inlineOf = (id: string) => page().nodes[id]?.inlineStyles
const undoDepth = () => useEditorStore.getState()._historyPast.length

describe('convertLayout', () => {
  it('Add auto layout: container and children in ONE undo step, and undo restores the tree exactly', () => {
    const { frame, ids } = seedFreeFrame()
    const before = JSON.stringify(page())
    const depth = undoDepth()

    const outcome = useEditorStore.getState().convertLayout({
      parentId: frame,
      parentPatch: { display: 'flex', flexDirection: 'row', gap: '16px' },
      childPatches: ids.map((nodeId) => ({ nodeId, patch: { position: null, left: null, top: null } })),
    })

    expect(outcome).toBe('applied')
    expect(undoDepth()).toBe(depth + 1)
    expect(inlineOf(frame)).toMatchObject({ position: 'relative', display: 'flex', flexDirection: 'row', gap: '16px' })
    for (const id of ids) expect(inlineOf(id)).toBeUndefined()

    useEditorStore.getState().undo()
    expect(JSON.stringify(page())).toBe(before)
  })

  it('Remove auto layout (keep positions) is one step and undoes exactly', () => {
    const store = useEditorStore.getState()
    const site = store.createSite('Freeze')
    const frame = store.insertNode('base.container', {}, site.pages[0].rootNodeId)
    store.setNodeInlineStyles(frame, { display: 'flex', gap: '8px' })
    const a = store.insertNode('base.text', {}, frame)
    const b = store.insertNode('base.text', {}, frame)
    const before = JSON.stringify(page())
    const depth = undoDepth()

    const outcome = useEditorStore.getState().convertLayout({
      parentId: frame,
      parentPatch: { display: null, gap: null, position: 'relative', height: '40px' },
      childPatches: [
        { nodeId: a, patch: { position: 'absolute', left: '0px', top: '0px', width: '80px', height: '40px' } },
        { nodeId: b, patch: { position: 'absolute', left: '88px', top: '0px', width: '80px', height: '40px' } },
      ],
    })

    expect(outcome).toBe('applied')
    expect(undoDepth()).toBe(depth + 1)
    expect(inlineOf(frame)).toEqual({ position: 'relative', height: '40px' })
    expect(inlineOf(b)).toMatchObject({ position: 'absolute', left: '88px' })
    useEditorStore.getState().undo()
    expect(JSON.stringify(page())).toBe(before)
  })

  it('a visual order that differs from the source order reorders the children', () => {
    const { frame, ids } = seedFreeFrame()
    const [a, b, c] = ids

    useEditorStore.getState().convertLayout({
      parentId: frame,
      parentPatch: { display: 'flex' },
      childPatches: [],
      order: [c, a, b],
    })

    expect(page().nodes[frame]!.children).toEqual([c, a, b])
    expect(inlineOf(frame)).toMatchObject({ display: 'flex' })
  })

  it('a request that changes nothing is a no-op and writes no history', () => {
    const { frame } = seedFreeFrame()
    const depth = undoDepth()
    expect(useEditorStore.getState().convertLayout({ parentId: frame, parentPatch: { position: 'relative' }, childPatches: [] })).toBe('noop')
    expect(undoDepth()).toBe(depth)
  })
})

describe('reorderMoves', () => {
  it('turns one order into another, each move against the order the one before leaves', () => {
    expect(reorderMoves('p', ['a', 'b', 'c'], ['c', 'a', 'b'])).toEqual([{ nodeId: 'c', parentId: 'p', index: 0 }])
    expect(reorderMoves('p', ['a', 'b', 'c'], ['c', 'b', 'a'])).toEqual([
      { nodeId: 'c', parentId: 'p', index: 0 },
      { nodeId: 'b', parentId: 'p', index: 1 },
    ])
    expect(reorderMoves('p', ['a', 'b'], ['a', 'b'])).toEqual([])
  })
})
