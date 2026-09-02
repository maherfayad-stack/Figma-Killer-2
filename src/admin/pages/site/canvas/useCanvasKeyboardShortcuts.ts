/**
 * useCanvasKeyboardShortcuts — canvas-focused keyboard handler.
 *
 * Single source of truth for the canvas-level shortcuts that act on the
 * current selection. The handler delegates to `useCanvas` for zoom/pan
 * keys, then routes the remaining keys through the keybindings registry
 * into per-family helpers (delete / duplicate / clipboard).
 *
 * Splitting out of `CanvasRoot` keeps "add a new layers.* shortcut" a
 * one-line edit inside this file rather than a churn-y diff against the
 * 500+ line canvas component.
 *
 * **Escape is deliberately NOT handled here** (`select-01`). This is a React
 * `onKeyDown` on the canvas div, so it only fires while a canvas descendant
 * holds DOM focus — and selecting a node auto-opens the Properties panel, so
 * one click into it left Escape doing nothing at all. The whole Enter/Escape
 * selection ladder lives in `useCanvasSelectionKeyboard.ts`, on `document`,
 * scoped by intent rather than focus — the same move `board-02` made for
 * `board.selectAllFrames` below.
 */

import { getParent } from '@core/page-tree'
import { selectActiveCanvasPage, useEditorStore } from '@site/store/store'
import { getKeybindingForCommand } from '@admin/spotlight/keybindings'

type CanvasKeyEvent = React.KeyboardEvent<HTMLDivElement>

interface CanvasKeyboardShortcutsDeps {
  /** Forwarded gesture handler (zoom / pan keys). Always runs first. */
  canvasKeyDown: (event: CanvasKeyEvent) => void
  /** Anchor node id — the canvas only reacts when something is selected. */
  selectedNodeId: string | null
  /** True when the canvas is editable (false for read-only / preview). */
  editable: boolean
  /** Multi-delete clears the selection it just destroyed. */
  clearSelection: () => void
  /** Delete branch — routes through the editor confirm flow for a single node. */
  requestDeleteNode: (nodeId: string) => void
  deleteNodes: (nodeIds: string[]) => void
  duplicateNode: (nodeId: string) => void
  duplicateNodes: (nodeIds: string[]) => void
  copyNode: (nodeId: string) => void
  copyNodes: (nodeIds: string[]) => void
  cutNode: (nodeId: string) => void
  cutNodes: (nodeIds: string[]) => void
  pasteNode: (nodeId: string) => void
  runShortcut?: (event: KeyboardEvent) => boolean
}

/**
 * Inputs / textareas / contenteditable surfaces let the browser own the
 * keystroke. Exported: `CanvasRoot.tsx`'s document-level `board.selectAllFrames`
 * listener (board-02) reuses this exact predicate so "don't hijack Ctrl/Cmd+A
 * while typing" is defined in exactly one place.
 */
export function isTextInputTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return (
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.isContentEditable
  )
}

function runDeleteShortcut(
  event: CanvasKeyEvent,
  selectedNodeId: string,
  currentIds: readonly string[],
  deps: Pick<CanvasKeyboardShortcutsDeps, 'requestDeleteNode' | 'deleteNodes' | 'clearSelection'>,
): void {
  // Don't intercept backspace while the user is typing in a field.
  if (isTextInputTarget(event.target)) return
  event.preventDefault()
  if (currentIds.length > 1) {
    // Multi-delete skips the central confirm dialog for v1 — undo via Ctrl+Z.
    deps.deleteNodes([...currentIds])
    deps.clearSelection()
  } else {
    deps.requestDeleteNode(selectedNodeId)
  }
}

function runDuplicateShortcut(
  event: CanvasKeyEvent,
  selectedNodeId: string,
  currentIds: readonly string[],
  deps: Pick<CanvasKeyboardShortcutsDeps, 'duplicateNode' | 'duplicateNodes'>,
): void {
  event.preventDefault()
  if (currentIds.length > 1) {
    deps.duplicateNodes([...currentIds])
  } else {
    deps.duplicateNode(selectedNodeId)
  }
}

/**
 * `Alt+↑`/`Alt+↓` (`layers.moveUp`/`layers.moveDown`, G12) — the ONLY keyboard
 * path for reordering a node; before this, dragging (mouse only) was the
 * whole story. Mirrors `spotlight/commands/layers.ts`'s own `layers.moveUp`/
 * `layers.moveDown` command bodies exactly (same store call, same sibling-index
 * arithmetic) so the keyboard and palette paths can never disagree about what
 * "move up" means. Deliberately calls the existing `moveNode` store action
 * rather than adding a new one — `moveNode` already runs the same structural
 * write-back gate every other reorder surface does (`struct-01`), so a
 * refused move surfaces the same toast here as it does from a mouse drag.
 * Single-node only: a multi-selection has no well-defined "up" (the members
 * may not even share a parent), so this silently no-ops for a multi-select —
 * matching the audit's scoped intent (G12 is the a11y unblock, not a new
 * multi-move semantics).
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

type ClipboardDeps = Pick<
  CanvasKeyboardShortcutsDeps,
  'copyNode' | 'copyNodes' | 'cutNode' | 'cutNodes' | 'pasteNode'
>

function runClipboardShortcut(
  event: CanvasKeyEvent,
  selectedNodeId: string,
  currentIds: readonly string[],
  deps: ClipboardDeps,
): boolean {
  // Skip when the active element is a text input / contenteditable so the
  // browser's native text-clipboard wins when the user is editing a value.
  if (isTextInputTarget(event.target)) return false

  if (getKeybindingForCommand('layers.copy')?.match(event)) {
    event.preventDefault()
    if (currentIds.length > 1) deps.copyNodes([...currentIds])
    else deps.copyNode(selectedNodeId)
    return true
  }
  if (getKeybindingForCommand('layers.cut')?.match(event)) {
    event.preventDefault()
    if (currentIds.length > 1) deps.cutNodes([...currentIds])
    else deps.cutNode(selectedNodeId)
    return true
  }
  if (getKeybindingForCommand('layers.paste')?.match(event)) {
    event.preventDefault()
    // Paste anchors to the multi-selection's anchor — same single target.
    deps.pasteNode(selectedNodeId)
    return true
  }
  return false
}

/** Returns the canvas keydown handler. */
export function useCanvasKeyboardShortcuts(
  deps: CanvasKeyboardShortcutsDeps,
): (event: CanvasKeyEvent) => void {
  const {
    canvasKeyDown,
    selectedNodeId,
    editable,
    clearSelection,
    requestDeleteNode,
    deleteNodes,
    duplicateNode,
    duplicateNodes,
    copyNode,
    copyNodes,
    cutNode,
    cutNodes,
    pasteNode,
    runShortcut,
  } = deps

  return (event: CanvasKeyEvent) => {
    // While inline editing, the contentEditable node (inside a breakpoint
    // iframe) owns the keyboard. Its keystrokes bubble through React to this
    // parent handler, and the per-shortcut `isTextInputTarget` guard can't see
    // a cross-realm iframe element, so suppress ALL canvas shortcuts up front —
    // Delete/Cmd+D/copy/paste must never fire mid-edit. The editing element's
    // own onKeyDown handles Escape (cancel) and Enter (commit).
    if (useEditorStore.getState().activeInlineEdit) return

    // Zoom / pan keys always run, regardless of selection state.
    canvasKeyDown(event)

    if (runShortcut?.(event.nativeEvent)) return

    // Escape (step out of an instance / clear the selection / leave VC mode) is
    // NOT handled here — see this module's doc comment. It lives in
    // `useCanvasSelectionKeyboard.ts`, on `document`, for the same reason
    // `board.selectAllFrames` does below.

    // `board.selectAllFrames` (⌘/Ctrl+A) is NOT handled here (board-02):
    // this handler is a React `onKeyDown` on the canvas div, so it only
    // fires while a descendant of the canvas holds DOM focus — exactly the
    // bug report ("ctrl A selects text in the canvas panels not in the
    // canvas itself"). It's handled by a document-level listener in
    // `CanvasRoot.tsx` instead, scoped by intent (not typing in an editable
    // field) rather than by focus.

    if (!editable) return
    if (!selectedNodeId) return

    // Read the live selection set inside the handler so multi-actions see
    // the latest state without subscribing the component to selectedNodeIds.
    const currentIds = useEditorStore.getState().selectedNodeIds

    if (getKeybindingForCommand('layers.delete')?.match(event)) {
      runDeleteShortcut(event, selectedNodeId, currentIds, {
        requestDeleteNode,
        deleteNodes,
        clearSelection,
      })
      return
    }

    if (getKeybindingForCommand('layers.duplicate')?.match(event)) {
      runDuplicateShortcut(event, selectedNodeId, currentIds, {
        duplicateNode,
        duplicateNodes,
      })
      return
    }

    if (getKeybindingForCommand('layers.moveUp')?.match(event)) {
      event.preventDefault()
      runMoveShortcut('up', selectedNodeId, currentIds)
      return
    }

    if (getKeybindingForCommand('layers.moveDown')?.match(event)) {
      event.preventDefault()
      runMoveShortcut('down', selectedNodeId, currentIds)
      return
    }

    runClipboardShortcut(event, selectedNodeId, currentIds, {
      copyNode,
      copyNodes,
      cutNode,
      cutNodes,
      pasteNode,
    })
  }
}
