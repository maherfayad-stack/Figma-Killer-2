/**
 * useBoardFrameNudge — arrow keys move the SELECTED BOARD FRAMES by 1 board
 * unit, or 10 with Shift (`viewport-01`, `board.nudgeFrames`).
 *
 * ## Why frames and not nodes
 *
 * A board frame's `x`/`y` are board-layout data in `.studio/boards.json` —
 * moving one is a first-class canvas gesture with an existing store action
 * (`nudgeSelectedFrames`, built on the same pure `moveFrame` transform the
 * drag path uses). A NODE has no canvas position at all: nudging one would
 * mean synthesising a CSS `transform`/`top`/`left` write into the user's
 * stylesheet, which is a style edit with its own writability gate and refusal
 * story. That is deliberately out of scope here — the arrows stay unclaimed
 * with a node selected, which is also what keeps a future "select
 * previous/next sibling" binding available (see `keybindings.ts`).
 *
 * ## Why a document listener, scoped by intent
 *
 * Same reason `useBoardAnnotationKeyboard` and `useCanvasSelectionKeyboard`
 * give at length: a React `onKeyDown` on the canvas div only fires while a
 * canvas descendant holds DOM focus, and selecting a frame opens the
 * inspector — one click in there and the shortcut would be dead for the rest
 * of the session. So this listens on `document` and stands down unless board
 * frames are actually selected.
 *
 * It also stands down for a text field, an open dialog / menu / listbox, an
 * active inline text edit, and an already-claimed keystroke. That last one is
 * what makes the ordering in `CanvasRoot` matter: `useBoardAnnotationKeyboard`
 * is mounted first and `preventDefault`s arrows when notes/docs are selected,
 * so a mixed marquee selection (frames AND annotations) nudges the annotations
 * only. Accepted: the two are separate selection lists with separate
 * inspectors, and silently moving furniture the user did not see selected is
 * worse than moving less than they asked.
 *
 * Undo (`store-09`): a nudge IS undoable. One key-HOLD (keydown auto-repeat)
 * coalesces into a single entry; the `keyup` below closes the burst so the next
 * hold is its own ⌘Z step.
 */
import { useEffect } from 'react'
import { useEditorStore } from '@site/store/store'
import { frameNudgeDelta, getKeybindingForCommand } from '@admin/spotlight/keybindings'
import { isTextInputTarget } from './useCanvasKeyboardShortcuts'

/** Overlays that own the keyboard while open — mirrors `useBoardAnnotationKeyboard`'s list. */
const OVERLAY_SELECTOR = '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"]'

function isInsideOverlay(target: EventTarget | null): boolean {
  const element = target instanceof Element ? target : document.activeElement
  return element instanceof Element && element.closest(OVERLAY_SELECTOR) !== null
}

/** Mounts the listener. No-op while live, read-only, or with no frame selected. */
export function useBoardFrameNudge(editable: boolean, isLive: boolean): void {
  useEffect(() => {
    if (isLive || !editable) return
    const binding = getKeybindingForCommand('board.nudgeFrames')
    if (!binding) return

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      if (!binding.match(event)) return
      if (isTextInputTarget(event.target)) return
      if (isInsideOverlay(event.target)) return

      const state = useEditorStore.getState()
      if (state.activeInlineEdit) return
      if (state.selectedFrameIds.length === 0) return

      const delta = frameNudgeDelta(event)
      if (!delta) return

      event.preventDefault()
      state.nudgeSelectedFrames(delta.dx, delta.dy)
    }

    // A key RELEASE ends the nudge burst — see `boardHistory.ts`. Unconditional
    // (no binding match): releasing any key means the hold is over, and
    // `endBoardGesture` is a no-op when no burst is open.
    const onKeyUp = () => useEditorStore.getState().endBoardGesture()

    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('keyup', onKeyUp)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('keyup', onKeyUp)
    }
  }, [editable, isLive])
}
