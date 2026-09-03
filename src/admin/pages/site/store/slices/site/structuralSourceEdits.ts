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
      // Dragging a node that is NOT source-derived into a studio tree. Unlike
      // an insert from the picker — which asks the SOURCE to grow an element
      // and re-reads it — this node already exists only on the canvas, so there
      // is no markup to relocate and no way to mint any.
      refuseCanvasOnlyNodeIntoSource(tree, newParent)
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

/** Where a new element is written: inside which container, optionally beside which existing child. */
export interface SourceInsertCommit {
  /** The container element the new child is written into — a real source node, never the synthetic page root. */
  parentNodeId: string
  /** The existing child the new element is written next to, or `null` to append as the last child. */
  anchorNodeId: string | null
  position: 'before' | 'after'
}

/**
 * Whether a new element may be written into `parentId`, and if so where.
 *
 * Two resolutions happen before the rule is asked:
 *
 *  1. **The synthetic page root becomes the page's returned root element.**
 *     `<pageId>:body` is not a source location — nothing was written at it — so
 *     it can never be a container. A page's JSX returns exactly one root
 *     element, and that element is what "add this to the page" means. When the
 *     root has anything other than exactly one source-derived child (an empty
 *     imported page, or a route composed from layout chrome), there is no
 *     single honest answer and it refuses with what the user can do about it.
 *  2. **The anchor is a refinement, not a requirement.** `index` names a
 *     position among the CANVAS's children, which is not the source's child
 *     list. When the neighbour it points at is an ordinary element in the same
 *     file, the insert is written against it; when it is not (a `.map` row, an
 *     inlined component, an expression child), the element is appended as the
 *     last child instead. Appending is a real position, not a silent no-op —
 *     and the user can then drag it, which already writes.
 */
export function planSourceInsert(
  tree: NodeTree<PageNode>,
  parentId: string,
  index?: number,
): StructuralPlan<SourceInsertCommit> {
  const container = resolveInsertContainer(tree, parentId)
  if (!container.ok) return container

  const node = container.node
  if (!isSourceDerivedNodeId(node.id)) return { ok: true, commit: null }

  const refusal = refuseStructuralEdit({ kind: 'insert', node })
  if (refusal) return { ok: false, refusal }

  return { ok: true, commit: { parentNodeId: node.id, ...resolveInsertAnchor(tree, node, index) } }
}

/** The container an insert into `parentId` really targets — see `planSourceInsert`'s doc for the page-root case. */
function resolveInsertContainer(
  tree: NodeTree<PageNode>,
  parentId: string,
): { ok: true; node: PageNode } | { ok: false; refusal: StructuralRefusal } {
  const parent = tree.nodes[parentId]
  if (!parent) {
    return {
      ok: false,
      refusal: {
        reason: 'insert',
        message: 'The element this would be added to is no longer on the board. Reload the project and try again.',
      },
    }
  }
  if (parentId !== tree.rootNodeId || !isStudioPageRootId(tree.rootNodeId)) return { ok: true, node: parent }

  const sourceChildren = parent.children.filter((id) => isSourceDerivedNodeId(id))
  const only = sourceChildren.length === 1 ? tree.nodes[sourceChildren[0]!] : undefined
  if (!only) {
    return {
      ok: false,
      refusal: {
        reason: 'insert',
        message:
          sourceChildren.length === 0
            ? 'This page has no element in its code to add anything inside. Add a root element to the file first.'
            : 'This page has several top-level elements, so Studio cannot tell which one to add this inside. Select the container you want it in, then add it.',
      },
    }
  }
  return { ok: true, node: only }
}

/** The existing child a new element is written beside, resolved from a canvas child index. */
function resolveInsertAnchor(
  tree: NodeTree<PageNode>,
  container: PageNode,
  index: number | undefined,
): { anchorNodeId: string | null; position: 'before' | 'after' } {
  const children = container.children
  if (index === undefined || index >= children.length) return { anchorNodeId: null, position: 'after' }

  const addressable = (id: string | undefined): boolean =>
    id !== undefined &&
    isSourceDerivedNodeId(id) &&
    refuseStructuralEdit({ kind: 'insert', node: tree.nodes[id] ?? { id } }) === null

  const previous = children[index - 1]
  if (addressable(previous)) return { anchorNodeId: previous!, position: 'after' }
  const next = children[index]
  if (addressable(next)) return { anchorNodeId: next!, position: 'before' }
  return { anchorNodeId: null, position: 'after' }
}

/**
 * Whether `nodeIds` may be duplicated or wrapped, and — for a duplicate on
 * studio-imported nodes — which source copies to commit.
 *
 * `wrap` is still refused on every source-derived node: a wrapper is a NEW
 * element that the wrapped node has to move inside, and moving a node into a
 * different parent is `reparent`, which Studio cannot write yet.
 *
 * `duplicate` is not in that position and no longer pretends to be. The copy
 * is the original's own bytes spliced in after it, so there is nothing to
 * invent — see `duplicateJsxElement`. The ids that come back are the ORIGINALS
 * (that is what the codemod is pointed at); the copies arrive on the board
 * through the reload that follows the write.
 */
export function planSourceCopy(
  tree: NodeTree<PageNode>,
  kind: 'duplicate' | 'wrap',
  nodeIds: readonly string[],
): StructuralPlan<readonly string[]> {
  const sourceIds: string[] = []
  for (const id of nodeIds) {
    const node = tree.nodes[id]
    if (!node) continue
    const refusal = refuseStructuralEdit({ kind, node })
    if (refusal) return { ok: false, refusal }
    if (kind === 'duplicate' && isSourceDerivedNodeId(id)) sourceIds.push(id)
  }
  return { ok: true, commit: sourceIds.length > 0 ? sourceIds : null }
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
/**
 * The refusal for dropping a canvas-only node into a studio-imported tree, or
 * `null` when the destination is an ordinary CMS tree (where a nanoid node is
 * exactly what belongs).
 */
function refuseCanvasOnlyNodeIntoSource(
  tree: NodeTree<PageNode>,
  newParent: PageNode,
): StructuralRefusal | null {
  const intoStudioTree = isSourceDerivedNodeId(newParent.id) || isStudioPageRootId(tree.rootNodeId)
  if (!intoStudioTree) return null
  return {
    reason: 'insert',
    message:
      'This element exists only on the canvas — there is no markup for it in the code, so Studio has nothing to move into the file. Add the component from the picker instead, which writes it to the source.',
  }
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
