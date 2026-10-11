/**
 * canvasNodeData — the store reads a `NodeRenderer` makes about ITS OWN node,
 * woken only by writes that can change them.
 *
 * Zustand runs every subscribed selector on every `set()`. A board mounts one
 * `NodeRenderer` per live node (~2,800 on the 40 × 300 corpus), each reading
 * its node, its class name, its previews and its inline-edit state — seven
 * selectors, ~20,000 calls per write. A press makes three or four writes (the
 * page activates, the layer is selected, the panel is focused, the breakpoint
 * follows), and the sweep was 8–14 ms of every one of them in production, the
 * biggest single slice of the click that was not React rendering.
 *
 * But a press's writes change none of those answers: they change WHICH node is
 * selected, and selection is already a keyed read (`canvasNodeSelection.ts`).
 * So a node's data reads subscribe to this filter instead of the store: it
 * compares the previous and the next state ONCE per write (a shallow walk of
 * the store's keys, a few microseconds) and wakes the nodes only when something
 * other than the selection changed. Selectors are never skipped by being
 * cached: a node that renders for any other reason reads the live state, and a
 * write that touches anything NOT listed below wakes every node exactly as it
 * did. The lists are therefore DENY lists — a key forgotten from it costs a
 * sweep, never a stale canvas — and every key on it is one no `NodeRenderer`
 * selector reads (`canvasNodeData.test.ts` holds that line).
 */
import { useSyncExternalStore } from 'react'
import { useEditorStore, type EditorStore } from '@site/store/store'

/**
 * Written by selecting and focusing — and read by no per-node selector.
 */
export const SELECTION_ONLY_KEYS: ReadonlySet<string> = new Set([
  'selectedNodeId',
  'selectedNodeIds',
  'selectedNodeFrameId',
  'selectedSelectorClassId',
  'enteredInstanceIds',
  'activeBreakpointId',
  'activeConditionId',
  'focusedPanel',
])

/**
 * Written by activating a page. A node that renders a SPECIFIC page (a board
 * frame: `selectCanvasPageFor` is handed its page id) never reads them - except
 * through a form preview, which resolves its node against the active canvas
 * page. A node of the CMS / Visual Component canvas (no page id of its own) IS
 * the active document, so it always reads them.
 */
const ACTIVE_PAGE_KEYS: ReadonlySet<string> = new Set(['activePageId', 'activeDocument', 'previousActivePageId'])

function anyFormPreview(state: Record<string, unknown>): boolean {
  for (const _key in state.formPreviewStates as object | undefined) return true
  return false
}

/**
 * True when `next` differs from `prev` in a key a node's data can depend on.
 * `pageScoped` is a node that renders a specific page (see {@link ACTIVE_PAGE_KEYS}).
 */
export function changesNodeData(next: object, prev: object, pageScoped = false): boolean {
  const a = next as Record<string, unknown>
  const b = prev as Record<string, unknown>
  const activePageMatters = !pageScoped || anyFormPreview(a) || anyFormPreview(b)
  for (const key in a) {
    if (a[key] === b[key] || SELECTION_ONLY_KEYS.has(key)) continue
    if (!activePageMatters && ACTIVE_PAGE_KEYS.has(key)) continue
    return true
  }
  return false
}

const listeners = { pageScoped: new Set<() => void>(), canvas: new Set<() => void>() }
let unsubscribeStore: (() => void) | null = null

function subscribeTo(group: Set<() => void>): (listener: () => void) => () => void {
  return (listener) => {
    group.add(listener)
    if (unsubscribeStore === null) {
      unsubscribeStore = useEditorStore.subscribe((next, prev) => {
        for (const [scoped, set] of [[true, listeners.pageScoped], [false, listeners.canvas]] as const) {
          if (set.size > 0 && changesNodeData(next, prev, scoped)) for (const notify of [...set]) notify()
        }
      })
    }
    return () => {
      group.delete(listener)
      if (listeners.pageScoped.size === 0 && listeners.canvas.size === 0) {
        unsubscribeStore?.()
        unsubscribeStore = null
      }
    }
  }
}

const subscribePageScoped = subscribeTo(listeners.pageScoped)
const subscribeCanvas = subscribeTo(listeners.canvas)

/**
 * `useEditorStore(selector)` for a read about one node — see the module doc.
 * `pageScoped`: the node renders the specific page it was handed (a board
 * frame), not the active document.
 */
export function useCanvasNodeData<T>(selector: (state: EditorStore) => T, pageScoped: boolean): T {
  const read = () => selector(useEditorStore.getState())
  return useSyncExternalStore(pageScoped ? subscribePageScoped : subscribeCanvas, read, read)
}
