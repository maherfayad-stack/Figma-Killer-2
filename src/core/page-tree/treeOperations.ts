/**
 * `applyTreeOperation` — the single entry point that turns one tagged-union
 * `TreeOperation` into one of the 11 named node-level mutations.
 *
 * Split out of `mutations.ts`, which is a library of pure Mutative-compatible
 * primitives; this is a dispatcher over them, with a policy of its own. Two
 * different reasons to change, so two modules.
 *
 * The visual editor reaches the mutations through Zustand store actions (each
 * wrapped in `mutateActiveTree`); plugins and agents reach them here, so a
 * single shape carries op intent across the VM boundary
 * (`api.cms.content.tree(...).mutate([...])`).
 *
 * `struct-01` — the policy: the STRUCTURAL operations run the same source gate
 * the editor's store actions do (`refuseStructuralEdit`), throwing
 * `SourceStructureError` rather than mutating a studio-imported tree in a way
 * nothing could ever write back to the user's `.tsx`. A plugin or an agent
 * therefore gets the same reason a person would, instead of a mutation that
 * looks applied and is gone on the next parse. Ordinary CMS trees (nanoid ids)
 * are untouched — the rule gates itself on the id grammar.
 */
import type { PageNode } from './pageNode'
import type { NodeTree } from './treeSchema'
import type { TreeOperation } from './operationSchema'
import { getParent } from './selectors'
import {
  clearBreakpointOverride,
  deleteNode,
  duplicateNode,
  insertNode,
  moveNode,
  renameNode,
  setBreakpointOverride,
  toggleNodeHidden,
  toggleNodeLocked,
  updateNodeProps,
  wrapNode,
} from './mutations'
import { SourceStructureError, refuseStructuralEdit, type StructuralEditKind } from './sourceStructure'
import { isStudioPageRootId } from './sourceNodeId'

interface ApplyTreeOperationResult {
  tree: NodeTree<PageNode>
  affectedNodeIds: string[]
}

/** Throw if this structural operation has no honest target in a studio-imported source file. */
function assertSourceStructureWritable(
  tree: NodeTree<PageNode>,
  kind: StructuralEditKind,
  nodeId: string,
): void {
  const node = tree.nodes[nodeId]
  if (!node) return
  const refusal = refuseStructuralEdit({ kind, node })
  if (refusal) throw new SourceStructureError(refusal, nodeId)
}

/** Throw if a new node cannot be added under this parent — including the synthetic root of an imported page. */
function assertSourceInsertable(tree: NodeTree<PageNode>, parentId: string): void {
  const parent = tree.nodes[parentId]
  if (!parent) return
  const refusal = refuseStructuralEdit({
    kind: 'insert',
    node: parent,
    sourceBacked: isStudioPageRootId(tree.rootNodeId),
  })
  if (refusal) throw new SourceStructureError(refusal, parentId)
}

export function applyTreeOperation(
  tree: NodeTree<PageNode>,
  op: TreeOperation,
): ApplyTreeOperationResult {
  switch (op.kind) {
    case 'insertNode': {
      assertSourceInsertable(tree, op.parentId)
      insertNode(tree, op.node, op.parentId, op.index)
      return { tree, affectedNodeIds: [op.parentId, op.node.id] }
    }
    case 'updateNodeProps': {
      updateNodeProps(tree, op.nodeId, op.props)
      return { tree, affectedNodeIds: [op.nodeId] }
    }
    case 'setBreakpointOverride': {
      setBreakpointOverride(tree, op.nodeId, op.breakpoint, op.props)
      return { tree, affectedNodeIds: [op.nodeId] }
    }
    case 'clearBreakpointOverride': {
      clearBreakpointOverride(tree, op.nodeId, op.breakpoint)
      return { tree, affectedNodeIds: [op.nodeId] }
    }
    case 'renameNode': {
      renameNode(tree, op.nodeId, op.name)
      return { tree, affectedNodeIds: [op.nodeId] }
    }
    case 'toggleNodeLocked': {
      toggleNodeLocked(tree, op.nodeId)
      return { tree, affectedNodeIds: [op.nodeId] }
    }
    case 'toggleNodeHidden': {
      toggleNodeHidden(tree, op.nodeId)
      return { tree, affectedNodeIds: [op.nodeId] }
    }
    case 'moveNode': {
      const oldParent = getParent(tree, op.nodeId)
      assertSourceStructureWritable(tree, oldParent?.id === op.parentId ? 'reorder' : 'reparent', op.nodeId)
      moveNode(tree, op.nodeId, op.parentId, op.index)
      return {
        tree,
        affectedNodeIds: oldParent
          ? [op.nodeId, op.parentId, oldParent.id]
          : [op.nodeId, op.parentId],
      }
    }
    case 'duplicateNode': {
      assertSourceStructureWritable(tree, 'duplicate', op.nodeId)
      const newId = duplicateNode(tree, op.nodeId)
      return { tree, affectedNodeIds: [op.nodeId, newId] }
    }
    case 'wrapNode': {
      assertSourceStructureWritable(tree, 'wrap', op.nodeId)
      const wrapperId = wrapNode(tree, op.nodeId, op.wrapper.moduleId, op.wrapper.defaults)
      return { tree, affectedNodeIds: [op.nodeId, wrapperId] }
    }
    case 'deleteNode': {
      const parent = getParent(tree, op.nodeId)
      assertSourceStructureWritable(tree, 'delete', op.nodeId)
      deleteNode(tree, op.nodeId)
      return { tree, affectedNodeIds: parent ? [parent.id] : [] }
    }
  }
}
