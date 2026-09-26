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
 *   - hover runs on every pointer crossing. It was guarded against same-value
 *     writes in `speed-03`; since P2-I it is not store state at all
 *     (`canvas/canvasHover.ts`), pinned below so it cannot quietly come back.
 *
 * The assertion is on the number of store notifications, which is exactly
 * "did the sweep run".
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import { setCanvasHover } from '@site/canvas/canvasHover'

let notifications = 0
let unsubscribe: (() => void) | null = null

beforeEach(() => {
  useEditorStore.setState({
    selectedAnnotations: [],
    selectedNodeIds: [],
    selectedNodeId: null,
    selectedFrameIds: [],
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

  it('hovering is never a store write, not even a real change (P2-I moved it to canvasHover.ts)', () => {
    setCanvasHover('node-1', 'studio', 'frame-1')
    for (let move = 0; move < 20; move += 1) setCanvasHover('node-1', 'studio', 'frame-1')
    setCanvasHover('node-2', 'studio', 'frame-1')
    setCanvasHover(null)
    expect(notifications).toBe(0)
  })
})
