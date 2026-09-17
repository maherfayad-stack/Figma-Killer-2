/**
 * useBoardFrameNudge — a `board` scope: arrow keys move the SELECTED BOARD
 * FRAMES by 1 board unit, or 10 with Shift (`viewport-01`, `board.nudgeFrames`).
 *
 * ## Why frames and not nodes
 *
 * A board frame's `x`/`y` are board-layout data in `.studio/boards.json` —
 * moving one is a first-class canvas gesture with an existing store action
 * (`nudgeSelectedFrames`, built on the same pure `moveFrame` transform the drag
 * path uses). A NODE has no canvas position at all: nudging one would mean
 * synthesising a CSS `transform`/`top`/`left` write into the user's stylesheet,
 * which is a style edit with its own writability gate and refusal story. That
 * is deliberately out of scope — the arrows stay unclaimed with a node
 * selected, which is also what keeps a future "select previous/next sibling"
 * binding available (see `keybindings.ts`).
 *
 * ## Ordering
 *
 * A mixed marquee selection (frames AND annotations) nudges the annotations
 * only, because `annotation` sits above `board` on the ladder. That used to be
 * expressed as "mounted AFTER the annotation hook on purpose" in `CanvasRoot`;
 * it is now a property of the ladder and cannot be undone by moving a hook
 * call. See `editorKeyDispatcher.ts`.
 *
 * ## Undo (`store-09`)
 *
 * A nudge IS undoable. One key-HOLD (keydown auto-repeat) coalesces into a
 * single entry; the keyup broadcast below closes the burst so the next hold is
 * its own ⌘Z step. It is registered here for BOTH selection kinds —
 * `endBoardGesture` is one idempotent store call, the dispatcher delivers keyup
 * to every registered scope, and duplicating it on the annotation scope would
 * be two calls for one release.
 */
import { useEditorStore } from '@site/store/store'
import { frameNudgeDelta, getKeybindingForCommand } from '@admin/spotlight/keybindings'
import { isInsideKeyOwningOverlay, isTextInputTarget } from './editorKeyGuards'
import { useEditorKeyScope } from './useEditorKeyDispatcher'

/** Registers the scope. Inert while live, read-only, or with no frame selected. */
export function useBoardFrameNudge(editable: boolean, isLive: boolean): void {
  useEditorKeyScope(
    'board',
    () => !isLive && editable && useEditorStore.getState().selectedFrameIds.length > 0,
    (event) => {
      const binding = getKeybindingForCommand('board.nudgeFrames')
      if (!binding?.match(event)) return false
      if (isTextInputTarget(event.target)) return false
      if (isInsideKeyOwningOverlay(event.target)) return false

      const delta = frameNudgeDelta(event)
      if (!delta) return false

      event.preventDefault()
      useEditorStore.getState().nudgeSelectedFrames(delta.dx, delta.dy)
      return true
    },
    // Unconditional: releasing ANY key means the hold is over, and
    // `endBoardGesture` is a no-op when no burst is open. See `boardHistory.ts`.
    () => useEditorStore.getState().endBoardGesture(),
  )
}
