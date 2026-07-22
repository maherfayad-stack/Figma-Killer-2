/**
 * Dynamic-lock edit guards — `updateNodeProps` / `setNodeInlineStyles`
 * (nodeActions.ts) and `startInlineEdit` (inlineEditSlice.ts) must refuse to
 * mutate a node carrying a truthy `lockReason` (the page-parser's
 * source/dynamic lock), while leaving the manual "layer lock" (`locked`,
 * DnD-only) semantics untouched — a node with `locked: true` but no
 * `lockReason` must still be editable via these actions.
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import '@modules/base/index'

function freshStore() {
  useEditorStore.setState({
    site: null,
    activePageId: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    hoveredNodeId: null,
    activeDocument: null,
    activeInlineEdit: null,
    clipboardEntry: null,
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

function setup(moduleId = 'base.container', defaults: Record<string, unknown> = {}): string {
  const site = useEditorStore.getState().createSite('Lock Guard Site')
  const rootId = site.pages[0].rootNodeId
  return useEditorStore.getState().insertNode(moduleId, defaults, rootId)
}

function getNode(nodeId: string) {
  return useEditorStore.getState().site!.pages[0].nodes[nodeId]!
}

function setLockReason(nodeId: string, lockReason: string | undefined): void {
  useEditorStore.setState((s) => {
    const node = s.site!.pages[0]!.nodes[nodeId]!
    if (lockReason === undefined) delete node.lockReason
    else node.lockReason = lockReason
  })
}

function setLocked(nodeId: string, locked: boolean): void {
  useEditorStore.setState((s) => {
    s.site!.pages[0]!.nodes[nodeId]!.locked = locked
  })
}

describe('updateNodeProps — source-lock guard', () => {
  it('no-ops on a node with a truthy lockReason', () => {
    const id = setup()
    const tagBefore = getNode(id).props.tag
    setLockReason(id, 'rendered inside a .map(...) callback')
    const historyBefore = useEditorStore.getState()._historyPast.length

    useEditorStore.getState().updateNodeProps(id, { tag: 'section' })

    expect(getNode(id).props.tag).toBe(tagBefore)
    expect(useEditorStore.getState()._historyPast.length).toBe(historyBefore)
  })

  it('still mutates a normal node (no lockReason)', () => {
    const id = setup()
    useEditorStore.getState().updateNodeProps(id, { tag: 'section' })
    expect(getNode(id).props.tag).toBe('section')
  })

  it('still mutates a node with the manual layer lock (`locked: true`, no lockReason)', () => {
    const id = setup()
    setLocked(id, true)
    useEditorStore.getState().updateNodeProps(id, { tag: 'section' })
    expect(getNode(id).props.tag).toBe('section')
  })
})

describe('setNodeInlineStyles — source-lock guard', () => {
  it('no-ops on a node with a truthy lockReason', () => {
    const id = setup()
    setLockReason(id, 'rendered inside a .map(...) callback')
    const historyBefore = useEditorStore.getState()._historyPast.length

    useEditorStore.getState().setNodeInlineStyles(id, { color: 'red' })

    expect(getNode(id).inlineStyles).toBeUndefined()
    expect(useEditorStore.getState()._historyPast.length).toBe(historyBefore)
  })

  it('still mutates a normal node (no lockReason)', () => {
    const id = setup()
    useEditorStore.getState().setNodeInlineStyles(id, { color: 'red' })
    expect(getNode(id).inlineStyles).toEqual({ color: 'red' })
  })

  it('still mutates a node with the manual layer lock (`locked: true`, no lockReason)', () => {
    const id = setup()
    setLocked(id, true)
    useEditorStore.getState().setNodeInlineStyles(id, { color: 'red' })
    expect(getNode(id).inlineStyles).toEqual({ color: 'red' })
  })
})

describe('startInlineEdit — source-lock guard', () => {
  it('refuses to start a session on a node with a truthy lockReason', () => {
    const id = setup('base.text', { text: 'Hello' })
    setLockReason(id, 'rendered inside a .map(...) callback')

    useEditorStore.getState().startInlineEdit(id, 'bp-desktop')

    expect(useEditorStore.getState().activeInlineEdit).toBeNull()
  })

  it('still starts a session on a normal node (no lockReason)', () => {
    const id = setup('base.text', { text: 'Hello' })
    useEditorStore.getState().startInlineEdit(id, 'bp-desktop')
    expect(useEditorStore.getState().activeInlineEdit?.nodeId).toBe(id)
  })

  it('still starts a session on a node with the manual layer lock (`locked: true`, no lockReason)', () => {
    const id = setup('base.text', { text: 'Hello' })
    setLocked(id, true)
    useEditorStore.getState().startInlineEdit(id, 'bp-desktop')
    expect(useEditorStore.getState().activeInlineEdit?.nodeId).toBe(id)
  })
})
