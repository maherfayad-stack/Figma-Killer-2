/**
 * Value edit guards — `updateNodeProps` / `setNodeInlineStyles` (nodeActions.ts)
 * and `startInlineEdit` (inlineEditSlice.ts).
 *
 * They gate on `PageNode.codeProps` — the props with no writable source target —
 * and NOT on `lockReason`. `lockReason` describes the node's STRUCTURE (a `.map`
 * generated it, a spread feeds it) and a structurally locked element's literal
 * attributes are still ordinary literals at a known line and column. Gating
 * values on it refused every prop on 42% of an imported board's nodes while the
 * panel went on showing editable-looking inputs.
 *
 * Since `lock-01` the two facts are fully separated in the other direction too:
 * a resolved VALUE (`title={c.label}`) records `codeProps` and no lock at all,
 * so the guards below have to hold on nodes with no `lockReason` whatsoever.
 *
 * The manual "layer lock" (`locked`, DnD-only) is untouched by all of this: a
 * node with `locked: true` and nothing else stays fully editable here.
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

function setCodeProps(nodeId: string, codeProps: string[]): void {
  useEditorStore.setState((s) => {
    s.site!.pages[0]!.nodes[nodeId]!.codeProps = codeProps
  })
}

describe('updateNodeProps — source-value guard', () => {
  it('no-ops on a prop listed in codeProps', () => {
    const id = setup()
    const tagBefore = getNode(id).props.tag
    setLockReason(id, 'item 3 of DEALS')
    setCodeProps(id, ['tag'])
    const historyBefore = useEditorStore.getState()._historyPast.length

    useEditorStore.getState().updateNodeProps(id, { tag: 'section' })

    expect(getNode(id).props.tag).toBe(tagBefore)
    expect(useEditorStore.getState()._historyPast.length).toBe(historyBefore)
  })

  it('still mutates a prop NOT listed, on a structurally locked node', () => {
    // The reported bug: a node the source does not place refused every prop,
    // including the literal attributes it spells out at that exact line.
    const id = setup()
    setLockReason(id, 'spread props')

    useEditorStore.getState().updateNodeProps(id, { tag: 'section' })

    expect(getNode(id).props.tag).toBe('section')
  })

  it('refuses the whole patch when one of its keys is code-valued', () => {
    // No `lockReason` on purpose: since `lock-01` a resolved value does not lock
    // its node at all, so this — a code-valued prop on a structurally ordinary
    // element — is the shape the parser actually emits for `title={c.label}`.
    const id = setup()
    setCodeProps(id, ['title'])

    useEditorStore.getState().updateNodeProps(id, { tag: 'section', title: 'x' })

    expect(getNode(id).props.tag).not.toBe('section')
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

describe('setNodeInlineStyles — source-value guard', () => {
  it('no-ops on a style property listed in codeProps', () => {
    const id = setup()
    setLockReason(id, 'item 3 of DEALS')
    // Style entries are namespaced under `style:` in the same list.
    setCodeProps(id, ['style:color'])
    const historyBefore = useEditorStore.getState()._historyPast.length

    useEditorStore.getState().setNodeInlineStyles(id, { color: 'red' })

    expect(getNode(id).inlineStyles).toBeUndefined()
    expect(useEditorStore.getState()._historyPast.length).toBe(historyBefore)
  })

  it('still mutates a style property NOT listed, on a structurally locked node', () => {
    const id = setup()
    setLockReason(id, 'spread props')

    useEditorStore.getState().setNodeInlineStyles(id, { color: 'red' })

    expect(getNode(id).inlineStyles).toEqual({ color: 'red' })
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

describe('startInlineEdit — source-value guard', () => {
  it('refuses when the text prop itself is code-valued', () => {
    // Again with no `lockReason`: `` text={`${n} left`} `` on an ordinary
    // element is code-valued but not structurally locked (`lock-01`).
    const id = setup('base.text', { text: 'Hello' })
    setCodeProps(id, ['text'])

    useEditorStore.getState().startInlineEdit(id, 'bp-desktop')

    expect(useEditorStore.getState().activeInlineEdit).toBeNull()
  })

  it('still starts a session on a structurally locked node whose text is a literal', () => {
    // Double-clicking real copy on a spread-bearing element has to work — the
    // spread feeds that element's props, not the text it spells out inside.
    const id = setup('base.text', { text: 'Hello' })
    setLockReason(id, 'spread props')

    useEditorStore.getState().startInlineEdit(id, 'bp-desktop')

    expect(useEditorStore.getState().activeInlineEdit?.nodeId).toBe(id)
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
