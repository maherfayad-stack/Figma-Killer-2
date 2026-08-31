/**
 * useCanvasToolShortcuts — the bare-letter tool keys: `T`, `F`, `C`.
 *
 * `T` inserts a text node, `F` a container, `C` enters comment mode. Named
 * after Figma's, because that is where the muscle memory comes from.
 *
 * WHAT "INSERT" MEANS HERE, AND WHY IT IS NOT A DRAW GESTURE
 * ─────────────────────────────────────────────────────────
 * In Figma, T and F arm a tool you then drag a rectangle with, because a Figma
 * document is absolutely-positioned shapes. Studio's document is a real React
 * tree, so there is no rectangle to draw: a new node's position is decided by
 * its parent's layout, not by where the pointer went. So T and F insert
 * immediately at the same place the module picker and right-click "Insert
 * module here" would — `useInsertModule` resolves it, so all three routes
 * agree — and select the result, which is the state a drag would have left you
 * in anyway.
 *
 * DOCUMENT-LEVEL, NOT A REACT `onKeyDown`
 * ───────────────────────────────────────
 * Same reason `useCanvasSelectionKeyboard` and `board.selectAllFrames` are:
 * a React handler on the canvas div only fires while a canvas descendant holds
 * DOM focus, and one click into any panel silently kills the shortcut. These
 * are scoped by INTENT (`isTextInputTarget`, `activeInlineEdit`) rather than
 * by focus.
 *
 * The guards, in order, all of which have to hold:
 *   - `event.defaultPrevented` — someone nearer the event already handled it.
 *   - An open inline text edit. The canvas edits text in a contenteditable
 *     host inside an iframe; `isTextInputTarget` catches that when the event
 *     target is reachable, and this catches it when the event is retargeted at
 *     the iframe element itself.
 *   - `isTextInputTarget` — typing anywhere beats every tool key.
 *   - The registry's own `match`, which rejects all four modifiers, so ⌘C /
 *     ⌘T / ⌘F keep their native meanings.
 */
import { useEffect } from 'react'
import { registry } from '@core/module-engine'
import { useEditorStore } from '@site/store/store'
import { getKeybindingForCommand } from '@admin/spotlight/keybindings'
import { useInsertModule } from '@site/hooks/useInsertModule'
import { isTextInputTarget } from './useCanvasKeyboardShortcuts'

/** `T` and `F`, as (commandId, moduleId) pairs. */
const INSERT_KEYS: ReadonlyArray<{ commandId: string; moduleId: string }> = [
  { commandId: 'tools.text', moduleId: 'base.text' },
  { commandId: 'tools.frame', moduleId: 'base.container' },
]

export function useCanvasToolShortcuts(editable: boolean, isLive: boolean): void {
  const insertModule = useInsertModule()

  useEffect(() => {
    if (isLive) return undefined

    const commentBinding = getKeybindingForCommand('tools.comment')
    const insertBindings = INSERT_KEYS.map((entry) => ({
      ...entry,
      binding: getKeybindingForCommand(entry.commandId),
    }))

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      if (useEditorStore.getState().activeInlineEdit) return
      if (isTextInputTarget(event.target)) return

      // `C` works for a read-only reviewer: commenting is not a structural
      // edit, and the Client role (`site.content.edit` only) is exactly who
      // this shortcut is for. Inserting nodes is not, hence the `editable`
      // gate below it.
      if (commentBinding?.match(event)) {
        event.preventDefault()
        const store = useEditorStore.getState()
        store.setCommentToolActive(!store.commentToolActive)
        return
      }

      if (!editable) return

      for (const { moduleId, binding } of insertBindings) {
        if (!binding?.match(event)) continue
        const definition = registry.get(moduleId)
        if (!definition) return
        event.preventDefault()
        insertModule(definition)
        return
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [editable, isLive, insertModule])
}
