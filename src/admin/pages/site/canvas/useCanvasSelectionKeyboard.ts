/**
 * useCanvasSelectionKeyboard — the ONE owner of Enter, ⇧Enter, Escape and ⌘R
 * for the canvas selection, and therefore of the whole "how do I get back to
 * nothing selected" ladder:
 *
 *   1. `Enter` with a `studio.instance` selected steps INTO it (WS-4.2).
 *   2. `Enter` otherwise selects the anchor's FIRST CHILD — Figma's
 *      "step into" (`layers.selectFirstChild`, viewport-01).
 *   3. `⇧Enter` selects the anchor's PARENT (`layers.selectParent`).
 *   4. `Escape` inside an entered instance steps back OUT one level.
 *   5. `Escape` with anything else selected clears EVERY selection — nodes,
 *      board frames, sticky notes / doc cards — and leaves Visual Component
 *      mode. All in one press: they are independent lists (a marquee can leave
 *      frames and annotations selected at once), so clearing a subset would
 *      leave the board looking deselected while Delete still had a target.
 *   6. `⌘R` opens the canvas rename dialog on the anchor (`layers.rename`).
 *
 * **Escape stays "deselect", it does NOT become "select parent"** (viewport-01).
 * Figma binds ⇧Enter for that and Esc for deselect, and rung 5 above is the
 * fix `select-01` shipped for a reported "I can't deselect after selecting"
 * bug — turning one press into N presses for a deeply nested node would
 * re-open it. The traversal took Figma's own keys instead.
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
import { useEffect, useEffectEvent } from 'react'
import { useEditorStore } from '@site/store/store'
import { getKeybindingForCommand } from '@admin/spotlight/keybindings'
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

/**
 * Mounts the document-level Enter / ⇧Enter / Escape / ⌘R listeners. No-op
 * while live or read-only.
 *
 * `openRenameDialog` is `useCanvasRenameDialog`'s `open` — the canvas's own
 * rename flow, the same one the right-click menu drives. It is passed through
 * `useEffectEvent` so the listener isn't torn down and re-added on every
 * render just because the dialog's local state changed identity.
 */
export function useCanvasSelectionKeyboard(
  editable: boolean,
  isLive: boolean,
  openRenameDialog: (nodeId: string) => void,
): void {
  const requestRename = useEffectEvent((nodeId: string) => openRenameDialog(nodeId))

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

      // PLAIN Enter only — matched through the registry so ⇧Enter (select
      // parent) can never be swallowed here. A bare `event.key === 'Enter'`
      // test did exactly that once ⇧Enter existed.
      if (getKeybindingForCommand('layers.selectFirstChild')?.match(event)) {
        if (useEditorStore.getState().enterSelectedInstance()) {
          event.preventDefault()
          event.stopPropagation()
        }
      }
    }

    // ── Bubble: Escape deselects; Enter/⇧Enter walk the tree; ⌘R renames ──
    const onDeselectKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return

      // Resolve INTENT first, from the registry, before touching the store or
      // the DOM. This listener is on `document` and sees every keystroke in
      // the app, so an ordinary letter must cost three pure `match` predicates
      // and nothing else — not a `getState()` and a `closest()` walk.
      //
      // Plain Enter only reaches here when the capture branch above did NOT
      // claim it (i.e. the selection isn't an un-entered `studio.instance`),
      // so "step into an instance" and "select the first child" share one key
      // without either shadowing the other.
      const intent =
        getKeybindingForCommand('layers.selectParent')?.match(event) ? 'selectParent'
        : getKeybindingForCommand('layers.selectFirstChild')?.match(event) ? 'selectFirstChild'
        : getKeybindingForCommand('layers.rename')?.match(event) ? 'rename'
        : event.key === 'Escape' ? 'deselect'
        : null
      if (!intent) return

      // Shared stand-downs, applied once for all four.
      if (useEditorStore.getState().activeInlineEdit) return
      if (isTextInputTarget(event.target)) return
      if (isInsideEscapeOwningOverlay(event.target)) return

      if (intent === 'selectParent') {
        if (useEditorStore.getState().selectParentNode()) event.preventDefault()
        return
      }
      if (intent === 'selectFirstChild') {
        if (useEditorStore.getState().selectFirstChildNode()) event.preventDefault()
        return
      }
      if (intent === 'rename') {
        // preventDefault is load-bearing: without it Cmd/Ctrl+R reloads the
        // browser and the author loses the editor session.
        const nodeId = useEditorStore.getState().selectedNodeId
        if (!nodeId) return
        event.preventDefault()
        requestRename(nodeId)
        return
      }

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
