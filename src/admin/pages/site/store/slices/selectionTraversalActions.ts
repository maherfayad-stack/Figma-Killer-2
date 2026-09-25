/**
 * selectionTraversalActions — walking the tree with the keyboard:
 * `layers.selectParent` / `layers.selectChildren` (⇧Enter / Enter,
 * `viewport-01`; P5-E made both act on the WHOLE selection, IX-7), and since
 * P2-B the sibling moves — Tab / ⇧Tab (`selectSiblingNode`, IX-3) and ⌘A
 * (`selectAllSiblingNodes`, IX-4).
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
 * They return `boolean` — `true` when the selection actually moved — so a
 * keyboard handler can fall through to whatever else wants the keystroke,
 * mirroring `exitInstance`/`enterSelectedInstance`.
 *
 * ## What the keyboard can reach
 *
 * The sibling moves skip HIDDEN nodes (they render nothing — a ring around
 * nothing is a lost user) and LOCKED ones (Penpot's `select-all` drops
 * `:blocked`; Figma's lock means "don't grab this"). A locked node is still
 * one click away on the canvas or in the Layers panel.
 */
import { getParent, type BaseNode, type NodeTree, type PageNode } from '@core/page-tree'
import type { EditorStore, EditorStoreSliceCreator } from '@site/store/types'
import { filterMultiSelectableIds, resolveSelectableNode } from './selectionResolve'

type Get = Parameters<EditorStoreSliceCreator<EditorStore>>[1]

type SelectionTraversalActions = Pick<
  EditorStore,
  'selectParentNode' | 'selectChildNodes' | 'selectSiblingNode' | 'selectAllSiblingNodes'
>

/** See "What the keyboard can reach" in the module doc. */
function isKeyboardReachable(node: BaseNode | undefined): boolean {
  return node !== undefined && node.hidden !== true && node.locked !== true
}

/** `parent`'s children the keyboard may select as a SET — reachable, and kept by `selectMany`. */
function selectableChildren(state: EditorStore, tree: NodeTree<PageNode>, parent: BaseNode): string[] {
  const reachable = parent.children.filter((id) => isKeyboardReachable(tree.nodes[id]))
  return filterMultiSelectableIds(state, reachable)
}

export function createSelectionTraversalActions(get: Get): SelectionTraversalActions {
  return {
    selectParentNode: () => {
      const state = get()
      const anchor = state.selectedNodeId
      if (!anchor) return false
      const resolved = resolveSelectableNode(state, anchor)
      if (!resolved) return false
      // Every selected layer's parent, in selection order, once each (IX-7).
      // A root has none — "walk up until you can't" is the whole gesture, and
      // Escape is the key that means "deselect" (`select-01`).
      const parents: string[] = []
      for (const id of state.selectedNodeIds.length > 0 ? state.selectedNodeIds : [anchor]) {
        const parent = getParent(resolved.tree, id)
        if (parent && !parents.includes(parent.id)) parents.push(parent.id)
      }
      if (parents.length === 0) return false
      const frameId = state.selectedNodeFrameId
      // A root is only ever selected on its own (`filterMultiSelectableIds`).
      const selectable = parents.length > 1 ? filterMultiSelectableIds(state, parents) : []
      if (selectable.length > 1) state.selectMany(selectable, { frameId })
      else state.selectNode(selectable[0] ?? parents[0]!, 'replace', { frameId })
      return true
    },

    selectChildNodes: () => {
      const state = get()
      const anchor = state.selectedNodeId
      if (!anchor) return false
      const resolved = resolveSelectableNode(state, anchor)
      if (!resolved) return false
      const { tree } = resolved
      // Every reachable child of every selected layer (IX-7), in tree order.
      const children: string[] = []
      for (const id of state.selectedNodeIds.length > 0 ? state.selectedNodeIds : [anchor]) {
        const node = tree.nodes[id]
        if (!node) continue
        for (const childId of node.children) {
          if (isKeyboardReachable(tree.nodes[childId]) && !children.includes(childId)) children.push(childId)
        }
      }
      if (children.length === 0) return false
      const frameId = state.selectedNodeFrameId
      if (children.length === 1) {
        state.selectNode(children[0]!, 'replace', { frameId })
        return true
      }
      const selectable = filterMultiSelectableIds(state, children)
      if (selectable.length === 0) return false
      state.selectMany(selectable, { frameId })
      return true
    },

    selectSiblingNode: (direction) => {
      const state = get()
      const anchor = state.selectedNodeId
      if (!anchor) return false
      const frameId = state.selectedNodeFrameId
      // Penpot: with N selected, Tab collapses to one. The ANCHOR, not the
      // first — it is the node the inspector is already showing.
      if (state.selectedNodeIds.length > 1) {
        state.selectNode(anchor, 'replace', { frameId })
        return true
      }
      const resolved = resolveSelectableNode(state, anchor)
      if (!resolved) return false
      const parent = getParent(resolved.tree, anchor)
      if (!parent) return false
      const siblings = parent.children
      const start = siblings.indexOf(anchor)
      if (start === -1) return false
      const step = direction === 'next' ? 1 : -1
      // Wrapping walk that skips what the keyboard cannot reach; stops short
      // of coming back round to the anchor itself.
      for (let offset = 1; offset < siblings.length; offset += 1) {
        const index = (((start + step * offset) % siblings.length) + siblings.length) % siblings.length
        const candidate = siblings[index]
        if (candidate && isKeyboardReachable(resolved.tree.nodes[candidate])) {
          state.selectNode(candidate, 'replace', { frameId })
          return true
        }
      }
      return false
    },

    selectAllSiblingNodes: () => {
      const state = get()
      const anchor = state.selectedNodeId
      if (!anchor) return false
      const resolved = resolveSelectableNode(state, anchor)
      if (!resolved) return false
      const { tree } = resolved
      const frameId = state.selectedNodeFrameId
      const parent = getParent(tree, anchor)
      // The anchor IS the root: no node level left above it.
      if (!parent) return false

      const siblings = selectableChildren(state, tree, parent)
      const selected = new Set(state.selectedNodeIds)
      const levelAlreadySelected = siblings.every((id) => selected.has(id))
      if (!levelAlreadySelected) {
        state.selectMany(siblings, { frameId })
        return true
      }

      // Every sibling is selected already (or none can be) — climb (Figma).
      const grandparent = getParent(tree, parent.id)
      // `parent` is the root, and a root is only ever selected on its own
      // (`filterMultiSelectableIds`) — so the level above is the root alone.
      if (!grandparent) {
        state.selectNode(parent.id, 'replace', { frameId })
        return true
      }
      const parentLevel = selectableChildren(state, tree, grandparent)
      if (parentLevel.length === 0) state.selectNode(parent.id, 'replace', { frameId })
      else state.selectMany(parentLevel, { frameId })
      return true
    },
  }
}
