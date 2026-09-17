/**
 * useCanvasToolShortcuts — a `board` scope: the bare-letter tool keys `T`, `F`,
 * `C`.
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
 * WHY IT IS A `board` SCOPE AND NOT A `node` ONE
 * ──────────────────────────────────────────────
 * The tool keys must keep working with a node selected — that is the normal
 * case, since the selection is what decides where the new node lands. The
 * `node` rung above simply never claims a bare letter, so these fall through to
 * it (`editorKeyDispatcher.ts`).
 *
 * The guards, in order, all of which have to hold:
 *   - No open inline text edit. Supplied by the dispatcher's `inline-edit`
 *     rung: the canvas edits text in a contenteditable host inside an iframe,
 *     and `isTextInputTarget` cannot see that when the event is retargeted at
 *     the iframe element itself.
 *   - `isTextInputTarget` — typing anywhere beats every tool key.
 *   - The registry's own `match`, which rejects all four modifiers, so ⌘C /
 *     ⌘T / ⌘F keep their native meanings.
 */
import { registry } from '@core/module-engine'
import { useEditorStore } from '@site/store/store'
import { getKeybindingForCommand } from '@admin/spotlight/keybindings'
import { useInsertModule } from '@site/hooks/useInsertModule'
import { isTextInputTarget } from './editorKeyGuards'
import { useEditorKeyScope } from './useEditorKeyDispatcher'

/** `T` and `F`, as (commandId, moduleId) pairs. */
const INSERT_KEYS: ReadonlyArray<{ commandId: string; moduleId: string }> = [
  { commandId: 'tools.text', moduleId: 'base.text' },
  { commandId: 'tools.frame', moduleId: 'base.container' },
]

export function useCanvasToolShortcuts(editable: boolean, isLive: boolean): void {
  const insertModule = useInsertModule()

  useEditorKeyScope(
    'board',
    () => !isLive,
    (event) => {
      if (isTextInputTarget(event.target)) return false

      // `C` works for a read-only reviewer: commenting is not a structural
      // edit, and the Client role (`site.content.edit` only) is exactly who
      // this shortcut is for. Inserting nodes is not, hence the `editable`
      // gate below it.
      if (getKeybindingForCommand('tools.comment')?.match(event)) {
        event.preventDefault()
        const store = useEditorStore.getState()
        store.setCommentToolActive(!store.commentToolActive)
        return true
      }

      if (!editable) return false

      for (const { commandId, moduleId } of INSERT_KEYS) {
        if (!getKeybindingForCommand(commandId)?.match(event)) continue
        const definition = registry.get(moduleId)
        if (!definition) return false
        event.preventDefault()
        insertModule(definition)
        return true
      }
      return false
    },
  )
}
