/**
 * `groupNodes` / `ungroupNode` — K3's two gestures (⌘G and ⌘⇧G), and the pair
 * the 11 named tree-mutation actions became 13 for.
 *
 * They live beside `nodeActions.ts` rather than inside it for the reason
 * `deleteNodesAction.ts` does: that module was at the module-size ceiling, and
 * these two are one coherent job of their own — "this selection becomes one
 * container, and that container stops existing". Everything else about them is
 * the ordinary contract every named action follows: delegate to
 * `mutateActiveTree` / `mutateTreesForNodeIds`, never branch on
 * `kind === 'visualComponent'` (that routing is `mutateActiveTree`'s alone),
 * and on a studio-imported tree WRITE THE SOURCE instead of mutating.
 *
 * WHY GROUP IS NOT `wrapNodes` UNDER A NEW NAME. On a CMS tree they are the
 * same mutation, and this one calls it. In the SOURCE they are different
 * writes and different rules:
 *
 *   - `wrapNodes` is the container picker's verb ("wrap these in a `base.loop`")
 *     and on a studio tree it is one element at a time — `wrapJsxElement`
 *     replaces ONE element's own range, and a multi-selection refuses
 *     (`multi-select`).
 *   - `groupNodes` is ⌘G, and it writes ONE container around a CONTIGUOUS RUN
 *     of siblings (`wrapJsxElements`). What it needs in exchange is a stricter
 *     selection: same parent, no gaps — see `previewStructuralGroup`.
 *
 * A run of one is neither special-cased nor duplicated: it commits as the
 * existing single-element `wrap`, which is the write W4-1 already shipped.
 */
import { registry } from '@core/module-engine'
import { unwrapNode, wrapNodes } from '@core/page-tree'
import type { SiteSlice, SiteSliceHelpers } from './types'
import type { StudioSourceWrites } from './studioSourceWrites'

/**
 * What ⌘G groups into: the plain container module. Not a parameter of the
 * gesture — Figma's Group has no picker either — but `groupNodes` still takes
 * an optional module id so a plugin, an agent or a future "group into…" menu
 * can name a different one without a second action.
 */
export const GROUP_CONTAINER_MODULE_ID = 'base.container'

type GroupActions = Pick<SiteSlice, 'groupNodes' | 'ungroupNode'>

export function createGroupActions(
  helpers: SiteSliceHelpers,
  sourceWrites: Pick<StudioSourceWrites, 'writeGroupToSource' | 'writeUngroupToSource'>,
): GroupActions {
  const { mutateActiveTree, mutateTreesForNodeIds } = helpers

  const actions: GroupActions = {
    groupNodes: (nodeIds, containerModuleId = GROUP_CONTAINER_MODULE_ID, defaults = {}) => {
      if (nodeIds.length === 0) return null
      // On a studio-imported tree the group is a SOURCE write, not a tree
      // mutation — `writeGroupToSource` returns true for both of its outcomes
      // (written, or refused out loud). Either way nothing is minted here, so
      // there is no wrapper id to hand back: the container does not exist
      // until the codemod has written it, and its id is the `line:col` that
      // write produces.
      if (sourceWrites.writeGroupToSource(nodeIds, containerModuleId, defaults)) return null
      // Same defaults-resolution rule as `wrapNode`/`wrapNodes` (Task #414 —
      // defaults must come from the module registry so the wrapper renders).
      const mod = registry.get(containerModuleId)
      const resolvedDefaults = { ...(mod?.defaults ?? {}), ...defaults }
      let wrapperId: string | null = null
      mutateTreesForNodeIds(nodeIds, (tree, idsOnThisTree) => {
        const id = wrapNodes(tree, idsOnThisTree, containerModuleId, resolvedDefaults)
        if (id) wrapperId = id
        return true
      })
      return wrapperId
    },

    ungroupNode: (nodeId) => {
      // Same discipline as the group above: on a studio tree the container is
      // dissolved in the FILE and the board re-reads it, because the ids its
      // children get afterwards are the `line:col`s that write produces.
      if (sourceWrites.writeUngroupToSource(nodeId)) return
      mutateActiveTree((tree) => unwrapNode(tree, nodeId))
    },
  }

  return actions
}
