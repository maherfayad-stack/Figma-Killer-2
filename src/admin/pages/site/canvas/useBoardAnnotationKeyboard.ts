/**
 * useBoardAnnotationKeyboard — Delete / Cmd+D / Cmd+C / Cmd+V / arrow-nudge for
 * the selected sticky notes and doc cards.
 *
 * A `document`-level listener rather than a React `onKeyDown` on the canvas,
 * for exactly the reason `useCanvasSelectionKeyboard.ts` documents at length:
 * a `onKeyDown` prop only fires while a canvas descendant holds DOM focus, and
 * selecting anything on the board tends to move focus into a panel. Scoped by
 * INTENT instead — it stands down unless annotations are actually selected.
 *
 * It also stands down for a text field, a contentEditable (a note or doc being
 * edited is a text field, and Cmd+C there means "copy the text"), an open
 * dialog/menu, and an already-claimed keystroke. Those four checks are what
 * keep it from stealing keys from every other surface in the app.
 *
 * The node-tree equivalents of these shortcuts live in
 * `useCanvasKeyboardShortcuts.ts`, which is React-`onKeyDown`-based and keyed
 * off `selectedNodeId`. The two never both fire: node selection and annotation
 * selection are mutually exclusive when made by clicking, and this hook
 * requires a non-empty annotation selection.
 */
import { useEffect } from 'react'
import { useEditorStore } from '@site/store/store'
import { isTextInputTarget } from './useCanvasKeyboardShortcuts'

/** Board units an arrow key moves the selection, and the larger step Shift gives. */
const NUDGE_STEP = 1
const NUDGE_STEP_LARGE = 10

const ARROW_DELTAS: Record<string, { dx: number; dy: number }> = {
  ArrowLeft: { dx: -1, dy: 0 },
  ArrowRight: { dx: 1, dy: 0 },
  ArrowUp: { dx: 0, dy: -1 },
  ArrowDown: { dx: 0, dy: 1 },
}

/** Overlays that own the keyboard while open — mirrors `useCanvasSelectionKeyboard`'s list. */
const OVERLAY_SELECTOR = '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"]'

function isInsideOverlay(target: EventTarget | null): boolean {
  const element = target instanceof Element ? target : document.activeElement
  return element instanceof Element && element.closest(OVERLAY_SELECTOR) !== null
}

/** Mounts the listener. No-op while live, read-only, or with nothing selected. */
export function useBoardAnnotationKeyboard(editable: boolean, isLive: boolean): void {
  useEffect(() => {
    if (isLive || !editable) return

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      if (isTextInputTarget(event.target)) return
      if (isInsideOverlay(event.target)) return

      const state = useEditorStore.getState()
      const hasSelection = state.selectedAnnotations.length > 0
      const mod = event.metaKey || event.ctrlKey

      // Paste is the one action that works with NOTHING selected — the
      // clipboard is what it needs, not a selection.
      if (mod && event.key.toLowerCase() === 'v') {
        const clipboard = state.annotationClipboard
        if (clipboard.notes.length === 0 && clipboard.docs.length === 0) return
        event.preventDefault()
        state.pasteAnnotations()
        return
      }

      if (!hasSelection) return

      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault()
        state.deleteSelectedAnnotations()
        return
      }

      if (mod && event.key.toLowerCase() === 'd') {
        event.preventDefault()
        state.duplicateSelectedAnnotations()
        return
      }

      if (mod && event.key.toLowerCase() === 'c') {
        event.preventDefault()
        state.copySelectedAnnotations()
        return
      }

      const delta = ARROW_DELTAS[event.key]
      if (delta) {
        event.preventDefault()
        const step = event.shiftKey ? NUDGE_STEP_LARGE : NUDGE_STEP
        state.nudgeSelectedAnnotations(delta.dx * step, delta.dy * step)
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [editable, isLive])
}
