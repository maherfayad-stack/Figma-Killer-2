import { createContext, use } from 'react'
import { IDLE_DROP_STATE, type DomPanelDropState } from './DomPanelDndContext'

/**
 * LayerDragBridge — what lets a Layers drag started in the ACTIVE page's tree
 * see, and light up, the OTHER pages' trees rendered beside it.
 *
 * Only the active page's `DomPanel` owns a `DndContext`; every other page is a
 * `PageLayerSubtree` with deliberately inert rows. A drop onto one of those
 * rows is a cross-page transplant, so the active panel's hit-tester needs their
 * row elements, and their rows need the panel's live drop state to paint the
 * insertion line. `StudioPagesTree` creates one bridge for the whole list and
 * both sides reach it through context — no module singleton, so two panels on
 * screen (or two test renders) never share rows.
 */
export interface LayerDragBridge {
  /** Row elements of other pages' trees, by page id then node id. */
  readonly foreignRows: ReadonlyMap<string, ReadonlyMap<string, HTMLElement>>
  registerForeignRow: (pageId: string, nodeId: string, element: HTMLElement | null) => void
  /** The active panel's drop state, mirrored for the other pages' rows. */
  publishDropState: (state: DomPanelDropState) => void
  subscribe: (listener: () => void) => () => void
  getDropState: () => DomPanelDropState
}

export function createLayerDragBridge(): LayerDragBridge {
  const rows = new Map<string, Map<string, HTMLElement>>()
  const listeners = new Set<() => void>()
  let dropState = IDLE_DROP_STATE

  return {
    foreignRows: rows,
    registerForeignRow: (pageId, nodeId, element) => {
      let pageRows = rows.get(pageId)
      if (!element) {
        pageRows?.delete(nodeId)
        return
      }
      if (!pageRows) {
        pageRows = new Map()
        rows.set(pageId, pageRows)
      }
      pageRows.set(nodeId, element)
    },
    publishDropState: (next) => {
      if (
        next.activeId === dropState.activeId &&
        next.target === dropState.target &&
        next.invalidOverId === dropState.invalidOverId &&
        next.invalidReason === dropState.invalidReason
      ) {
        return
      }
      dropState = next
      for (const listener of listeners) listener()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getDropState: () => dropState,
  }
}

export const LayerDragBridgeContext = createContext<LayerDragBridge | null>(null)

export function useLayerDragBridge(): LayerDragBridge | null {
  return use(LayerDragBridgeContext)
}
