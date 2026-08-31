/**
 * useBoardSelectAllShortcut — ⌘/Ctrl+A selects every frame on the active board.
 *
 * `board-02`: this was originally handled inside `useCanvasKeyboardShortcuts`,
 * a React `onKeyDown` on the canvas div — which only fires while a descendant
 * of the canvas holds DOM focus. The moment the user touched any panel, focus
 * moved there, this handler never saw the key, and the browser's native
 * select-all ran instead (the reported bug: "ctrl A selects text in the canvas
 * panels not in the canvas itself"). Fixed by scoping on INTENT rather than
 * focus: a document-level listener that fires regardless of which panel holds
 * focus, standing down only for
 *
 *   - an editable field (`isTextInputTarget` — input / textarea /
 *     contenteditable, which covers a panel text field, the DOM tree's rename
 *     input, and a code editor's contenteditable surface alike), or
 *   - an active inline text edit, or
 *   - a node already being selected. Node selection has no "select all" of
 *     its own (WS-7.1), so this only ever competes with the browser's native
 *     select-all.
 *
 * It lives in its own file for the same reason `useCanvasSelectionKeyboard`,
 * `useBoardAnnotationKeyboard` and `useCanvasToolShortcuts` do: they are all
 * the same shape — one document-level keydown listener, scoped by intent —
 * and keeping them inline was what pushed `CanvasRoot` onto its size ceiling.
 */
import { useEffect } from 'react'
import { useEditorStore } from '@site/store/store'
import { getKeybindingForCommand } from '@admin/spotlight/keybindings'
import { isTextInputTarget } from './useCanvasKeyboardShortcuts'

export function useBoardSelectAllShortcut(editable: boolean, isLive: boolean): void {
  useEffect(() => {
    if (isLive || !editable) return undefined
    const selectAllBinding = getKeybindingForCommand('board.selectAllFrames')
    if (!selectAllBinding) return undefined

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      if (useEditorStore.getState().activeInlineEdit) return
      if (!selectAllBinding.match(event)) return
      if (isTextInputTarget(event.target)) return
      if (useEditorStore.getState().selectedNodeId) return

      event.preventDefault()
      useEditorStore.getState().selectAllFrames()
    }

    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [editable, isLive])
}
