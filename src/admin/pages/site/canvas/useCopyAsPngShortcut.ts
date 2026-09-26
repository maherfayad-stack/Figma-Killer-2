/**
 * useCopyAsPngShortcut — a `board` scope: ⌘⇧C / Ctrl+Shift+C puts a PNG of the
 * selection on the clipboard.
 *
 * The capture and the clipboard write are `copyAsPng.ts`'s — shared with the
 * empty-selection panel's button (P5-F, UX-9); this hook is the key.
 *
 * Scoped by INTENT rather than by focus, for the reason
 * `useBoardSelectAllShortcut` is: this shortcut has to work while the user is
 * looking at the Properties panel. Three things stand it down, in the order
 * they are cheapest to check (`defaultPrevented` and an open inline edit are
 * the dispatcher's job now):
 *
 *   - a text field holding an UNCOMMITTED draft (`hasPendingTextEdit`) — the
 *     exact rule `editorHistoryShortcuts` follows for ⌘Z, and for the same
 *     reason: whoever has an edit in progress owns the keystroke;
 *   - any input / textarea / contenteditable target (`isTextInputTarget`),
 *     where ⌘⇧C may mean something to the browser.
 *
 * Note `hasPendingTextEdit` is checked SEPARATELY from `isTextInputTarget`
 * even though the second subsumes the first here. It is not redundant
 * documentation: it is the assertion the routing test pins, so a later
 * loosening of the field guard (to make ⌘⇧C reachable from a parked-but-clean
 * inspector field, the way ⌘Z already is) cannot silently start firing
 * mid-draft.
 */
import { getKeybindingForCommand } from '@admin/spotlight/keybindings'
import { copySelectionAsPng } from './copyAsPng'
import { hasPendingTextEdit } from './pendingTextEdit'
import { isTextInputTarget } from './editorKeyGuards'
import { useEditorKeyScope } from './useEditorKeyDispatcher'

export function useCopyAsPngShortcut(isLive: boolean): void {
  useEditorKeyScope(
    'board',
    // Not gated on `editable`: copying a screen as an image reads the board, it
    // never writes to it, so a read-only board is still worth photographing.
    () => !isLive,
    (event) => {
      if (!getKeybindingForCommand('export.copySelectionPng')?.match(event)) return false
      if (hasPendingTextEdit(event.target)) return false
      if (isTextInputTarget(event.target)) return false

      // Claimed before any async work: the browser's own ⌘⇧C must not also run,
      // and a refusal is still this shortcut answering, not nothing.
      event.preventDefault()
      copySelectionAsPng()
      return true
    },
  )
}
