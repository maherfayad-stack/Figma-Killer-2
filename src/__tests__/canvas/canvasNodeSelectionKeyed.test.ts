/**
 * P2-I (PERF-1) — "is THIS node selected" is a keyed read.
 *
 * `NodeRenderer` used to run `s.selectedNodeIds.includes(nodeId)` as its own
 * store selector, once per mounted node per store change. One store listener
 * now diffs the selection and wakes only the nodes whose answer changed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import {
  changedSelectionIds,
  isNodeSelectedInFrame,
  subscribeNodeSelection,
} from '@site/canvas/canvasNodeSelection'

const unsubscribes: Array<() => void> = []
let woken: string[] = []

function listen(ids: string[]) {
  for (const id of ids) unsubscribes.push(subscribeNodeSelection(id, () => woken.push(id)))
}

beforeEach(() => {
  woken = []
  useEditorStore.setState({ selectedNodeIds: [], selectedNodeId: null, selectedNodeFrameId: null })
})

afterEach(() => {
  for (const unsubscribe of unsubscribes.splice(0)) unsubscribe()
})

describe('keyed selection notifications', () => {
  it('a selection change wakes exactly the nodes that entered or left it', () => {
    listen(['a', 'b', 'c', 'd', 'e'])
    useEditorStore.setState({ selectedNodeIds: ['a'], selectedNodeId: 'a' })
    expect(woken).toEqual(['a'])

    woken = []
    useEditorStore.setState({ selectedNodeIds: ['a', 'b'], selectedNodeId: 'b' })
    expect(woken).toEqual(['b'])

    woken = []
    useEditorStore.setState({ selectedNodeIds: ['c'], selectedNodeId: 'c' })
    expect(woken.sort()).toEqual(['a', 'b', 'c'])
  })

  it('a store change that is not a selection change wakes nobody', () => {
    listen(['a', 'b'])
    useEditorStore.setState({ selectedNodeIds: ['a'], selectedNodeId: 'a' })
    woken = []
    useEditorStore.setState({ activeClassId: 'something-else' } as Parameters<typeof useEditorStore.setState>[0])
    useEditorStore.setState({ zoom: 2 } as Parameters<typeof useEditorStore.setState>[0])
    expect(woken).toEqual([])
  })

  it('moving the same selection to another frame wakes every selected node (WS-10 variant frames)', () => {
    listen(['a', 'b', 'c'])
    useEditorStore.setState({ selectedNodeIds: ['a', 'b'], selectedNodeId: 'b', selectedNodeFrameId: 'frame-1' })
    woken = []
    useEditorStore.setState({ selectedNodeFrameId: 'frame-2' })
    expect(woken.sort()).toEqual(['a', 'b'])
  })
})

describe('the pure pieces', () => {
  it('changedSelectionIds is the symmetric difference, or the union when the frame changed', () => {
    const base = { selectedNodeIds: ['a', 'b'], selectedNodeFrameId: null }
    expect(changedSelectionIds(base, base)).toEqual([])
    expect(changedSelectionIds(base, { selectedNodeIds: ['b', 'c'], selectedNodeFrameId: null }).sort()).toEqual(['a', 'c'])
    expect(changedSelectionIds(base, { selectedNodeIds: ['a', 'b'], selectedNodeFrameId: 'f' }).sort()).toEqual(['a', 'b'])
  })

  it('isNodeSelectedInFrame scopes a framed selection to its frame, and a frameless one to every frame', () => {
    const framed = { selectedNodeIds: ['a'], selectedNodeFrameId: 'f1' }
    expect(isNodeSelectedInFrame(framed, 'a', 'f1')).toBe(true)
    expect(isNodeSelectedInFrame(framed, 'a', 'f2')).toBe(false)
    const frameless = { selectedNodeIds: ['a'], selectedNodeFrameId: null }
    expect(isNodeSelectedInFrame(frameless, 'a', 'f2')).toBe(true)
    expect(isNodeSelectedInFrame(frameless, 'b', null)).toBe(false)
  })
})
