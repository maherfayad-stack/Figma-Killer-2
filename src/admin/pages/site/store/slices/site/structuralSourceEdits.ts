/**
 * The store's structural-edit gate for studio-imported trees: what a move,
 * delete, insert, duplicate or wrap has to satisfy BEFORE the tree is mutated,
 * and — when it does — which source write to commit.
 *
 * `struct-01`. Before this, `StudioEdit` had no structural kind at all and
 * `saveSite` diffed values only, so a drag in the layers tree updated the tree,
 * reported a successful save, changed no byte of the user's `.tsx`, and lost
 * the move on reload. In Studio the repository IS the document, so that was a
 * silent no-op — the exact failure the "one honest write target" invariant
 * exists to prevent.
 *
 * The store is the right place for both halves. It is the chokepoint every
 * mutation path already runs through — layers-tree drag, canvas reorder drag,
 * context menus, the Delete key, spotlight, the agent executor — so a refusal
 * decided here is a refusal for all of them, and a commit issued here happens
 * exactly once per gesture no matter which surface produced it. The same
 * reasoning `nodeActions`'s outlet guard already records.
 *
 * WHAT IS PURE AND WHAT IS NOT. The rule itself is `refuseStructuralEdit` in
 * `@core/page-tree` — it reads node ids and `lockReason` and nothing else, and
 * the plugin/agent route (`applyTreeOperation`) consults the same function so
 * it rides the same gate. This module only resolves the arguments that rule
 * needs out of a live tree (which sibling a reorder is written against, which
 * nodes a multi-delete really touches) and hands the result to the one-shot
 * commits in `@site/studio/studioSaveRequests`.
 *
 * THE ANCHOR. A reorder is written to source as "put this element immediately
 * before/after that one", never as an index — the editor's child list and the
 * JSX child list are not the same list (one `{items.map(…)}` child contributes
 * N nodes, `{cond && <X/>}` contributes one of two, whitespace contributes
 * none). So the plan simulates the move against the parent's children, finds
 * the neighbour the moved node lands beside, and checks THAT neighbour is
 * itself an ordinary element in the same file.
 */
import {
  isSourceDerivedNodeId,
  isStudioPageRootId,
  refuseStructuralEdit,
  type NodeTree,
  type PageNode,
  type StructuralRefusal,
} from '@core/page-tree'
import { pushToast } from '@ui/components/Toast'

/** Where a reordered element is written: next to which sibling, on which side. */
export interface SourceMoveCommit {
  nodeId: string
  anchorNodeId: string
  position: 'before' | 'after'
}

/**
 * A gesture that may proceed. `commit` is the source write to issue AFTER the
 * tree mutation lands, or `null` when there is nothing to write (an ordinary
 * CMS tree, or a move that turned out to change no order).
 */
export type StructuralPlan<TCommit> =
  | { ok: true; commit: TCommit | null }
  | { ok: false; refusal: StructuralRefusal }

/**
 * Whether a move of `nodeIds` into `newParentId` at `newIndex` can be written
 * back to source, and if so, against which sibling.
 *
 * Note the order of the questions: reparenting is refused before anything
 * else is computed, because "which sibling does it land beside" is not even
 * the right question for a node whose parent changed — there is no JSX child
 * position for it in the new parent until Studio can create one.
 */
export function planSourceMove(
  tree: NodeTree<PageNode>,
  nodeIds: readonly string[],
  newParentId: string,
  newIndex: number,
): StructuralPlan<SourceMoveCommit> {
  const nodeId = nodeIds[0]
  if (nodeId === undefined) return { ok: true, commit: null }
  const node = tree.nodes[nodeId]
  const newParent = tree.nodes[newParentId]
  // A stale drop target — the existing mutations already throw or no-op on
  // this, and inventing a refusal for it would explain the wrong thing.
  if (!node || !newParent) return { ok: true, commit: null }

  // "Same parent?" read off the child list rather than the denormalised
  // `parentId` pointer: the list is the thing the reorder is actually about,
  // and it cannot be stale relative to itself.
  if (!newParent.children.includes(nodeId)) {
    const refusal =
      refuseStructuralEdit({ kind: 'reparent', node }) ??
      // Dragging a node that is NOT source-derived into a parent that is: from
      // source's point of view that is an insertion, not a move.
      refuseStructuralEdit({ ...studioParent(tree, newParentId), kind: 'insert' })
    return refusal ? { ok: false, refusal } : { ok: true, commit: null }
  }

  const multi = nodeIds.length > 1
  const reordered = simulateReorder(newParent.children, nodeIds, newIndex)
  if (reordered === null) return { ok: true, commit: null }

  const index = reordered.indexOf(nodeId)
  const candidates: SourceMoveCommit[] = []
  const previous = reordered[index - 1]
  if (previous !== undefined) candidates.push({ nodeId, anchorNodeId: previous, position: 'after' })
  const next = reordered[index + 1]
  if (next !== undefined) candidates.push({ nodeId, anchorNodeId: next, position: 'before' })

  let firstRefusal: StructuralRefusal | null = null
  for (const candidate of candidates) {
    const refusal = refuseStructuralEdit({
      kind: 'reorder',
      node,
      anchor: tree.nodes[candidate.anchorNodeId] ?? { id: candidate.anchorNodeId },
      multi,
    })
    if (!refusal) return { ok: true, commit: isSourceDerivedNodeId(nodeId) ? candidate : null }
    firstRefusal ??= refusal
  }

  const refusal = firstRefusal ?? refuseStructuralEdit({ kind: 'reorder', node, anchor: null, multi })
  return refusal ? { ok: false, refusal } : { ok: true, commit: null }
}

/**
 * Whether deleting every node in `nodeIds` can be written back to source.
 *
 * All-or-nothing, matching `isPropPatchWritableToSource`'s doctrine: a
 * selection where half the elements can be removed and half cannot has no
 * honest outcome — applying the writable half leaves the canvas showing a tree
 * the file does not describe.
 */
export function planSourceDelete(
  nodes: readonly (PageNode | undefined)[],
): StructuralPlan<string[]> {
  const commit: string[] = []
  for (const node of nodes) {
    if (!node) continue
    const refusal = refuseStructuralEdit({ kind: 'delete', node })
    if (refusal) return { ok: false, refusal }
    if (isSourceDerivedNodeId(node.id)) commit.push(node.id)
  }
  return { ok: true, commit: commit.length > 0 ? commit : null }
}

/** Whether a new node may be added under `parentId` — refused on every studio-imported tree. */
export function planSourceInsert(tree: NodeTree<PageNode>, parentId: string): StructuralPlan<never> {
  const refusal = refuseStructuralEdit({ ...studioParent(tree, parentId), kind: 'insert' })
  return refusal ? { ok: false, refusal } : { ok: true, commit: null }
}

/** Whether `nodeIds` may be duplicated or wrapped — refused on every studio-imported node. */
export function planSourceCopy(
  tree: NodeTree<PageNode>,
  kind: 'duplicate' | 'wrap',
  nodeIds: readonly string[],
): StructuralPlan<never> {
  for (const id of nodeIds) {
    const node = tree.nodes[id]
    if (!node) continue
    const refusal = refuseStructuralEdit({ kind, node })
    if (refusal) return { ok: false, refusal }
  }
  return { ok: true, commit: null }
}

/** Titles the refusal toasts use, one per gesture. Matches the `Detach refused` / `Swap refused` vocabulary. */
export const STRUCTURAL_REFUSAL_TITLE = {
  move: 'Move refused',
  delete: 'Delete refused',
  insert: 'Cannot add this to imported code',
  duplicate: 'Duplicate refused',
  wrap: 'Wrap refused',
} as const

/** Surface a refused structural gesture. Every path into the store shares this, so the wording cannot drift per surface. */
export function toastStructuralRefusal(
  title: (typeof STRUCTURAL_REFUSAL_TITLE)[keyof typeof STRUCTURAL_REFUSAL_TITLE],
  refusal: StructuralRefusal,
): void {
  pushToast({ kind: 'warning', title, body: refusal.message, location: 'site-editor' })
}

/**
 * The node an insert would be written next to, plus whether the tree is a
 * studio-imported one at all.
 *
 * The synthetic page root (`<pageId>:body`) is the awkward case: it is where
 * an insert into an EMPTY imported page lands, and its id carries no source
 * location to recognise it by — hence `isStudioPageRootId`, which the page-tree
 * module owns alongside the rest of the id grammar.
 */
function studioParent(
  tree: NodeTree<PageNode>,
  parentId: string,
): { node: { id: string }; sourceBacked: boolean } {
  const parent = tree.nodes[parentId]
  if (!parent) return { node: { id: parentId }, sourceBacked: false }
  if (isSourceDerivedNodeId(parent.id)) return { node: parent, sourceBacked: true }
  return { node: parent, sourceBacked: isStudioPageRootId(tree.rootNodeId) }
}

/**
 * The parent's child order AFTER `moveNodes` would run, or `null` when the
 * order does not actually change (dropping a row back where it started).
 *
 * Mirrors `moveNode`'s own arithmetic exactly — remove first, then splice at a
 * clamped index — because an anchor derived from different arithmetic than the
 * mutation uses would write a different order than the canvas shows.
 */
function simulateReorder(children: readonly string[], nodeIds: readonly string[], newIndex: number): string[] | null {
  const moving = nodeIds.filter((id) => children.includes(id))
  if (moving.length === 0) return null
  const without = children.filter((id) => !moving.includes(id))
  const at = Math.max(0, Math.min(newIndex, without.length))
  const next = [...without.slice(0, at), ...moving, ...without.slice(at)]
  return next.every((id, i) => id === children[i]) ? null : next
}
