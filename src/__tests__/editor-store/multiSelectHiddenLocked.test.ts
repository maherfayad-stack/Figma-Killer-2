/**
 * setNodesHidden / setNodesLocked — `panel-40`'s fan-out over a selection.
 *
 * `panel-38` recorded the defect these close: `node.hidden` / `node.locked`
 * were reachable only through a per-node toggle, so the inspector's Layer row
 * and the Spotlight commands acted on the ANCHOR of a multi-selection and the
 * Layers context menu looped the toggle — N history entries for one gesture.
 *
 * Covers:
 *   1. One absolute value reaches every id.
 *   2. The whole fan-out is ONE undo step.
 *   3. A selection that DISAGREES converges (the property a toggle cannot
 *      have: N independent toggles just swap which half is hidden).
 *   4. A no-op (everything already in the requested state) records no history.
 *   5. A stale id is skipped instead of aborting the write for everyone else.
 *   6. An empty id list is a no-op, not a throw.
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

function seedNodes(count: number): string[] {
  const site = useEditorStore.getState().createSite('Fan-out')
  const root = site.pages[0].rootNodeId
  return Array.from({ length: count }, () =>
    useEditorStore.getState().insertNode('base.text', {}, root),
  )
}

function nodeOf(nodeId: string) {
  return useEditorStore.getState().site!.pages[0].nodes[nodeId]
}

function historyLength(): number {
  return useEditorStore.getState()._historyPast.length
}

describe('setNodesHidden', () => {
  it('hides every id in the selection, not just the anchor', () => {
    const ids = seedNodes(3)

    useEditorStore.getState().setNodesHidden(ids, true)

    for (const id of ids) expect(nodeOf(id).hidden).toBe(true)
  })

  it('is ONE undo step for the whole selection', () => {
    const ids = seedNodes(4)
    const before = historyLength()

    useEditorStore.getState().setNodesHidden(ids, true)
    expect(historyLength()).toBe(before + 1)

    useEditorStore.getState().undo()
    for (const id of ids) expect(nodeOf(id).hidden).toBeFalsy()
  })

  it('agrees a selection that disagrees — the thing a per-node toggle cannot do', () => {
    const ids = seedNodes(3)
    useEditorStore.getState().setNodesHidden([ids[0]], true)

    // One layer hidden, two visible. "Hide" must reach all three.
    useEditorStore.getState().setNodesHidden(ids, true)

    for (const id of ids) expect(nodeOf(id).hidden).toBe(true)
  })

  it('records no history when every node already holds the requested state', () => {
    const ids = seedNodes(2)
    useEditorStore.getState().setNodesHidden(ids, true)
    const after = historyLength()

    useEditorStore.getState().setNodesHidden(ids, true)

    expect(historyLength()).toBe(after)
  })

  it('skips a stale id instead of aborting the write for the rest', () => {
    const ids = seedNodes(2)

    useEditorStore.getState().setNodesHidden([...ids, 'gone-from-the-tree'], true)

    for (const id of ids) expect(nodeOf(id).hidden).toBe(true)
  })

  it('is a no-op for an empty selection', () => {
    seedNodes(1)
    const before = historyLength()

    useEditorStore.getState().setNodesHidden([], true)

    expect(historyLength()).toBe(before)
  })
})

describe('setNodesLocked', () => {
  it('locks every id in the selection and unlocks them again', () => {
    const ids = seedNodes(3)

    useEditorStore.getState().setNodesLocked(ids, true)
    for (const id of ids) expect(nodeOf(id).locked).toBe(true)

    useEditorStore.getState().setNodesLocked(ids, false)
    for (const id of ids) expect(nodeOf(id).locked).toBe(false)
  })

  it('is ONE undo step for the whole selection', () => {
    const ids = seedNodes(3)
    const before = historyLength()

    useEditorStore.getState().setNodesLocked(ids, true)
    expect(historyLength()).toBe(before + 1)

    useEditorStore.getState().undo()
    for (const id of ids) expect(nodeOf(id).locked).toBeFalsy()
  })

  it('agrees a selection that disagrees', () => {
    const ids = seedNodes(3)
    useEditorStore.getState().setNodesLocked([ids[1]], true)

    useEditorStore.getState().setNodesLocked(ids, true)

    for (const id of ids) expect(nodeOf(id).locked).toBe(true)
  })

  it('records no history when nothing changes', () => {
    const ids = seedNodes(2)
    const before = historyLength()

    useEditorStore.getState().setNodesLocked(ids, false)

    expect(historyLength()).toBe(before)
  })
})
