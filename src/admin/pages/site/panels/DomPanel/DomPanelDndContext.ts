import { createContext, use } from 'react'
import type { DomDropTarget } from './domPanelDnd'

/**
 * Live drop state, re-published on every `dragMove`.
 *
 * Deliberately SEPARATE from the row registry below. A React context re-renders
 * every consumer whenever its value identity changes, regardless of which field
 * that consumer reads — so while these two lived in one context, every row in
 * the tree re-rendered on every pointer move of a drag just to keep hold of a
 * `registerRow` function that never changed. Only the windowed list consumes
 * this one now; it turns the drop state into per-row props, and `React.memo`
 * bails out every row whose own indicator did not move.
 */
export interface DomPanelDropState {
  activeId: string | null
  target: DomDropTarget | null
  invalidOverId: string | null
  /**
   * G5 — the source-write refusal message for `invalidOverId`, when that
   * invalid state is a refused write (not an ordinary structural rejection).
   * See `previewDomDropRefusal` (`domPanelDnd.ts`).
   */
  invalidReason: string | null
}

export const IDLE_DROP_STATE: DomPanelDropState = {
  activeId: null,
  target: null,
  invalidOverId: null,
  invalidReason: null,
}

export const DomPanelDropStateContext = createContext<DomPanelDropState>(IDLE_DROP_STATE)

export function useDomPanelDropState(): DomPanelDropState {
  return use(DomPanelDropStateContext)
}

/**
 * Row-element registry — how a mounted row hands its DOM node to the drag
 * hit-tester (`useDomPanelDnd`'s `measureRows`). The value is created once and
 * never replaced, so consuming it costs nothing per render.
 */
export interface DomPanelRowRegistry {
  registerRow: (nodeId: string, element: HTMLElement | null) => void
}

const missingProvider = () => {
  throw new Error('DomPanelRowRegistryContext must be used inside its Provider')
}

export const DomPanelRowRegistryContext = createContext<DomPanelRowRegistry>({
  registerRow: missingProvider,
})

export function useDomPanelRowRegistry(): DomPanelRowRegistry {
  return use(DomPanelRowRegistryContext)
}
