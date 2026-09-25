/**
 * useCanvasToolShortcuts — a `board` scope: the bare-letter tool keys
 * `V` `T` `F` `C` `H` `K` `R` `O` (`E`), and ⏎ while a draw tool is armed.
 *
 * `C` enters comment mode. `H` latches the hand tool and `K` the scale tool
 * (`K4`). `V` (IX-11) is the move tool: it puts EVERY armed tool away — hand,
 * scale, draw and comment — and is the one key that always means "back to
 * normal". Named after Figma's, because that is where the muscle memory comes
 * from.
 *
 * ## The draw tools (P5-E, IX-12, OD-5)
 *
 * `R`, `O` / `E`, `T` and `F` ARM a draw tool: a click or a drag inside a
 * frame then inserts a rectangle, an ellipse, a text or a frame where the
 * pointer lands (`CanvasDrawToolLayer`, `canvasDrawTool.ts`). They used to
 * insert at once, beside or inside the selection, because "there is no
 * rectangle to draw" in a React tree — but the drawn size IS a write (the
 * element's `width` / `height`), and the owner chose armed tools (OD-5).
 *
 * The immediate insert is still here, on ⏎: with a draw tool armed, ⏎ inserts
 * at the selection exactly as the letter used to — `T` / `F` inside a
 * container target (`useInsertModule`'s default), `R` / `O` as the NEXT
 * SIBLING of the selection — and puts the tool away. A keyboard-only user is
 * never stranded by an armed tool.
 *
 * ## Why every tool toggles on its own key
 *
 * Escape is not reliably available: the `node` rung above this one claims it
 * whenever anything is selected (`editorKeyDispatcher.ts`), so a user with a
 * selection would press Escape, watch the selection clear, and still be stuck
 * in the tool. Pressing the tool's key again is always the way out, and so is
 * V. Escape DOES disarm as a second chance, below, when nothing is selected.
 *
 * ## Why it is a `board` scope and not a `node` one
 *
 * The tool keys must keep working with a node selected — that is the normal
 * case. The `node` rung above simply never claims a bare letter, and gives ⏎
 * up while a draw tool is armed (`useCanvasSelectionKeyboard`).
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
import type { DrawTool } from '@site/store/slices/canvasSlice'
import { resolveSiblingAfterLocation } from '@site/store/insertLocation'
import { getKeybindingForCommand } from '@admin/spotlight/keybindings'
import { useInsertModule } from '@site/hooks/useInsertModule'
import { DRAW_TOOL_SPECS, isDrawTool } from './canvasDrawTool'
import { isTextInputTarget } from './editorKeyGuards'
import { useEditorKeyScope } from './useEditorKeyDispatcher'

/** The four keys that arm a draw tool — each a toggle on its own key. */
const DRAW_TOOL_KEYS: ReadonlyArray<{ commandId: string; tool: DrawTool }> = [
  { commandId: 'tools.rectangle', tool: 'rectangle' },
  { commandId: 'tools.ellipse', tool: 'ellipse' },
  { commandId: 'tools.text', tool: 'text' },
  { commandId: 'tools.frame', tool: 'frame' },
]

/** `H` and `K` — the two latched tools, each a toggle on its own key. */
const LATCHED_TOOL_KEYS: ReadonlyArray<{ commandId: string; tool: 'hand' | 'scale' }> = [
  { commandId: 'tools.hand', tool: 'hand' },
  { commandId: 'tools.scale', tool: 'scale' },
]

export function useCanvasToolShortcuts(editable: boolean, isLive: boolean): void {
  const insertModule = useInsertModule()

  /** ⏎ with `tool` armed: the immediate insert the letter used to make. */
  const insertAtSelection = (tool: DrawTool): boolean => {
    const spec = DRAW_TOOL_SPECS[tool]
    const definition = registry.get(spec.moduleId)
    if (!definition) return false
    const inlineStyles = { ...spec.inlineStyles, ...(spec.clickSize ? { width: `${spec.clickSize.width}px`, height: `${spec.clickSize.height}px` } : {}) }
    const options = Object.keys(inlineStyles).length > 0 ? { inlineStyles } : {}
    if (spec.keyboardPlacement === 'inside') {
      insertModule(definition, undefined, options)
      return true
    }
    const store = useEditorStore.getState()
    const page = selectActiveCanvasPage(store)
    const anchorId = store.selectedNodeId ?? page?.rootNodeId
    if (!page || !anchorId) return false
    // Explicit location: the whole difference between `R` and `F` is
    // beside-vs-inside. `null` means the anchor is orphaned, which is nothing
    // to place against — fall through rather than land it somewhere else.
    const location = resolveSiblingAfterLocation(page, anchorId)
    if (!location) return false
    insertModule(definition, location, options)
    return true
  }

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

      // Escape puts a tool away — the SECOND chance, not the first. With
      // anything selected the `node` rung claims Escape first (deselect),
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

      for (const { commandId, tool } of DRAW_TOOL_KEYS) {
        if (!getKeybindingForCommand(commandId)?.match(event)) continue
        event.preventDefault()
        const store = useEditorStore.getState()
        store.setCanvasTool(store.canvasTool === tool ? 'move' : tool)
        return true
      }

      // ⏎ with a draw tool armed: insert at the selection, then put it away.
      // Plain ⏎ is `layers.selectChildren`'s key, which the node rung gives up
      // while a draw tool is armed.
      if (getKeybindingForCommand('layers.selectChildren')?.match(event)) {
        const store = useEditorStore.getState()
        const tool = store.canvasTool
        if (!isDrawTool(tool)) return false
        if (!insertAtSelection(tool)) return false
        event.preventDefault()
        store.setCanvasTool('move')
        return true
      }

      return false
    },
  )
}
