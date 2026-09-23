/**
 * useCanvasToolShortcuts — a `board` scope: the bare-letter tool keys
 * `V` `T` `F` `C` `H` `K` `R` `O`.
 *
 * `T` inserts a text node, `F` a container INSIDE the selection, `C` enters
 * comment mode. `K4` added four more: `H` latches the hand tool, `K` latches
 * the scale tool, and `R` / `O` insert a box — square, or round via
 * `border-radius: 50%` — BESIDE the selection. P2-B added `V` (IX-11): the
 * move tool, which puts EVERY armed tool away — hand, scale and comment — and
 * is the one key that always means "back to normal". Named after Figma's,
 * because that is where the muscle memory comes from.
 *
 * WHAT "INSERT" MEANS HERE, AND WHY IT IS NOT A DRAW GESTURE
 * ─────────────────────────────────────────────────────────
 * In Figma, T / F / R / O arm a tool you then drag a rectangle with, because a
 * Figma document is absolutely-positioned shapes. Studio's document is a real
 * React tree, so there is no rectangle to draw: a new node's position is
 * decided by its parent's layout, not by where the pointer went. So they
 * insert immediately and select the result, which is the state a drag would
 * have left you in anyway.
 *
 * `F` and `R`/`O` differ in WHERE, not in what: `F` goes through
 * `useInsertModule`'s default resolution (inside a container target — the same
 * place the module picker and right-click "Insert module here" land), while
 * `R`/`O` take `resolveSiblingAfterLocation` and land NEXT TO the selection.
 * A user watching a selected box expects the new one beside it; a user
 * reaching for "frame" expects to nest. Both are real, so both have a key.
 *
 * WHY THE TWO LATCHED TOOLS TOGGLE ON THEIR OWN KEY
 * ─────────────────────────────────────────────────
 * Escape is not reliably available: the `node` rung above this one claims it
 * whenever anything is selected (`editorKeyDispatcher.ts`), so a user with a
 * selection would press Escape, watch the selection clear, and still be stuck
 * in the hand tool. Pressing `H` again is always the way out. Escape DOES
 * disarm as a second chance, below, for the case where nothing is selected.
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
import { selectActiveCanvasPage, useEditorStore } from '@site/store/store'
import { resolveSiblingAfterLocation } from '@site/store/insertLocation'
import { getKeybindingForCommand } from '@admin/spotlight/keybindings'
import { useInsertModule } from '@site/hooks/useInsertModule'
import { isTextInputTarget } from './editorKeyGuards'
import { useEditorKeyScope } from './useEditorKeyDispatcher'

/** `T` and `F` — insert at `useInsertModule`'s default (inside a container target). */
const NESTING_INSERT_KEYS: ReadonlyArray<{ commandId: string; moduleId: string }> = [
  { commandId: 'tools.text', moduleId: 'base.text' },
  { commandId: 'tools.frame', moduleId: 'base.container' },
]

/**
 * `R` and `O` — insert a box as the NEXT SIBLING of the selection. `O` is the
 * same box made round, which is all an ellipse is in CSS. Keys are React-style
 * camelCase because that is what lands in `style={{ … }}`.
 */
const SIBLING_BOX_KEYS: ReadonlyArray<{
  commandId: string
  inlineStyles?: Record<string, string>
}> = [
  { commandId: 'tools.rectangle' },
  { commandId: 'tools.ellipse', inlineStyles: { borderRadius: '50%' } },
]

/** `H` and `K` — the two latched tools, each a toggle on its own key. */
const LATCHED_TOOL_KEYS: ReadonlyArray<{ commandId: string; tool: 'hand' | 'scale' }> = [
  { commandId: 'tools.hand', tool: 'hand' },
  { commandId: 'tools.scale', tool: 'scale' },
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

      // V — home. Not a toggle: pressing it with nothing armed is a no-op
      // that still claims the key, so a stray V never reaches the browser.
      if (getKeybindingForCommand('tools.move')?.match(event)) {
        event.preventDefault()
        const store = useEditorStore.getState()
        if (store.canvasTool !== 'move') store.setCanvasTool('move')
        if (store.commentToolActive) store.setCommentToolActive(false)
        return true
      }

      // Escape puts a latched tool away — the SECOND chance, not the first.
      // With anything selected the `node` rung claims Escape first (deselect),
      // which is why each tool also toggles on its own key.
      if (event.key === 'Escape') {
        const store = useEditorStore.getState()
        if (store.canvasTool === 'move') return false
        event.preventDefault()
        store.setCanvasTool('move')
        return true
      }

      // The latched tools are viewport/selection gestures, not edits, so they
      // are available to a read-only reviewer for the same reason `C` is.
      for (const { commandId, tool } of LATCHED_TOOL_KEYS) {
        if (!getKeybindingForCommand(commandId)?.match(event)) continue
        event.preventDefault()
        const store = useEditorStore.getState()
        store.setCanvasTool(store.canvasTool === tool ? 'move' : tool)
        return true
      }

      if (!editable) return false

      for (const { commandId, moduleId } of NESTING_INSERT_KEYS) {
        if (!getKeybindingForCommand(commandId)?.match(event)) continue
        const definition = registry.get(moduleId)
        if (!definition) return false
        event.preventDefault()
        insertModule(definition)
        return true
      }

      for (const { commandId, inlineStyles } of SIBLING_BOX_KEYS) {
        if (!getKeybindingForCommand(commandId)?.match(event)) continue
        const definition = registry.get('base.container')
        if (!definition) return false
        const store = useEditorStore.getState()
        const page = selectActiveCanvasPage(store)
        const anchorId = store.selectedNodeId ?? page?.rootNodeId
        if (!page || !anchorId) return false
        // Explicit location rather than `useInsertModule`'s default: the whole
        // difference between `R` and `F` is beside-vs-inside. `null` means the
        // anchor is orphaned, which is nothing to place against — fall through
        // rather than silently landing the box somewhere else.
        const location = resolveSiblingAfterLocation(page, anchorId)
        if (!location) return false
        event.preventDefault()
        insertModule(definition, location, inlineStyles ? { inlineStyles } : {})
        return true
      }

      return false
    },
  )
}
