/**
 * useBoardSelectAllShortcut — a `board` scope: ⌘/Ctrl+A selects every frame on
 * the active board.
 *
 * `board-02`: this was originally a React `onKeyDown` on the canvas div, which
 * only fires while a descendant of the canvas holds DOM focus. The moment the
 * user touched any panel, focus moved there, the handler never saw the key, and
 * the browser's native select-all ran instead — the reported bug, "ctrl A
 * selects text in the canvas panels not in the canvas itself". Fixed by scoping
 * on INTENT rather than focus; the dispatcher now supplies the
 * focus-independent `document` listener that fix needs
 * (`useEditorKeyDispatcher.ts`).
 *
 * It stands down for an editable field, and whenever a node is selected: then
 * ⌘A means "the node's siblings" (P2-B, IX-4), which the `node` rung
 * (`useCanvasSelectionKeyboard`) answers first — and hands back to
 * `selectAllFrames` itself once the climb reaches the tree root. One binding,
 * `canvas.selectAll`, for the whole ladder.
 */
import { useEditorStore } from '@site/store/store'
import { getKeybindingForCommand } from '@admin/spotlight/keybindings'
import { isTextInputTarget } from './editorKeyGuards'
import { useEditorKeyScope } from './useEditorKeyDispatcher'

export function useBoardSelectAllShortcut(editable: boolean, isLive: boolean): void {
  useEditorKeyScope(
    'board',
    () => !isLive && editable && !useEditorStore.getState().selectedNodeId,
    (event) => {
      if (!getKeybindingForCommand('canvas.selectAll')?.match(event)) return false
      if (isTextInputTarget(event.target)) return false

      event.preventDefault()
      useEditorStore.getState().selectAllFrames()
      return true
    },
  )
}
