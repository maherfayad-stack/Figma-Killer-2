/**
 * unbindActions (G-6, OD-20) - typing over a code-bound value.
 *
 * `updateNodeProps` refuses a code-valued prop, silently, by design: it is also
 * called by agents and plugins, and baking a literal over `title={c.heading}`
 * deletes the binding. A person typing into the field that shows that value
 * means exactly that, though, so the panel, the in-place inspector and the
 * canvas text editor route the commit here instead: ONE source write that
 * carries the intent (`unbind: true`), its own Undo, and a notice naming the
 * code that was replaced. The tree is not touched first - the board re-reads the
 * file, so what appears is what the file says.
 *
 * Whether a value may be unbound at all is `canUnbindProp` (`@core/page-tree`):
 * one plain source location, not a row, not a shared component's markup. Whether
 * the CODE is a plain value is the server's call from the AST; a refusal arrives
 * as the usual warning with its sentence.
 */
import { canUnbindProp, type NodeTree, type PageNode } from '@core/page-tree'
import { registry } from '@core/module-engine'
import { deferWhileStructuralCommitInFlight } from '@site/studio/structuralCommitQueue'
import { commitStudioUnbind } from '@site/studio/unbindCommit'
import type { SiteSlice, SiteSliceHelpers } from './types'

type UnbindActions = Pick<SiteSlice, 'unbindNodeValue'>

/** The code a prop reads, as the parser recorded it - `''` when it traced none (hook state, an opaque call). */
function replacedCode(node: PageNode, prop: string): string {
  return node.resolvedProps?.[prop]?.source ?? ''
}

export function createUnbindActions(helpers: SiteSliceHelpers, readTree: () => NodeTree<PageNode> | null): UnbindActions {
  const { get } = helpers

  const actions: UnbindActions = {
    unbindNodeValue: (nodeId, prop, value) => {
      // Behind an in-flight structural write, then re-planned against the tree
      // its resync leaves (the node's id may have moved).
      if (deferWhileStructuralCommitInFlight((relocate) => actions.unbindNodeValue(relocate(nodeId), prop, value), [nodeId])) {
        return false
      }
      const node = readTree()?.nodes[nodeId]
      if (!node || !canUnbindProp(node, prop)) return false
      const textProp = registry.get(node.moduleId)?.inlineTextEdit?.prop
      void commitStudioUnbind({
        nodeId,
        kind: prop === textProp ? 'text' : 'prop',
        prop,
        value,
        replaced: replacedCode(node, prop),
        undo: () => get().undo(),
      })
      return true
    },
  }
  return actions
}
