/**
 * useCanvasLayerCommandKeys — the `node` rung's handler for P5-E's layer
 * commands: ⌥A ⌥D ⌥W ⌥S ⌥H ⌥V align (IX-20), ⌘⇧] / ⌘⇧[ front / back (IX-9),
 * ⇧A flex layout (IX-10), ⌘⌥C / ⌘⌥V copy / paste style (IX-props).
 *
 * Scoped by INTENT (a layer is selected), like Delete in
 * `useCanvasNodeShortcuts`, so the keys work after a click into the
 * inspector. The same guards: an inline text edit (the dispatcher's
 * `inline-edit` rung), typing in a field, a menu or dialog that owns its keys.
 *
 * A separate handler rather than more branches in `useCanvasNodeShortcuts`:
 * that file is the clipboard's (P5-A owns ⌘V there), and none of these keys
 * overlap it — `layers.copy` / `layers.paste` reject ⌥ since P5-E, so ⌘⌥C and
 * ⌘⌥V can only mean style.
 */
import type { AlignEdge } from '@ui/components/AlignBar'
import { useEditorStore } from '@site/store/store'
import { getKeybindingForCommand } from '@admin/spotlight/keybindings'
import { ALIGN_COMMANDS } from '@admin/spotlight/keybindingLayerCommands'
import { isInsideKeyOwningOverlay, isTextInputTarget } from './editorKeyGuards'
import { alignSelection } from './layerAlign'
import { copySelectionStyle, moveSelectionToEnd, pasteSelectionStyle, toggleFlexLayout } from './layerCommands'
import { useEditorKeyScope } from './useEditorKeyDispatcher'

/** The keyboard's command, if `event` is one of them. Registry order; first match wins. */
function commandFor(event: KeyboardEvent): (() => void) | null {
  for (const { commandId, edge } of ALIGN_COMMANDS) {
    if (getKeybindingForCommand(commandId)?.match(event)) return () => void alignSelection(edge as AlignEdge)
  }
  if (getKeybindingForCommand('layers.bringToFront')?.match(event)) return () => moveSelectionToEnd('front')
  if (getKeybindingForCommand('layers.sendToBack')?.match(event)) return () => moveSelectionToEnd('back')
  if (getKeybindingForCommand('layers.toggleFlexLayout')?.match(event)) return () => void toggleFlexLayout()
  if (getKeybindingForCommand('layers.copyStyle')?.match(event)) return copySelectionStyle
  if (getKeybindingForCommand('layers.pasteStyle')?.match(event)) return pasteSelectionStyle
  return null
}

export function useCanvasLayerCommandKeys(editable: boolean, isLive: boolean): void {
  useEditorKeyScope(
    'node',
    () => !isLive && editable && useEditorStore.getState().selectedNodeId !== null,
    (event) => {
      // Only a modified key can be one of these: a bare letter costs nothing.
      if (!event.altKey && !event.shiftKey && !event.metaKey && !event.ctrlKey) return false
      if (isTextInputTarget(event.target)) return false
      if (isInsideKeyOwningOverlay(event.target)) return false
      const run = commandFor(event)
      if (!run) return false
      // ⌥ + a letter would otherwise type a character in whatever has focus,
      // and ⌘⇧] is the browser's next-tab on some platforms.
      event.preventDefault()
      run()
      return true
    },
  )
}
