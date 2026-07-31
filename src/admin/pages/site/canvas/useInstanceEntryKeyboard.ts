/**
 * useInstanceEntryKeyboard — instance-ui-01: Enter enters a selected
 * `studio.instance` (WS-4.2), Escape steps back out one level.
 *
 * Extracted out of `CanvasRoot.tsx` (module-size-budgets ceiling) — same
 * "extract, don't grandfather" call `board-02`/`canvas-05` made for their
 * own overflow.
 *
 * Document-level, not React `onKeyDown` on `canvasRef` — for the same
 * reason `board.selectAllFrames` (`CanvasRoot.tsx`) is: `focusNodeWithoutScrolling`
 * (`NodeRenderer.tsx`) focuses the clicked element INSIDE the breakpoint
 * iframe on every node click, so by the time a user presses Enter/Escape
 * after selecting anything, DOM focus is in a different document than
 * `canvasRef`. `IframeFrameSurface.tsx`'s keyboard bridge re-dispatches
 * every iframe keydown as a clone on THIS (parent) `document` — a raw
 * `document.addEventListener` is the only listener shape guaranteed to see
 * it (React's synthetic delegation on `canvasRef` is a descendant of
 * `document`, so an event dispatched with `document` itself as the target
 * never reaches it).
 *
 * CAPTURE phase, and `stopPropagation` when the key is actually consumed.
 * Both are load-bearing, and a browser pass is what proved it: with a
 * bubble-phase listener, Escape reached `useCanvasKeyboardShortcuts`'s own
 * Escape branch FIRST whenever focus sat in the parent document (React 19
 * delegates to the root container, a descendant of `document`, so the event
 * bubbles there before reaching here). That branch calls `clearSelection()`
 * unconditionally and never checks `defaultPrevented` — it emptied
 * `enteredInstanceIds` before this handler ran, so `exitInstance()` then found
 * nothing entered and Escape collapsed the entire selection instead of
 * stepping out one level. Capture puts this handler ahead of it, and
 * `stopPropagation` stops the event descending to it at all — but ONLY on the
 * keystrokes actually claimed here (something is entered / an instance is
 * selected), so every other Escape still reaches the generic "clear selection
 * / exit VC mode" behaviour unchanged.
 */
import { useEffect } from 'react'
import { useEditorStore } from '@site/store/store'
import { isTextInputTarget } from './useCanvasKeyboardShortcuts'

/** Mounts the document-level Enter/Escape listener. No-op while live or read-only. */
export function useInstanceEntryKeyboard(editable: boolean, isLive: boolean): void {
  useEffect(() => {
    if (isLive || !editable) return

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      if (useEditorStore.getState().activeInlineEdit) return
      if (isTextInputTarget(event.target)) return

      if (event.key === 'Escape') {
        // Only claims the keystroke when something is actually entered —
        // otherwise falls through to `useCanvasKeyboardShortcuts`'s own
        // Escape branch (clear selection / exit VC mode), unchanged.
        if (useEditorStore.getState().exitInstance()) {
          event.preventDefault()
          event.stopPropagation()
        }
        return
      }

      if (event.key === 'Enter') {
        if (useEditorStore.getState().enterSelectedInstance()) {
          event.preventDefault()
          event.stopPropagation()
        }
      }
    }

    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [editable, isLive])
}
