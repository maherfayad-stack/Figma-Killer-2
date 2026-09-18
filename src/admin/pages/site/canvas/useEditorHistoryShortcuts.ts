/**
 * useEditorHistoryShortcuts — the `global` scope: ⌘Z / ⌘⇧Z (and the Ctrl+Y
 * Windows alias, folded into `editor.redo`'s own `match`).
 *
 * The lowest rung of the ladder on purpose: undo is what you get when nothing
 * more specific claimed the keystroke.
 *
 * ## The routing rule this owns
 *
 * Whoever has an edit IN PROGRESS owns the keystroke — `hasPendingTextEdit`,
 * not a blanket "any editable target wins". The blanket version made the
 * editor's undo unreachable from the keyboard for as long as the caret sat in a
 * Properties-panel field, and since every style row is prefilled and every
 * field keeps focus after its commit, that was most of the time. See
 * `pendingTextEdit.ts`, and `src/__tests__/canvas/undoShortcutRouting.test.tsx`
 * which pins all three cases.
 *
 * ## Why it moved off `UndoRedoButtons`
 *
 * The listener used to live in that component's effect, which coupled "can I
 * undo with the keyboard" to "is the canvas notch rendered", and — worse —
 * meant undo/redo were the ONE canvas keystroke pair not standing down during
 * an inline text edit. `useIframeEventForwarding` happened to cover it by not
 * forwarding mid-session, but a ⌘Z pressed while focus sat in the parent
 * document still ran the store `undo()` while the contentEditable DOM kept the
 * text — after which the store and the DOM never agree again. On the ladder,
 * the `inline-edit` rung halts it by construction.
 *
 * `editor.undo`/`editor.redo` are listed in `shortcutDispatch.ts`'s
 * `COMPONENT_OWNED_SHORTCUTS`, so the spotlight dispatcher deliberately does
 * not also fire them — this is their only handler.
 */
import { useUndo, useRedo } from '@site/store/store'
import { getKeybindingForCommand } from '@admin/spotlight/keybindings'
import { hasPendingTextEdit } from './pendingTextEdit'
import { useEditorKeyScope } from './useEditorKeyDispatcher'

export function useEditorHistoryShortcuts(): void {
  const undo = useUndo()
  const redo = useRedo()

  useEditorKeyScope(
    'global',
    () => true,
    (event) => {
      if (hasPendingTextEdit(event.target)) return false

      if (getKeybindingForCommand('editor.undo')?.match(event)) {
        event.preventDefault()
        undo()
        return true
      }
      // `editor.redo`'s own `match` also accepts Ctrl/Cmd+Y (the
      // Windows/Linux redo alias) — see that binding's comment in
      // `keybindings.ts`. No inline key-combo check belongs here; the registry
      // is the single source for what counts as "redo".
      if (getKeybindingForCommand('editor.redo')?.match(event)) {
        event.preventDefault()
        redo()
        return true
      }
      return false
    },
  )
}
