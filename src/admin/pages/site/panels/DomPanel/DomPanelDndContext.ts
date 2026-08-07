import { createContext, use } from 'react'
import type { DomDropTarget } from './domPanelDnd'

export interface DomPanelDndContextValue {
  activeId: string | null
  target: DomDropTarget | null
  invalidOverId: string | null
  /**
   * G5 — the source-write refusal message for `invalidOverId`, when that
   * invalid state is a refused write (not an ordinary structural rejection).
   * See `previewDomDropRefusal` (`domPanelDnd.ts`).
   */
  invalidReason: string | null
  registerRow: (nodeId: string, element: HTMLElement | null) => void
}

const missingProvider = () => {
  throw new Error('DomPanelDndContext must be used inside DomPanelDndContext.Provider')
}

export const DomPanelDndContext = createContext<DomPanelDndContextValue>({
  activeId: null,
  target: null,
  invalidOverId: null,
  invalidReason: null,
  registerRow: missingProvider,
})

export function useDomPanelDndContext(): DomPanelDndContextValue {
  return use(DomPanelDndContext)
}
