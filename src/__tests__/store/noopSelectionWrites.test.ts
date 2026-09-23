/**
 * PERF-11 — a store write that changes nothing must not happen at all.
 *
 * Every `set()` re-runs every mounted selector: on a 40-page x 300-node board
 * with twelve frames mounted that is ~20 ms of pure selector work
 * (`scripts/bench/lib/canvasSubscriberSweep.ts`). The two hot callers the
 * audit named:
 *
 *   - the marquee (`useMarqueeSelection.ts`) writes the annotation selection on
 *     EVERY pointermove, with a hit set that is the same for almost every move;
 *   - `hoverNode` runs on every pointer crossing (guarded since `speed-03`;
 *     pinned here so the guard cannot quietly go).
 *
 * The assertion is on the number of store notifications, which is exactly
 * "did the sweep run".
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { useEditorStore } from '@site/store/store'

let notifications = 0
let unsubscribe: (() => void) | null = null

beforeEach(() => {
  useEditorStore.setState({
    selectedAnnotations: [],
    selectedNodeIds: [],
    selectedNodeId: null,
    selectedFrameIds: [],
    hoveredNodeId: null,
    hoveredBreakpointId: null,
    hoveredFrameId: null,
  } as Parameters<typeof useEditorStore.setState>[0])
  notifications = 0
  unsubscribe = useEditorStore.subscribe(() => {
    notifications += 1
  })
})

afterEach(() => {
  unsubscribe?.()
  unsubscribe = null
})

describe('no-op selection writes notify nobody (PERF-11)', () => {
  it('the marquee re-writing the same annotation hits is not a store write', () => {
    const hits = [
      { kind: 'note' as const, id: 'n1' },
      { kind: 'doc' as const, id: 'd1' },
    ]
    useEditorStore.getState().setSelectedAnnotations(hits)
    expect(notifications).toBe(1)

    for (let move = 0; move < 20; move += 1) {
      useEditorStore.getState().setSelectedAnnotations(hits.map((ref) => ({ ...ref })))
    }
    expect(notifications).toBe(1)
  })

  it('a marquee over empty board (no hits, nothing selected) is not a store write', () => {
    for (let move = 0; move < 20; move += 1) useEditorStore.getState().setSelectedAnnotations([])
    expect(notifications).toBe(0)
  })

  it('a changed hit set still writes', () => {
    useEditorStore.getState().setSelectedAnnotations([{ kind: 'note', id: 'n1' }])
    useEditorStore.getState().setSelectedAnnotations([{ kind: 'note', id: 'n1' }, { kind: 'note', id: 'n2' }])
    expect(notifications).toBe(2)
    expect(useEditorStore.getState().selectedAnnotations).toHaveLength(2)
  })

  it('clicking the already-selected annotation still clears a node selection', () => {
    useEditorStore.getState().setSelectedAnnotations([{ kind: 'note', id: 'n1' }])
    useEditorStore.setState({ selectedNodeIds: ['node-1'], selectedNodeId: 'node-1' })
    notifications = 0
    useEditorStore.getState().selectAnnotation({ kind: 'note', id: 'n1' })
    expect(useEditorStore.getState().selectedNodeIds).toEqual([])
    expect(notifications).toBe(1)
  })

  it('hovering the node that is already hovered is not a store write', () => {
    useEditorStore.getState().hoverNode('node-1', 'studio', 'frame-1')
    expect(notifications).toBe(1)
    for (let move = 0; move < 20; move += 1) useEditorStore.getState().hoverNode('node-1', 'studio', 'frame-1')
    expect(notifications).toBe(1)
  })
})
