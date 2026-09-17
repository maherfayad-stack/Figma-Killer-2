/**
 * useCanvasNodeShortcuts — the `node` scope's second handler: Delete, ⌘D,
 * ⌘C / ⌘X / ⌘V, and ⌥↑/⌥↓ reorder, all acting on the current node selection.
 *
 * ## Why this is no longer a React `onKeyDown`
 *
 * It used to be one (`useCanvasKeyboardShortcuts`, a handler on the canvas
 * div), which only fires while a canvas descendant holds DOM focus. Selecting a
 * node auto-opens the Properties panel, so a single click in there killed
 * Delete and ⌘D for the rest of the session — which is exactly why `CanvasRoot`
 * had grown a SECOND, `document`-level Delete listener next to it, guarded by
 * its own `isCanvasEvent` focus test. Two listeners, two guard sets, one
 * keystroke.
 *
 * `K1` deleted both and left this: one handler on the shared dispatcher,
 * scoped by INTENT (something is selected) rather than by focus — the same
 * move `board-02` made for ⌘A and `select-01` made for Escape. Delete now works
 * from the Properties panel, which is what every user expects and what Figma
 * does.
 *
 * ## The guards
 *
 *   - An open inline text edit — the dispatcher's `inline-edit` rung. The
 *     canvas edits text in a contentEditable inside a frame iframe, and
 *     `isTextInputTarget` cannot see across that realm, so this has to be a
 *     store fact rather than a DOM question.
 *   - `isTextInputTarget` — typing in any field beats every one of these,
 *     including Delete and the clipboard trio.
 *   - `isInsideKeyOwningOverlay` — a dialog / menu / listbox owns its own
 *     Delete and Escape.
 *
 * Multi-selection: every branch reads `selectedNodeIds` live from the store and
 * dispatches the `*Nodes` batch action so one press is one undo step.
 */
import { getParent } from '@core/page-tree'
import { selectActiveCanvasPage, useEditorStore } from '@site/store/store'
import { getKeybindingForCommand } from '@admin/spotlight/keybindings'
import { isInsideKeyOwningOverlay, isTextInputTarget } from './editorKeyGuards'
import { useEditorKeyScope } from './useEditorKeyDispatcher'

/**
 * `Alt+↑`/`Alt+↓` (`layers.moveUp`/`layers.moveDown`, G12), and `⌘]`/`⌘[`
 * since `K4`. Mirrors `spotlight/commands/layers.ts`'s own command bodies
 * exactly (same store call, same sibling-index arithmetic) so the keyboard and
 * palette paths can never disagree about what "move up" means. Deliberately
 * calls the existing `moveNode` store action rather than adding a new one —
 * `moveNode` already runs the same structural write-back gate every other
 * reorder surface does (`struct-01`), so a refused move surfaces the same
 * refusal here as it does from a mouse drag.
 *
 * Single-node only: a multi-selection has no well-defined "up" (the members may
 * not even share a parent), so this silently no-ops for a multi-select.
 */
function runMoveShortcut(direction: 'up' | 'down', selectedNodeId: string, currentIds: readonly string[]): void {
  if (currentIds.length > 1) return
  const store = useEditorStore.getState()
  const page = selectActiveCanvasPage(store)
  if (!page) return
  const parent = getParent(page, selectedNodeId)
  if (!parent) return
  const siblings = parent.children
  const idx = siblings.indexOf(selectedNodeId)
  if (idx === -1) return
  if (direction === 'up') {
    if (idx <= 0) return
    store.moveNode(selectedNodeId, parent.id, idx - 1)
  } else {
    if (idx >= siblings.length - 1) return
    store.moveNode(selectedNodeId, parent.id, idx + 1)
  }
}

/**
 * `⌘G` / `⌘⇧G` (`layers.group` / `layers.ungroup`, K3) — the same two store
 * actions the palette commands call, for the same reason `runMoveShortcut`
 * above calls `moveNode`: both actions already run the structural
 * write-back gate (`previewStructuralGroup` / `refuseStructuralEdit`), so a
 * selection that is not a contiguous run of siblings refuses with the same
 * sentence here as it does from the palette or the layers-tree menu.
 *
 * Ungroup takes the selection ANCHOR, not the whole selection: each ungroup
 * shifts the source position of everything below it, so a multi-selection
 * would plan its second write against lines the first already moved.
 */
function runGroupShortcut(selectedNodeId: string, currentIds: readonly string[]): void {
  const ids = currentIds.length > 0 ? [...currentIds] : [selectedNodeId]
  useEditorStore.getState().groupNodes(ids)
}

interface CanvasNodeShortcutsOptions {
  editable: boolean
  isLive: boolean
  /** Delete branch — routes a single node through the editor confirm flow. */
  requestDeleteNode: (nodeId: string) => void
}

export function useCanvasNodeShortcuts({
  editable,
  isLive,
  requestDeleteNode,
}: CanvasNodeShortcutsOptions): void {
  useEditorKeyScope(
    'node',
    () => !isLive && editable && useEditorStore.getState().selectedNodeId !== null,
    (event) => {
      if (isTextInputTarget(event.target)) return false
      if (isInsideKeyOwningOverlay(event.target)) return false

      const store = useEditorStore.getState()
      const selectedNodeId = store.selectedNodeId
      if (!selectedNodeId) return false
      const currentIds = store.selectedNodeIds

      if (getKeybindingForCommand('layers.delete')?.match(event)) {
        event.preventDefault()
        if (currentIds.length > 1) {
          // Multi-delete skips the central confirm dialog — undo via ⌘Z.
          store.deleteNodes([...currentIds])
          store.clearSelection()
        } else {
          requestDeleteNode(selectedNodeId)
        }
        return true
      }

      if (getKeybindingForCommand('layers.duplicate')?.match(event)) {
        event.preventDefault()
        // `K7` — the copy becomes the selection, so ⌘D ⌘D ⌘D builds a row
        // instead of stamping three copies of the same original on top of one
        // another, and the inspector is already pointed at the thing you just
        // made. `duplicateJsxElement` already places the copy as the next
        // sibling, so the two halves of "lands where the eye expects" agree.
        //
        // Selected HERE and not inside `duplicateNode`: that action is one of
        // the eleven tree mutations, reachable from the agent, the palette and
        // `applyTreeOperation`, and a background tool must never move the
        // user's selection out from under them.
        //
        // On a studio-imported tree the duplicate is an async SOURCE write and
        // returns `''` — the copy's id is the `line:col` the codemod produces
        // and does not exist until the resync lands. Nothing is selected in
        // that case rather than something wrong. See `writeDuplicateToSource`.
        if (currentIds.length > 1) {
          const newIds = store.duplicateNodes([...currentIds]).filter(Boolean)
          if (newIds.length > 0) store.selectMany(newIds)
        } else {
          const newId = store.duplicateNode(selectedNodeId)
          if (newId) store.selectNode(newId)
        }
        return true
      }

      if (getKeybindingForCommand('layers.moveUp')?.match(event)) {
        event.preventDefault()
        runMoveShortcut('up', selectedNodeId, currentIds)
        return true
      }

      if (getKeybindingForCommand('layers.moveDown')?.match(event)) {
        event.preventDefault()
        runMoveShortcut('down', selectedNodeId, currentIds)
        return true
      }

      if (getKeybindingForCommand('layers.copy')?.match(event)) {
        event.preventDefault()
        if (currentIds.length > 1) store.copyNodes([...currentIds])
        else store.copyNode(selectedNodeId)
        return true
      }

      if (getKeybindingForCommand('layers.cut')?.match(event)) {
        event.preventDefault()
        if (currentIds.length > 1) store.cutNodes([...currentIds])
        else store.cutNode(selectedNodeId)
        return true
      }

      if (getKeybindingForCommand('layers.paste')?.match(event)) {
        event.preventDefault()
        // `K7` — 'after', not the default 'auto': ⌘V is a gesture about the
        // SELECTION, and the eye expects the copy beside the selected element
        // rather than appended to the end of its children (where, on a tall
        // container, it lands off-screen). The right-click "Paste here" keeps
        // 'auto' — that one names a container and means "into it".
        // Anchors to the multi-selection's anchor — same single target.
        store.pasteNode(selectedNodeId, 'after')
        return true
      }

      // K3 — ⌘⇧G is tested BEFORE ⌘G: the two differ by Shift alone, and
      // `layers.group`'s own match rejects Shift, so the order is belt and
      // braces rather than load-bearing.
      if (getKeybindingForCommand('layers.ungroup')?.match(event)) {
        event.preventDefault()
        store.ungroupNode(selectedNodeId)
        return true
      }

      if (getKeybindingForCommand('layers.group')?.match(event)) {
        event.preventDefault()
        runGroupShortcut(selectedNodeId, currentIds)
        return true
      }

      return false
    },
  )
}
