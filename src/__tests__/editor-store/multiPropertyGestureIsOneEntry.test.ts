/**
 * One inspector gesture costs one undo entry.
 *
 * `setNodeInlineStyles` has always taken a whole patch and run it through a
 * single `runHistoricMutation` transaction. The Properties panel was not using
 * that: every multi-property gesture (Width -> Fill writes `flex` and clears
 * `width`; the align 3x3 sets both axes; a layout mode switch sets `display`
 * and `flexDirection`) was committed through the per-property `onChange` in a
 * loop, so one click became 2-8 history entries and a single Ctrl+Z left the
 * element spliced between two states it was never in.
 *
 * The panel now commits those through one `onChangeMany` call. This pins the
 * store half of that contract: one patch in, one entry on the stack, and undo
 * restores every key together.
 */
import { describe, it, expect, beforeEach } from 'bun:test'
import { useEditorStore } from '@site/store/store'

beforeEach(() => {
  useEditorStore.setState({
    site: null,
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
    selectedNodeId: null,
    selectedNodeIds: [],
    hasUnsavedChanges: false,
  })
})

function seedNode(): string {
  const site = useEditorStore.getState().createSite('One gesture')
  const rootId = site.pages[0]!.rootNodeId
  return useEditorStore.getState().insertNode('base.container', {}, rootId)
}

describe('a multi-property inline-style patch', () => {
  it('is one history entry, and undo restores every key together', () => {
    const nodeId = seedNode()
    useEditorStore.getState().setNodeInlineStyles(nodeId, { width: '200px' })

    const depthBefore = useEditorStore.getState()._historyPast.length

    // The shape a Fill switch produces: set one property, clear another.
    useEditorStore.getState().setNodeInlineStyles(nodeId, { flex: '1 1 0', width: null })

    expect(useEditorStore.getState()._historyPast.length).toBe(depthBefore + 1)
    const after = useEditorStore.getState().site!.pages[0]!.nodes[nodeId]!
    expect(after.inlineStyles?.flex).toBe('1 1 0')
    expect(after.inlineStyles?.width).toBeUndefined()

    useEditorStore.getState().undo()

    const undone = useEditorStore.getState().site!.pages[0]!.nodes[nodeId]!
    expect(undone.inlineStyles?.width).toBe('200px')
    expect(undone.inlineStyles?.flex).toBeUndefined()
  })

  it('costs two entries when the same gesture is committed one property at a time', () => {
    // The defect, stated as a fact rather than left implicit: this is what the
    // panel used to do, and why one Ctrl+Z only half-reverted a mode switch.
    const nodeId = seedNode()
    useEditorStore.getState().setNodeInlineStyles(nodeId, { width: '200px' })
    const depthBefore = useEditorStore.getState()._historyPast.length

    useEditorStore.getState().setNodeInlineStyles(nodeId, { width: null })
    useEditorStore.getState().setNodeInlineStyles(nodeId, { flex: '1 1 0' })

    expect(useEditorStore.getState()._historyPast.length).toBe(depthBefore + 2)

    useEditorStore.getState().undo()
    const halfway = useEditorStore.getState().site!.pages[0]!.nodes[nodeId]!
    expect(halfway.inlineStyles?.flex).toBeUndefined()
    expect(halfway.inlineStyles?.width).toBeUndefined() // neither Fill nor 200px
  })
})
