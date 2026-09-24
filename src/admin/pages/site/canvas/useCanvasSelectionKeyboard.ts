/**
 * useCanvasSelectionKeyboard — the `node` scope's FIRST handler, and the ONE
 * owner of Enter, ⇧Enter, Escape, ⌘R, Tab / ⇧Tab and ⌘A for the canvas
 * selection. It is therefore the whole "how do I get back to nothing
 * selected" ladder:
 *
 *   1. `Enter` with a `studio.instance` selected steps INTO it (WS-4.2).
 *   2. `Enter` on a text layer starts typing into it — the double-click
 *      path (P5-E, IX-7). Portal frames only: a live frame's text edit is
 *      started by its own runtime.
 *   3. `Enter` otherwise selects EVERY child of the selection — Penpot's
 *      and Figma's "step into" (`layers.selectChildren`; viewport-01 took
 *      the first child only).
 *   4. `⇧Enter` selects the PARENT of every selected layer
 *      (`layers.selectParent`).
 *   5. `Escape` inside an entered instance steps back OUT one level.
 *   6. `Escape` with anything else selected clears EVERY selection — nodes,
 *      board frames, sticky notes / doc cards — and leaves Visual Component
 *      mode. All in one press: they are independent lists (a marquee can leave
 *      frames and annotations selected at once), so clearing a subset would
 *      leave the board looking deselected while Delete still had a target.
 *   7. `⌘R` opens the canvas rename dialog on the anchor (`layers.rename`).
 *   8. `Tab` / `⇧Tab` select the next / previous sibling, wrapping (IX-3) —
 *      ONLY while focus is on the canvas, a frame, or nowhere
 *      (`isCanvasKeyboardSurface`). Inside a panel Tab walks the fields,
 *      and taking that away is an accessibility regression, not a shortcut.
 *   9. `⌘A` selects the anchor's siblings; again, it climbs a level (IX-4).
 *      At the tree root there is no node level left, so it hands over to the
 *      board's "every frame" (`useBoardSelectAllShortcut`'s meaning). It
 *      claims the key whenever a node is selected: before P2-B nobody did, and
 *      the browser selected the admin chrome's text instead.
 *
 * **Escape stays "deselect", it does NOT become "select parent"** (viewport-01).
 * Figma binds ⇧Enter for that and Esc for deselect, and rung 5 above is the
 * fix `select-01` shipped for a reported "I can't deselect after selecting"
 * bug — turning one press into N presses for a deeply nested node would
 * re-open it. The traversal took Figma's own keys instead.
 *
 * ## Phases are gone; the ladder replaced them
 *
 * This used to be TWO `document` listeners: a CAPTURE one for the instance
 * step-in/step-out that `stopPropagation`d when it claimed, and a BUBBLE one
 * for everything else. The capture phase existed only to guarantee the
 * step-out ran before any handler that would clear the selection
 * (`instance-ui-01` proved ordering mattered in a browser). Both are now one
 * handler whose branches run in the documented order, on the single dispatcher
 * listener — which is a stronger guarantee than a phase, because it does not
 * depend on which listener was registered first.
 *
 * It is registered BEFORE `useCanvasNodeShortcuts` on the same `node` rung, so
 * Enter / Escape / ⌘R are decided before Delete / ⌘D / clipboard are even
 * considered. The two sets do not overlap, so the order is documentation
 * rather than arbitration — but it is the order `CanvasRoot` mounts them in,
 * deliberately.
 */
import { useEditorStore } from '@site/store/store'
import { getKeybindingForCommand } from '@admin/spotlight/keybindings'
import { isDrawTool } from './canvasDrawTool'
import { startCanvasTextEdit } from './canvasTextEditStart'
import { isCanvasKeyboardSurface, isInsideKeyOwningOverlay, isTextInputTarget } from './editorKeyGuards'
import { useEditorKeyScope } from './useEditorKeyDispatcher'

/**
 * Rung 2 — Enter on ONE text layer types into it, exactly as a double-click
 * does (`canvasTextEditStart.ts` decides; a live frame's text is its runtime's).
 */
function startTextEditOnEnter(): boolean {
  const state = useEditorStore.getState()
  if (!state.selectedNodeId || state.selectedNodeIds.length > 1) return false
  return startCanvasTextEdit(state.selectedNodeId)
}

/**
 * Registers the scope. Inert while live or read-only.
 *
 * `openRenameDialog` is `useCanvasRenameDialog`'s `open` — the canvas's own
 * rename flow, the same one the right-click menu drives. It is called straight
 * out of the handler: `useEditorKeyScope` already routes `handle` through a
 * `useEffectEvent`, so the closure always sees the latest `open` AND the
 * registration effect never re-runs just because the dialog's local state
 * changed identity. The explicit `useEffectEvent` this hook used to keep for
 * that purpose is now that wrapper's job.
 */
export function useCanvasSelectionKeyboard(
  editable: boolean,
  isLive: boolean,
  openRenameDialog: (nodeId: string) => void,
): void {
  useEditorKeyScope(
    'node',
    () => !isLive && editable,
    (event) => {
      // ── Step into / out of an instance ────────────────────────────────
      if (isTextInputTarget(event.target)) return false

      if (event.key === 'Escape') {
        // Only claims the keystroke when something is actually entered —
        // otherwise falls through to the deselect branch below, unchanged.
        if (useEditorStore.getState().exitInstance()) {
          event.preventDefault()
          return true
        }
      } else if (getKeybindingForCommand('layers.selectChildren')?.match(event)) {
        // P5-E — with a draw tool armed, ⏎ is "insert at the selection", the
        // board rung's (`useCanvasToolShortcuts`), so a keyboard-only user is
        // never stranded by an armed tool.
        if (isDrawTool(useEditorStore.getState().canvasTool)) return false
        // PLAIN Enter only — matched through the registry so ⇧Enter (select
        // parent) can never be swallowed here. A bare `event.key === 'Enter'`
        // test did exactly that once ⇧Enter existed.
        if (useEditorStore.getState().enterSelectedInstance()) {
          event.preventDefault()
          return true
        }
        // A menu or dialog owns its own Enter.
        if (!isInsideKeyOwningOverlay(event.target) && startTextEditOnEnter()) {
          event.preventDefault()
          return true
        }
      }

      // ── Escape deselects; Enter/⇧Enter walk the tree; ⌘R renames ───────
      //
      // Resolve INTENT first, from the registry, before touching the store or
      // the DOM. The dispatcher sees every keystroke in the app, so an
      // ordinary letter must cost three pure `match` predicates and nothing
      // else — not a `getState()` and a `closest()` walk.
      //
      // Plain Enter only reaches here when the instance branch above did NOT
      // claim it (i.e. the selection isn't an un-entered `studio.instance`),
      // so "step into an instance", "edit this text" and "select the children" share one key
      // without either shadowing the other.
      const intent =
        getKeybindingForCommand('layers.selectParent')?.match(event) ? 'selectParent'
        : getKeybindingForCommand('layers.selectChildren')?.match(event) ? 'selectChildren'
        : getKeybindingForCommand('layers.rename')?.match(event) ? 'rename'
        : getKeybindingForCommand('layers.selectNextSibling')?.match(event) ? 'nextSibling'
        : getKeybindingForCommand('layers.selectPreviousSibling')?.match(event) ? 'previousSibling'
        : getKeybindingForCommand('canvas.selectAll')?.match(event) ? 'selectAll'
        : event.key === 'Escape' ? 'deselect'
        : null
      if (!intent) return false

      // An overlay that owns Escape itself keeps it — clearing the canvas
      // selection underneath an open modal is never what the user asked for.
      if (isInsideKeyOwningOverlay(event.target)) return false

      if (intent === 'nextSibling' || intent === 'previousSibling') {
        // Canvas-scoped (rung 7 above): a panel keeps Tab for focus order.
        if (!isCanvasKeyboardSurface(event)) return false
        const store = useEditorStore.getState()
        if (!store.selectedNodeId) return false
        // Claimed even when there is no sibling to move to: the canvas owns
        // Tab here, and letting it through would walk focus out of the canvas.
        event.preventDefault()
        store.selectSiblingNode(intent === 'nextSibling' ? 'next' : 'previous')
        return true
      }

      if (intent === 'selectAll') {
        const store = useEditorStore.getState()
        // Nothing selected: the board rung's "every frame" is the meaning.
        if (!store.selectedNodeId) return false
        event.preventDefault()
        if (!store.selectAllSiblingNodes()) store.selectAllFrames()
        return true
      }

      if (intent === 'selectParent') {
        if (!useEditorStore.getState().selectParentNode()) return false
        event.preventDefault()
        return true
      }
      if (intent === 'selectChildren') {
        if (!useEditorStore.getState().selectChildNodes()) return false
        event.preventDefault()
        return true
      }
      if (intent === 'rename') {
        // preventDefault is load-bearing: without it Cmd/Ctrl+R reloads the
        // browser and the author loses the editor session.
        const nodeId = useEditorStore.getState().selectedNodeId
        if (!nodeId) return false
        event.preventDefault()
        openRenameDialog(nodeId)
        return true
      }

      const state = useEditorStore.getState()
      const hasSelection =
        state.selectedNodeId !== null ||
        state.selectedFrameIds.length > 0 ||
        state.selectedAnnotations.length > 0
      const inVisualComponentMode = state.activeDocument?.kind === 'visualComponent'
      // Nothing to clear — leave the keystroke for whoever else wants it.
      if (!hasSelection && !inVisualComponentMode) return false

      event.preventDefault()
      state.clearAllSelections()
      // Escape has always doubled as "leave VC canvas mode" (SF-1 / CR #666),
      // in the same press as the clear.
      if (inVisualComponentMode) state.setActiveDocument(null)
      return true
    },
  )
}
