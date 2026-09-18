/**
 * usePrototypeLinkKeyboard — the `prototype-link` scope: Delete / Backspace
 * removes the selected prototype link, Escape deselects it.
 *
 * A selected LINK and a selected NODE can both exist at once (clicking a
 * connector does not clear the node selection), so Delete has to be decided
 * for the connector BEFORE the node scope sees it. That used to be bought with
 * a capture-phase listener plus `stopPropagation`; it is now the ladder's own
 * ordering — `prototype-link` sits above `node`, so claiming here is all it
 * takes (`editorKeyDispatcher.ts`).
 */
import { useEditorStore } from '@site/store/store'
import { deleteLink } from '@site/studio/prototypeActions'
import { isInsideKeyOwningOverlay, isTextInputTarget } from './editorKeyGuards'
import { useEditorKeyScope } from './useEditorKeyDispatcher'

/** Registers the scope. Inert unless prototype mode has a link selected. */
export function usePrototypeLinkKeyboard(enabled: boolean): void {
  useEditorKeyScope(
    'prototype-link',
    () => {
      if (!enabled) return false
      const state = useEditorStore.getState()
      if (state.boardMode !== 'prototype') return false
      // A pick in flight owns Escape — `usePrototypeLinkPick` cancels it there.
      if (state.linkDraft) return false
      return state.selectedLinkId !== null
    },
    (event) => {
      if (isTextInputTarget(event.target)) return false
      if (isInsideKeyOwningOverlay(event.target)) return false

      const state = useEditorStore.getState()
      const linkId = state.selectedLinkId
      if (!linkId) return false

      if (event.key === 'Escape') {
        event.preventDefault()
        state.setSelectedLink(null)
        return true
      }

      if (event.key !== 'Delete' && event.key !== 'Backspace') return false
      event.preventDefault()
      void deleteLink(linkId)
      return true
    },
  )
}
