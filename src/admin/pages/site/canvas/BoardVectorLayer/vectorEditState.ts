/**
 * vectorEditState — which inline `<svg>` is in vector edit mode (P5-D), as a
 * tiny external store.
 *
 * Deliberately NOT editor-store state, for the reason `canvasGesture.ts` and
 * `canvasDrawTool.ts` give for theirs: the readers are one board layer, one
 * key rung and one double-click entry, and routing a mode flag through the
 * zustand store would re-run every store subscriber on enter and exit for a
 * value no panel displays. Nothing here is persisted or undoable — each drag
 * inside the mode is its own undoable source write.
 */
import { useSyncExternalStore } from 'react'

export interface VectorEditTarget {
  /** The literal `<svg>`'s node id — the host every `svg-attr` write names. */
  hostNodeId: string
  /** The page that node belongs to. */
  pageId: string
  /** The board frame it was entered from — the iframe the parts are measured in. */
  frameId: string | null
}

let target: VectorEditTarget | null = null
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

export function getVectorEditTarget(): VectorEditTarget | null {
  return target
}

export function subscribeVectorEdit(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function enterVectorEdit(next: VectorEditTarget): void {
  target = next
  notify()
}

export function exitVectorEdit(): void {
  if (target === null) return
  target = null
  notify()
}

export function useVectorEditTarget(): VectorEditTarget | null {
  return useSyncExternalStore(subscribeVectorEdit, getVectorEditTarget, getVectorEditTarget)
}
