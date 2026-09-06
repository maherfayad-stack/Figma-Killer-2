/**
 * selectionTraversalActions — walking the tree with the keyboard
 * (`layers.selectParent` / `layers.selectFirstChild`, bound to ⇧Enter / Enter
 * by `viewport-01`).
 *
 * Split out of `selectionSlice.ts` purely to stay under the module-size-budget
 * ceiling — same reasoning `boardFrameSelectionActions.ts` gives for its own
 * split. The two actions are ordinary selection actions and belong to
 * `SelectionSlice`'s public surface (declared there, spread in from here).
 *
 * Both resolve the anchor through `resolveSelectableNode`, NOT through the
 * single active page. On a studio board the selected node may live on any page
 * curated as a frame of the active board (WS-7.3) — resolving against
 * `activePageId` alone would make Enter/⇧Enter silently no-op for every frame
 * but one. `spotlight/commands/layers.ts` used to do exactly that walk itself
 * against `selectActiveCanvasPage`; those two command bodies now call these
 * actions, so the palette and the keyboard can never disagree.
 *
 * Both preserve `selectedNodeFrameId` (WS-10 Phase 2) so traversing inside a
 * "duplicate as variant" frame keeps the ring on the frame the user is
 * actually looking at, instead of jumping to its sibling — the two frames
 * legitimately share every node id (trap #2).
 *
 * Both return `boolean` — `true` when the selection actually moved — so a
 * keyboard handler can fall through to whatever else wants the keystroke,
 * mirroring `exitInstance`/`enterSelectedInstance`.
 */
import { getParent } from '@core/page-tree'
import type { EditorStore, EditorStoreSliceCreator } from '@site/store/types'
import { resolveSelectableNode } from './selectionResolve'

type Get = Parameters<EditorStoreSliceCreator<EditorStore>>[1]

type SelectionTraversalActions = Pick<EditorStore, 'selectParentNode' | 'selectFirstChildNode'>

export function createSelectionTraversalActions(get: Get): SelectionTraversalActions {
  return {
    selectParentNode: () => {
      const state = get()
      const anchor = state.selectedNodeId
      if (!anchor) return false
      const resolved = resolveSelectableNode(state, anchor)
      if (!resolved) return false
      const parent = getParent(resolved.tree, anchor)
      // No parent = the anchor is the tree root. Stop there rather than
      // clearing: "walk up until you can't" is the whole gesture, and
      // Escape is the key that means "deselect" (`select-01`).
      if (!parent) return false
      state.selectNode(parent.id, 'replace', { frameId: state.selectedNodeFrameId })
      return true
    },

    selectFirstChildNode: () => {
      const state = get()
      const anchor = state.selectedNodeId
      if (!anchor) return false
      const resolved = resolveSelectableNode(state, anchor)
      if (!resolved) return false
      const firstChild = resolved.node.children[0]
      if (!firstChild) return false
      state.selectNode(firstChild, 'replace', { frameId: state.selectedNodeFrameId })
      return true
    },
  }
}
