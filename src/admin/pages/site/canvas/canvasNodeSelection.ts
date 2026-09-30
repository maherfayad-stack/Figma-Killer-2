/**
 * canvasNodeSelection — "is THIS node selected in THIS frame", keyed by node
 * id (P2-I, PERF-1).
 *
 * `NodeRenderer` used to answer this with its own store selector,
 * `s.selectedNodeIds.includes(nodeId) && …`, so every mounted node ran it on
 * every store change — a keystroke, a pan commit, a click: ~3,600 runs per
 * `set()` per 300-node frame. Selection stays in the store (the panels, the
 * overlay and undo all read it), but the per-node question does not need a
 * per-node subscription: ONE store listener diffs the old selection against
 * the new one and wakes only the nodes whose answer can have changed.
 *
 * - Same frame scope: the symmetric difference of the two id lists.
 * - Frame scope changed (`selectedNodeFrameId`): every id in either list,
 *   because "selected in frame X" flips for all of them.
 *
 * The store listener is attached while at least one node listens and
 * detached when the last one leaves, so an editor with no canvas mounted
 * pays nothing.
 */
import { useSyncExternalStore } from 'react'
import { useEditorStore } from '@site/store/store'
import type { EditorStore } from '@site/store/types'
import { createKeyedNotifier } from './keyedNotifier'

type SelectionFields = Pick<EditorStore, 'selectedNodeIds' | 'selectedNodeFrameId'>

const byNode = createKeyedNotifier()
let detachFromStore: (() => void) | null = null

/**
 * The node ids whose "selected in frame F" answer can differ between two
 * selection states. Empty when the selection did not change.
 */
export function changedSelectionIds(previous: SelectionFields, next: SelectionFields): string[] {
  if (previous.selectedNodeIds === next.selectedNodeIds && previous.selectedNodeFrameId === next.selectedNodeFrameId) {
    return []
  }
  if (previous.selectedNodeFrameId !== next.selectedNodeFrameId) {
    return [...new Set([...previous.selectedNodeIds, ...next.selectedNodeIds])]
  }
  const before = new Set(previous.selectedNodeIds)
  const after = new Set(next.selectedNodeIds)
  const changed: string[] = []
  for (const id of before) if (!after.has(id)) changed.push(id)
  for (const id of after) if (!before.has(id)) changed.push(id)
  return changed
}

/**
 * WS-10 Phase 2 — a selection made in one board frame rings the node in THAT
 * frame only (`selectedNodeFrameId`); a frame-less selection (Layers panel,
 * CMS/VC canvas) rings it wherever it renders.
 */
export function isNodeSelectedInFrame(state: SelectionFields, nodeId: string, frameId: string | null): boolean {
  return state.selectedNodeIds.includes(nodeId) && (!state.selectedNodeFrameId || state.selectedNodeFrameId === frameId)
}

export function subscribeNodeSelection(nodeId: string, listener: () => void): () => void {
  detachFromStore ??= useEditorStore.subscribe((state, previous) => {
    const changed = changedSelectionIds(previous, state)
    if (changed.length > 0) byNode.notify(changed)
  })
  const unsubscribe = byNode.subscribe(nodeId, listener)
  return () => {
    unsubscribe()
    if (byNode.listenerCount() === 0 && detachFromStore) {
      detachFromStore()
      detachFromStore = null
    }
  }
}

/** Whether `nodeId` shows the selection ring in the frame `frameId`. Wakes only when that answer can change. */
export function useIsNodeSelected(nodeId: string, frameId: string | null): boolean {
  const snapshot = () => isNodeSelectedInFrame(useEditorStore.getState(), nodeId, frameId)
  return useSyncExternalStore((listener) => subscribeNodeSelection(nodeId, listener), snapshot, snapshot)
}
