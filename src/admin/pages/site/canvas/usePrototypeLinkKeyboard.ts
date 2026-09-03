/**
 * usePrototypeLinkKeyboard — Delete / Backspace removes the selected prototype
 * link, Escape deselects it.
 *
 * A `document`-level listener scoped BY INTENT, exactly like
 * `useBoardAnnotationKeyboard`: a React `onKeyDown` only fires while a canvas
 * descendant holds DOM focus, and selecting a connector puts focus wherever the
 * click landed — often the inspector that just opened. The hook stands down
 * unless a link is actually selected, which is what keeps it from stealing
 * Delete from the node tree, a text field, or a dialog.
 *
 * A selected LINK and a selected NODE can both exist at once (clicking a
 * connector does not clear the node selection), so this runs in the CAPTURE
 * phase and marks the event handled. Otherwise Delete would delete the link and
 * the element in one keystroke — the node-tree handler has no way to know the
 * keystroke was meant for a connector.
 */
import { useEffect } from 'react'
import { useEditorStore } from '@site/store/store'
import { deleteLink } from '@site/studio/prototypeActions'
import { isTextInputTarget } from './useCanvasKeyboardShortcuts'

/** Overlays that own the keyboard while open — mirrors the sibling hooks' list. */
const OVERLAY_SELECTOR = '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"]'

function isInsideOverlay(target: EventTarget | null): boolean {
  const element = target instanceof Element ? target : document.activeElement
  return element instanceof Element && element.closest(OVERLAY_SELECTOR) !== null
}

/** Mounts the listener. No-op unless prototype mode has a link selected. */
export function usePrototypeLinkKeyboard(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      if (isTextInputTarget(event.target)) return
      if (isInsideOverlay(event.target)) return

      const state = useEditorStore.getState()
      if (state.boardMode !== 'prototype') return

      // A pick in flight owns Escape — `usePrototypeLinkPick` cancels it there.
      if (state.linkDraft) return

      const linkId = state.selectedLinkId
      if (!linkId) return

      if (event.key === 'Escape') {
        event.preventDefault()
        state.setSelectedLink(null)
        return
      }

      if (event.key !== 'Delete' && event.key !== 'Backspace') return
      // Claim it before the node-tree handler sees it: both selections can be
      // live at once, and only one of them was meant.
      event.preventDefault()
      event.stopPropagation()
      void deleteLink(linkId)
    }

    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [enabled])
}
