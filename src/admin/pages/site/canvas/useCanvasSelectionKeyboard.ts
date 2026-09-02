/**
 * useCanvasSelectionKeyboard — the ONE owner of Enter and Escape for the canvas
 * selection, and therefore of the whole "how do I get back to nothing selected"
 * ladder:
 *
 *   1. `Enter` with a `studio.instance` selected steps INTO it (WS-4.2).
 *   2. `Escape` inside an entered instance steps back OUT one level.
 *   3. `Escape` with anything else selected clears EVERY selection — nodes,
 *      board frames, sticky notes / doc cards — and leaves Visual Component
 *      mode. All in one press: they are independent lists (a marquee can leave
 *      frames and annotations selected at once), so clearing a subset would
 *      leave the board looking deselected while Delete still had a target.
 *
 * Both listeners are on the parent `document`, not React `onKeyDown` props, and
 * that is load-bearing for two independent reasons — one per direction of the
 * canvas's split event world:
 *
 * **Keystrokes that start INSIDE a frame iframe.** `focusNodeWithoutScrolling`
 * (`NodeRenderer.tsx`) focuses the clicked element in the iframe's own document
 * on every node click, so after any selection the keystroke is born in a
 * different document. `IframeFrameSurface.tsx`'s bridge re-dispatches it as a
 * clone on THIS document, whose `target` is `document` itself — a raw
 * `document.addEventListener` is the only listener shape guaranteed to see both
 * that clone and the ordinary parent-document event.
 *
 * **Keystrokes pressed while a PANEL holds focus.** This is `select-01`'s
 * reported bug ("I can't deselect after selecting"), and it is the Escape twin
 * of the Ctrl+A defect `board-02` fixed. Selecting a node auto-opens the
 * Properties panel; the moment the user touches it — or the zoom buttons, or
 * any other chrome — DOM focus leaves the canvas subtree. A React `onKeyDown`
 * on the canvas div only fires while a canvas descendant holds focus, so Escape
 * silently did nothing from there on. Verified in a real browser: select a node,
 * click the Properties panel, press Escape — the selection ring stayed.
 *
 * So the generic branch is scoped by INTENT, exactly like
 * `board.selectAllFrames` in `CanvasRoot.tsx`: it stands down for a text field,
 * for an already-claimed keystroke, for an overlay that owns Escape itself, and
 * for the case where there is simply nothing to clear. It never asks where the
 * focus happens to be.
 *
 * **Phases.** The instance branch listens in CAPTURE and `stopPropagation`s
 * when it claims, so a step-out can never be undone by a later handler clearing
 * the selection (`instance-ui-01` proved that ordering matters in a browser).
 * The generic branch listens in BUBBLE, so every handler that owns Escape more
 * locally — `CanvasTreeLadderOverlay`, an inline-edit session, a module's own
 * control — runs first and marks the event `defaultPrevented`, which stands
 * this one down. It also only `preventDefault`s, never `stopPropagation`s: a
 * `Dialog` mounted after this listener would otherwise lose its own
 * Escape-to-close.
 */
import { useEffect } from 'react'
import { useEditorStore } from '@site/store/store'
import { isTextInputTarget } from './useCanvasKeyboardShortcuts'

/**
 * Overlays that own Escape themselves and move focus into their own subtree.
 * While one is open, Escape means "close me", not "deselect" — and clearing the
 * canvas selection underneath an open modal is never what the user asked for.
 */
const ESCAPE_OWNING_OVERLAY_SELECTOR = '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"]'

/**
 * True when the keystroke belongs to an open dialog / menu / listbox. The
 * bridged iframe clone targets `document` rather than an element, so the active
 * element is the honest fallback question there.
 */
function isInsideEscapeOwningOverlay(target: EventTarget | null): boolean {
  const element = target instanceof Element ? target : document.activeElement
  return element instanceof Element && element.closest(ESCAPE_OWNING_OVERLAY_SELECTOR) !== null
}

/** Mounts the document-level Enter/Escape listeners. No-op while live or read-only. */
export function useCanvasSelectionKeyboard(editable: boolean, isLive: boolean): void {
  useEffect(() => {
    if (isLive || !editable) return

    // ── Capture: step into / out of an instance ──────────────────────────
    const onInstanceKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      if (useEditorStore.getState().activeInlineEdit) return
      if (isTextInputTarget(event.target)) return

      if (event.key === 'Escape') {
        // Only claims the keystroke when something is actually entered —
        // otherwise falls through to the generic branch below, unchanged.
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

    // ── Bubble: Escape means "get me back to nothing selected" ────────────
    const onDeselectKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (event.defaultPrevented) return
      if (useEditorStore.getState().activeInlineEdit) return
      if (isTextInputTarget(event.target)) return
      if (isInsideEscapeOwningOverlay(event.target)) return

      const state = useEditorStore.getState()
      const hasSelection =
        state.selectedNodeId !== null ||
        state.selectedFrameIds.length > 0 ||
        state.selectedAnnotations.length > 0
      const inVisualComponentMode = state.activeDocument?.kind === 'visualComponent'
      // Nothing to clear — leave the keystroke for whoever else wants it.
      if (!hasSelection && !inVisualComponentMode) return

      event.preventDefault()
      state.clearAllSelections()
      // Escape has always doubled as "leave VC canvas mode" (SF-1 / CR #666),
      // in the same press as the clear.
      if (inVisualComponentMode) state.setActiveDocument(null)
    }

    document.addEventListener('keydown', onInstanceKeyDown, true)
    document.addEventListener('keydown', onDeselectKeyDown)
    return () => {
      document.removeEventListener('keydown', onInstanceKeyDown, true)
      document.removeEventListener('keydown', onDeselectKeyDown)
    }
  }, [editable, isLive])
}
