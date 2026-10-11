/**
 * inlineStyleActions — the five store actions that write a node's
 * `style={{ … }}` bag, for one node or for N.
 *
 * Split out of `nodeActions.ts` when that file passed the 700-line ceiling.
 * The seam is the one the file already had: everything here writes STYLE to
 * a node that already exists, and nothing here touches tree structure — no
 * insert, no move, no delete, no source-structure commit. They share
 * `applyInlineStylePatch`, which is the single definition of what "clear
 * this property" means, and nothing outside this file needs it.
 *
 * Spread into the object `createNodeActions` returns, so the store surface
 * is unchanged and `SiteSlice` still declares all five.
 */
import { describeStructuralRefusal, isStylePatchWritableToSource, refusePlacement } from '@core/page-tree'
import type { PageNode } from '@core/page-tree'
import { resolveActiveTreeTarget } from './helpers'
import { STRUCTURAL_REFUSAL_TITLE, presentStructuralRefusal } from './structuralSourceEdits'
import type { InstanceOverrideRouter } from './instanceOverrideActions'
import type { SiteSlice, SiteSliceHelpers } from './types'

type InlineStyleActions = Pick<
  SiteSlice,
  | 'setNodeInlineStyles'
  | 'setNodeInlineStylesFromGesture'
  | 'setNodesInlineStyles'
  | 'setNodesInlineStylesPerNode'
  | 'removeNodeInlineStyleProperty'
  | 'clearNodeInlineStyles'
>

/**
 * Merge one inline-style patch into `node.inlineStyles`, honouring the storage
 * model the rest of the panel assumes: `null` / `undefined` / `''` CLEARS a
 * property, and a bag that empties is dropped entirely so the node carries no
 * `style` attribute at all. Returns whether anything actually changed.
 *
 * Shared by `setNodeInlineStyles` (one node) and `setNodesInlineStyles` (the
 * W8-3 multi-selection bulk edit) so the two can never drift on what "clear
 * this property" means — the single-node path is what every existing test and
 * the publisher already encode.
 */
export function applyInlineStylePatch(
  node: PageNode,
  patch: Record<string, string | number | null | undefined>,
): boolean {
  const next: Record<string, unknown> = { ...(node.inlineStyles ?? {}) }
  let changed = false
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined || value === '') {
      if (key in next) {
        delete next[key]
        changed = true
      }
    } else if (!Object.is(next[key], value)) {
      next[key] = value
      changed = true
    }
  }
  if (!changed) return false
  if (Object.keys(next).length > 0) node.inlineStyles = next
  else delete node.inlineStyles
  return true
}

export function createInlineStyleActions(helpers: SiteSliceHelpers, overrides: InstanceOverrideRouter): InlineStyleActions {
  const { mutateActiveTree, mutateTreesForNodeIds, get, set } = helpers

  /** A bulk write that names exactly one node of the active tree is that node's single write — OD-19's router only sees the single-node action. */
  const soleActiveNode = (nodeIds: readonly string[]): string | null =>
    nodeIds.length === 1 && resolveActiveTreeTarget(get())?.tree.nodes[nodeIds[0]!] !== undefined ? nodeIds[0]! : null

  const inlineStyleActions: InlineStyleActions = {
  setNodeInlineStyles: (nodeId, patch) => {
    const written = () =>
      mutateActiveTree((tree) => {
        const node = tree.nodes[nodeId]
        if (!node) throw new Error(`[PageTree] Node "${nodeId}" not found`)
        // Same per-property rule as `updateNodeProps` above — a `style={{}}`
        // entry authored as a literal is writable; one resolved from an
        // expression (`width: `${pct}%``) is not.
        if (!isStylePatchWritableToSource(node, patch)) return false
        return applyInlineStylePatch(node, patch)
      })
    // OD-19 — a style inside a component instance is an override of THIS instance, not a rewrite of the component.
    const overridden = overrides.route({
      nodeId,
      change: { styles: patch },
      preview: (tree) => {
        const node = tree.nodes[nodeId]
        return node !== undefined && applyInlineStylePatch(node, patch)
      },
      plain: () => void written(),
      again: (id) => get().setNodeInlineStyles(id, patch),
    })
    if (!overridden) written()
  },

  setNodeInlineStylesFromGesture: (nodeId, patch, gesture) => {
    const node = resolveActiveTreeTarget(get())?.tree.nodes[nodeId]
    const refusal = node ? refusePlacement(node, gesture) : null
    if (node && refusal?.reason === 'shared-component') {
      presentStructuralRefusal(STRUCTURAL_REFUSAL_TITLE.resize, describeStructuralRefusal({ refusal, node }), {
        nodeId,
        retry: (mapId) => get().setNodeInlineStyles(mapId(nodeId), patch),
        getState: get,
        set,
      })
      return
    }
    get().setNodeInlineStyles(nodeId, patch)
  },

  setNodesInlineStyles: (nodeIds, patch) => {
    if (nodeIds.length === 0) return
    const sole = soleActiveNode(nodeIds)
    if (sole !== null) return inlineStyleActions.setNodeInlineStyles(sole, patch)
    // `mutateTreesForNodeIds` wraps every touched page in ONE
    // `runHistoricMutation` transaction, so an inspector edit across an
    // N-node selection is a single undo step — the same contract
    // `deleteNodes` / `wrapNodes` already ship (WS-7.3).
    mutateTreesForNodeIds(nodeIds, (tree, idsOnThisTree) => {
      let changedAny = false
      for (const nodeId of idsOnThisTree) {
        const node = tree.nodes[nodeId]
        // A bulk edit never aborts halfway. An id that has gone stale
        // underneath the selection, or a node whose own source refuses this
        // property (`isStylePatchWritableToSource` — a `style:<prop>`
        // resolved from an expression), is skipped INDIVIDUALLY so the rest
        // of the selection still receives the write. Throwing here, as the
        // single-node path does for a missing id, would leave N-1 nodes
        // half-written.
        if (!node) continue
        if (!isStylePatchWritableToSource(node, patch)) continue
        if (applyInlineStylePatch(node, patch)) changedAny = true
      }
      return changedAny
    })
  },

  setNodesInlineStylesPerNode: (patches, opts) => {
    if (patches.length === 0) return
    const sole = opts === undefined ? soleActiveNode(patches.map((entry) => entry.nodeId)) : null
    if (sole !== null) return inlineStyleActions.setNodeInlineStyles(sole, patches[0]!.patch)
    const patchByNodeId = new Map(patches.map((entry) => [entry.nodeId, entry.patch]))
    const nodeIds = patches.map((entry) => entry.nodeId)
    // Same one-transaction contract as `setNodesInlineStyles`; the only
    // difference is that each node gets its OWN patch. Selection colours
    // needs that: one layer's `color` and another's `borderTopColor` are the
    // same swatch to the user and must move (and undo) together.
    mutateTreesForNodeIds(
      nodeIds,
      (tree, idsOnThisTree) => {
        let changedAny = false
        for (const nodeId of idsOnThisTree) {
          const node = tree.nodes[nodeId]
          const patch = patchByNodeId.get(nodeId)
          if (!node || !patch) continue
          // Per-node all-or-nothing, exactly as the single-node path: a
          // half-applied patch is a canvas that disagrees with the file it
          // mirrors.
          if (!isStylePatchWritableToSource(node, patch)) continue
          if (applyInlineStylePatch(node, patch)) changedAny = true
        }
        return changedAny
      },
      opts,
    )
  },

  removeNodeInlineStyleProperty: (nodeId, propKey) => {
    inlineStyleActions.setNodeInlineStyles(nodeId, { [propKey]: null })
  },

  clearNodeInlineStyles: (nodeId) => {
    mutateActiveTree((tree) => {
      const node = tree.nodes[nodeId]
      if (!node?.inlineStyles) return false
      delete node.inlineStyles
      return true
    })
  },
  }

  return inlineStyleActions
}
