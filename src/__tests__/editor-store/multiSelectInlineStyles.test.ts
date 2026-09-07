/**
 * setNodesInlineStyles — W8-3 phase 1's bulk inline-style write.
 *
 * Covers:
 *   1. One patch reaches every id in the selection.
 *   2. The whole fan-out is ONE undo step (a single `undo()` restores every
 *      node), which is the property that makes an N-node inspector edit feel
 *      like an edit rather than N edits.
 *   3. Clearing semantics match the single-node action: `null` removes the
 *      property, and a bag that empties drops `inlineStyles` entirely.
 *   4. A stale id in the selection is skipped instead of aborting the write
 *      for everyone else.
 *   5. A no-op patch (every node already holds the value) records no history.
 */

import { describe, it, expect, beforeEach } from 'bun:test'
import { useEditorStore } from '@site/store/store'
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

/** Create a page with `count` text nodes and return their ids. */
function seedNodes(count: number): string[] {
  const site = useEditorStore.getState().createSite('Bulk')
  const root = site.pages[0].rootNodeId
  return Array.from({ length: count }, () =>
    useEditorStore.getState().insertNode('base.text', {}, root),
  )
}

function inlineStylesOf(nodeId: string): Record<string, unknown> | undefined {
  return useEditorStore.getState().site!.pages[0].nodes[nodeId]?.inlineStyles
}

describe('setNodesInlineStyles', () => {
  it('applies one patch to every selected node', () => {
    const ids = seedNodes(3)

    useEditorStore.getState().setNodesInlineStyles(ids, { color: 'red' })

    for (const id of ids) {
      expect(inlineStylesOf(id)).toEqual({ color: 'red' })
    }
  })

  it('is ONE undo step for the whole selection', () => {
    const ids = seedNodes(3)
    const historyBefore = useEditorStore.getState()._historyPast.length

    useEditorStore.getState().setNodesInlineStyles(ids, { color: 'red' })

    expect(useEditorStore.getState()._historyPast.length).toBe(historyBefore + 1)

    useEditorStore.getState().undo()

    for (const id of ids) {
      expect(inlineStylesOf(id)?.color).toBeUndefined()
    }
  })

  it('overwrites differing values so the selection ends up agreeing', () => {
    const [a, b] = seedNodes(2)
    useEditorStore.getState().setNodeInlineStyles(a, { textAlign: 'left' })
    useEditorStore.getState().setNodeInlineStyles(b, { textAlign: 'right' })

    useEditorStore.getState().setNodesInlineStyles([a, b], { textAlign: 'center' })

    expect(inlineStylesOf(a)).toEqual({ textAlign: 'center' })
    expect(inlineStylesOf(b)).toEqual({ textAlign: 'center' })
  })

  it('clears a property across the selection and drops an emptied bag', () => {
    const ids = seedNodes(2)
    useEditorStore.getState().setNodesInlineStyles(ids, { color: 'red' })

    useEditorStore.getState().setNodesInlineStyles(ids, { color: null })

    for (const id of ids) {
      // The whole field goes away — the publisher must emit no `style` at all.
      expect(inlineStylesOf(id)).toBeUndefined()
    }
  })

  it('keeps the other properties when clearing one', () => {
    const ids = seedNodes(2)
    useEditorStore.getState().setNodesInlineStyles(ids, { color: 'red', display: 'flex' })

    useEditorStore.getState().setNodesInlineStyles(ids, { color: null })

    for (const id of ids) {
      expect(inlineStylesOf(id)).toEqual({ display: 'flex' })
    }
  })

  it('skips a stale id instead of aborting the write for the rest', () => {
    const ids = seedNodes(2)

    useEditorStore
      .getState()
      .setNodesInlineStyles([...ids, 'node-that-no-longer-exists'], { color: 'red' })

    for (const id of ids) {
      expect(inlineStylesOf(id)).toEqual({ color: 'red' })
    }
  })

  it('records no history for a patch that changes nothing', () => {
    const ids = seedNodes(2)
    useEditorStore.getState().setNodesInlineStyles(ids, { color: 'red' })
    const historyBefore = useEditorStore.getState()._historyPast.length

    useEditorStore.getState().setNodesInlineStyles(ids, { color: 'red' })

    expect(useEditorStore.getState()._historyPast.length).toBe(historyBefore)
  })

  it('does nothing for an empty selection', () => {
    seedNodes(1)
    const historyBefore = useEditorStore.getState()._historyPast.length

    useEditorStore.getState().setNodesInlineStyles([], { color: 'red' })

    expect(useEditorStore.getState()._historyPast.length).toBe(historyBefore)
  })
})

/**
 * setNodesInlineStylesPerNode — the per-node sibling (W8-3 phase 3 / G6.4).
 *
 * Selection colours is what needs a DIFFERENT patch per node: the same swatch
 * can be `color` on one layer and `borderTopColor` on another. The undo
 * contract is the one that matters — recolouring is one entry, or a Ctrl+Z
 * hands the user back half a colour.
 */
describe('setNodesInlineStylesPerNode', () => {
  it('writes each node its own patch', () => {
    const [a, b] = seedNodes(2)

    useEditorStore.getState().setNodesInlineStylesPerNode([
      { nodeId: a, patch: { color: '#222' } },
      { nodeId: b, patch: { borderTopColor: '#222' } },
    ])

    expect(inlineStylesOf(a)).toEqual({ color: '#222' })
    expect(inlineStylesOf(b)).toEqual({ borderTopColor: '#222' })
  })

  it('is ONE undo step across every node it touched', () => {
    const [a, b] = seedNodes(2)
    useEditorStore.getState().setNodeInlineStyles(a, { color: '#111' })
    useEditorStore.getState().setNodeInlineStyles(b, { borderTopColor: '#111' })

    useEditorStore.getState().setNodesInlineStylesPerNode([
      { nodeId: a, patch: { color: '#222' } },
      { nodeId: b, patch: { borderTopColor: '#222' } },
    ])
    useEditorStore.getState().undo()

    expect(inlineStylesOf(a)).toEqual({ color: '#111' })
    expect(inlineStylesOf(b)).toEqual({ borderTopColor: '#111' })
  })

  it('coalesces a burst on the same key into one entry, and starts a new one on a different key', () => {
    const [a] = seedNodes(1)
    useEditorStore.getState().setNodeInlineStyles(a, { color: '#111' })
    const before = useEditorStore.getState()._historyPast.length

    const write = (value: string, key: string) =>
      useEditorStore
        .getState()
        .setNodesInlineStylesPerNode([{ nodeId: a, patch: { color: value } }], {
          coalesceKey: key,
        })

    write('#222', 'selection-color:#111')
    write('#333', 'selection-color:#111')
    expect(useEditorStore.getState()._historyPast.length).toBe(before + 1)

    write('#444', 'selection-color:#333')
    expect(useEditorStore.getState()._historyPast.length).toBe(before + 2)
  })

  it('ignores a stale id rather than aborting the rest', () => {
    const [a] = seedNodes(1)

    useEditorStore.getState().setNodesInlineStylesPerNode([
      { nodeId: 'gone', patch: { color: '#222' } },
      { nodeId: a, patch: { color: '#222' } },
    ])

    expect(inlineStylesOf(a)).toEqual({ color: '#222' })
  })
})
