/**
 * copyAsPngTarget — what ⌘⇧C photographs, decided as one pure function.
 *
 * "The current selection" is three different things in this editor and the
 * shortcut has to mean the right one:
 *
 *   1. **A node is selected** → that element, cropped out of a capture of its
 *      page. Exactly what the Export section's PNG row already produces.
 *   2. **Board frames are selected, exactly one** → that frame's whole screen.
 *      A frame is a page on the board, so this is the page capture uncropped.
 *   3. **Nothing is selected** → the screen that is open in the canvas. The
 *      most common case, and the reason the shortcut works with no selection
 *      at all.
 *
 * Three cases are REFUSED by name rather than guessed at:
 *
 *   - **More than one frame selected.** One keystroke, one image; picking the
 *     first of five would silently copy something the user did not point at,
 *     and a five-image clipboard does not exist.
 *   - **No open screen.** An empty board has nothing to photograph, and
 *     "nothing happened" is the worst possible answer to a copy shortcut.
 *   - **A Visual Component is open in the canvas.** The capture route
 *     photographs a PAGE that exists on disk; a VC edit document is a virtual
 *     page assembled in memory and has no board frame to point Chromium at.
 *     Falling through to "some page" would copy a screen the user is not
 *     looking at.
 *
 * Kept separate from `useCopyAsPngShortcut.ts` so the routing is testable
 * without a store, a keyboard, or a clipboard.
 */

/** What the shortcut will capture. `nodeId: null` means the whole frame. */
export interface CopyAsPngTarget {
  ok: true
  pageId: string
  nodeId: string | null
  /** What the success toast calls it — an element label, or a screen name. */
  label: string
}

/** Why the shortcut is standing down, written to be shown to the user verbatim. */
export interface CopyAsPngRefusal {
  ok: false
  reason: string
}

export interface CopyAsPngSelection {
  /**
   * True while the canvas is editing a Visual Component rather than a page.
   * There is no capturable frame in that mode — see the module doc.
   */
  isVisualComponentDocument: boolean
  /** The anchor node of the node selection, or `null`. */
  selectedNodeId: string | null
  /** The anchor node's label, used only for the toast. */
  selectedNodeLabel: string | null
  /** Page ids of the currently selected BOARD frames, in selection order. */
  selectedFramePageIds: readonly string[]
  /** The screen open in the canvas, or `null` on an empty board. */
  activePageId: string | null
  activePageTitle: string | null
}

export function resolveCopyAsPngTarget(
  selection: CopyAsPngSelection,
): CopyAsPngTarget | CopyAsPngRefusal {
  if (selection.isVisualComponentDocument) {
    return {
      ok: false,
      reason: 'A Visual Component is open in the canvas, and only a screen can be photographed. Go back to a page first.',
    }
  }

  // 1. A node beats a frame: selecting a node is the more specific gesture,
  //    and the store clears the frame selection when one is made anyway.
  if (selection.selectedNodeId) {
    if (!selection.activePageId) {
      return { ok: false, reason: 'This element is not on an open screen, so there is nothing to photograph.' }
    }
    return {
      ok: true,
      pageId: selection.activePageId,
      nodeId: selection.selectedNodeId,
      label: selection.selectedNodeLabel || 'element',
    }
  }

  // 2. Board frames.
  if (selection.selectedFramePageIds.length > 1) {
    return {
      ok: false,
      reason: `Copy as PNG produces one image, and ${selection.selectedFramePageIds.length} frames are selected. Select one frame, or deselect to copy the open screen.`,
    }
  }
  const framePageId = selection.selectedFramePageIds[0]
  if (framePageId) {
    return { ok: true, pageId: framePageId, nodeId: null, label: 'frame' }
  }

  // 3. Nothing selected — the open screen.
  if (!selection.activePageId) {
    return { ok: false, reason: 'No screen is open, so there is nothing to copy.' }
  }
  return {
    ok: true,
    pageId: selection.activePageId,
    nodeId: null,
    label: selection.activePageTitle || 'screen',
  }
}
