/**
 * useBoardAnnotationKeyboard — the `annotation` scope: Delete / ⌘D / ⌘C / ⌘V /
 * arrow-nudge for the selected sticky notes and doc cards.
 *
 * Scoped by INTENT, not focus — it is inert unless annotations are actually
 * selected (or, for paste, unless the annotation clipboard has something in
 * it). That is what keeps it from stealing keys from every other surface.
 *
 * ## Why it sits ABOVE `node` and `board` on the ladder
 *
 * A marquee can leave notes AND frames selected at once. The rule
 * `useBoardFrameNudge` used to document as "mounted AFTER the annotation hook
 * on purpose" is now the ladder itself (`editorKeyDispatcher.ts`): a mixed
 * selection nudges the ANNOTATIONS only. Accepted, and unchanged — the two are
 * separate selection lists with separate inspectors, and silently moving
 * furniture the user did not see selected is worse than moving less than they
 * asked.
 *
 * The node-tree equivalents of these shortcuts live in `useCanvasNodeShortcuts`
 * on the `node` rung below.
 *
 * The keyup that ends an arrow-nudge undo burst (`store-09`) is broadcast by
 * `useBoardFrameNudge`'s registration — `endBoardGesture` is one idempotent
 * store call for both selection kinds, and the dispatcher delivers keyup to
 * every registered scope regardless of which one is active.
 */
import { useEditorStore } from '@site/store/store'
import { getKeybindingForCommand, nudgeDelta } from '@admin/spotlight/keybindings'
import { isInsideKeyOwningOverlay, isTextInputTarget } from './editorKeyGuards'
import { useEditorKeyScope } from './useEditorKeyDispatcher'

/** Registers the scope. Inert while live, read-only, or with nothing to act on. */
export function useBoardAnnotationKeyboard(editable: boolean, isLive: boolean): void {
  useEditorKeyScope(
    'annotation',
    () => {
      if (isLive || !editable) return false
      const state = useEditorStore.getState()
      if (state.selectedAnnotations.length > 0) return true
      // Paste is the one action that works with NOTHING selected — the
      // clipboard is what it needs, not a selection.
      const clipboard = state.annotationClipboard
      return clipboard.notes.length > 0 || clipboard.docs.length > 0
    },
    (event) => {
      if (isTextInputTarget(event.target)) return false
      if (isInsideKeyOwningOverlay(event.target)) return false

      const state = useEditorStore.getState()
      const hasSelection = state.selectedAnnotations.length > 0
      const mod = event.metaKey || event.ctrlKey

      if (mod && event.key.toLowerCase() === 'v') {
        const clipboard = state.annotationClipboard
        if (clipboard.notes.length === 0 && clipboard.docs.length === 0) return false
        event.preventDefault()
        state.pasteAnnotations()
        return true
      }

      if (!hasSelection) return false

      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault()
        state.deleteSelectedAnnotations()
        return true
      }

      if (mod && event.key.toLowerCase() === 'd') {
        event.preventDefault()
        state.duplicateSelectedAnnotations()
        return true
      }

      // `!event.shiftKey` is load-bearing, and it is what the ladder made
      // necessary: ⌘⇧C is `export.copySelectionPng` on the `board` rung BELOW
      // this one, so without the guard a copy-as-PNG press would be swallowed
      // here as "copy the sticky note". It used to be saved by mount order —
      // `useCopyAsPngShortcut` registered first and left the event
      // `defaultPrevented`. The same guard already lives on `layers.copy`'s
      // own `match` in the registry, for the same reason.
      if (mod && !event.shiftKey && event.key.toLowerCase() === 'c') {
        event.preventDefault()
        state.copySelectedAnnotations()
        return true
      }

      // The registry's one arrow binding (`canvas.moveSelection`) — it keeps
      // ⌥↑/⌥↓ out, which this hook's own copy of the arrow table did not.
      if (!getKeybindingForCommand('canvas.moveSelection')?.match(event)) return false
      const delta = nudgeDelta(event)
      if (!delta) return false
      event.preventDefault()
      state.nudgeSelectedAnnotations(delta.dx, delta.dy)
      return true
    },
  )
}
