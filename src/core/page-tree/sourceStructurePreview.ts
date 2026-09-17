/**
 * sourceStructurePreview — the same rule as `sourceStructure.ts`, asked of a
 * LIVE TREE instead of a single node id.
 *
 * Split out of it (K3) at the module-size ceiling, along the seam the two
 * halves already had. `sourceStructure.ts` answers "can THIS node's place be
 * written?" from the id grammar and the parser's own `lockReason` — pure,
 * argument-free, no tree. The functions here answer the questions a GESTURE
 * asks, which only a tree can: which sibling a reorder lands beside, which
 * element "inside the page" really means, and (K3) whether a multi-selection
 * is one unbroken run of siblings. They consult `refuseStructuralEdit` /
 * `refusePlacement` rather than re-deciding anything, so there is still
 * exactly one copy of the rule.
 *
 * Every export here is a PUBLISHED CONTRACT (D2 → F2, then K3): a drag
 * preview, a context menu, the store's plan functions and the codemod-side
 * writeback all read one verdict, which is what keeps a lifted refusal from
 * being lifted in one surface and forgotten in another.
 */
import { isSourceDerivedNodeId, isStudioPageRootId } from './sourceNodeId'
import { getParent } from './selectors'
import {
  refusePlacement,
  refuseStructuralEdit,
  type StructuralRefusal,
} from './sourceStructure'
import type { PageNode } from './pageNode'
import type { NodeTree } from './treeSchema'

/**
 * Where a moved element is written.
 *
 * A REORDER names a sibling: "put this immediately before/after that one",
 * never an index, because the editor's child list and the JSX child list are
 * not the same list. A REPARENT (W4-1) additionally names the container it
 * lands in — `destinationParentNodeId` — because the sibling alone does not
 * say which element it is now a child of, and because a destination with no
 * addressable child of its own still has an honest answer: append.
 */
export interface StructuralMoveCommit {
  nodeId: string
  /** The new parent, for a cross-parent move. Absent for a same-parent reorder. */
  destinationParentNodeId?: string
  /** The existing child to land beside, or `null` to append as the last child (reparent only). */
  anchorNodeId: string | null
  position: 'before' | 'after'
}

/**
 * A gesture that may proceed. `commit` is the source write to issue AFTER the
 * tree mutation lands, or `null` when there is nothing to write (an ordinary
 * CMS tree, or a move that turned out to change no order).
 */
export type StructuralMovePreview =
  | { ok: true; commit: StructuralMoveCommit | null }
  | { ok: false; refusal: StructuralRefusal }

/**
 * Whether a move of `nodeIds` into `newParentId` at `newIndex` would be
 * written back to source, and if so, against which sibling — PURE, tree-only.
 *
 * **Published contract (D2 → F2, `STUDIO-FIGMA-PARITY-PLAN.md` §D2/G5).**
 * Extracted from the store's `structuralSourceEdits.ts`'s `planSourceMove` so
 * a DROP RESOLVER (`core/page-tree/dnd.ts`, and anything F2 builds on top of
 * it) can ask "would this move actually write?" WHILE THE POINTER IS STILL
 * DOWN, not just after `pointerup`. Before this, `core/page-tree/dnd.ts` only
 * checked tree SHAPE (root, locked, cycle, VC-ref/slot rules) — never source
 * writability — so a confident drop-line preview would render right up to the
 * moment of a post-hoc refusal toast. Per `STATE.md`'s `shared-component`
 * refusal-rate finding, that was true for roughly HALF of all real drags.
 *
 * **`structuralSourceEdits.ts`'s `planSourceMove` is now a thin wrapper over
 * this function** (W4-1 collapsed the disclosed duplication its predecessor
 * documented). The store adds exactly one thing this pure module cannot: the
 * `EditConstraint` dressing (`describeStructuralRefusal`), which needs the NODE
 * to derive `origin` from. Keeping one copy of the rule is what makes a lifted
 * refusal — reparent, here — impossible to lift in the drag preview and forget
 * in the committed gesture, which is precisely how the two copies would have
 * disagreed.
 *
 * **What a caller gets:** the exact same 4 structural-source reasons
 * `refuseStructuralEdit`/`refusePlacement` already answer
 * (`list-row`/`shared-component`/`route-chrome`/`code-placed`), plus
 * `reparent`/`no-sibling-anchor`/`cross-file`/`multi-select` for the
 * move-specific questions "is the container it lands in an ordinary element in
 * the same file" and "is there an ordinary sibling to write the move
 * against". A tree-shape
 * rejection (locked node, cycle, dropping into a non-container) is NOT this
 * function's job — `resolvePageTreeDropTarget` already answers that and
 * returns `null` before a caller should even reach this. Call this ONLY
 * after `resolvePageTreeDropTarget` returns a non-null target, with that
 * target's own `parentId`/`index`.
 *
 * **What F2 gets for free by depending on this instead of re-deriving it:**
 * the identical refusal vocabulary a failed mouse-drag already shows, so a
 * differently-triggered move (agent, plugin, future command) refuses with the
 * same sentence a human sees for the same underlying reason.
 */
export function previewStructuralMove(
  tree: NodeTree<PageNode>,
  nodeIds: readonly string[],
  newParentId: string,
  newIndex: number,
): StructuralMovePreview {
  const nodeId = nodeIds[0]
  if (nodeId === undefined) return { ok: true, commit: null }
  const node = tree.nodes[nodeId]
  const newParent = tree.nodes[newParentId]
  // A stale drop target — the mutation itself already throws or no-ops on
  // this; inventing a refusal for it would explain the wrong thing.
  if (!node || !newParent) return { ok: true, commit: null }

  const multi = nodeIds.length > 1

  // "Same parent?" read off the child list rather than the denormalised
  // `parentId` pointer: the list is the thing the move is actually about, and
  // it cannot be stale relative to itself.
  if (!newParent.children.includes(nodeId)) {
    // Dragging a node that is NOT source-derived into a studio tree. Unlike a
    // reparent — which relocates markup the file already contains — this node
    // exists only on the canvas, so there is nothing to relocate. Asked first
    // because it is about the node's ORIGIN, not about the destination.
    const canvasOnly = isSourceDerivedNodeId(nodeId)
      ? null
      : previewCanvasOnlyNodeIntoSourceRefusal(tree, newParent)
    if (canvasOnly) return { ok: false, refusal: canvasOnly }
    if (!isSourceDerivedNodeId(nodeId)) return { ok: true, commit: null }

    // The synthetic page root is a container the same way it is for an insert:
    // resolved to the page's own returned root element before it is judged.
    const container = resolveSourceContainer(tree, newParentId)
    if (!container.ok) return { ok: false, refusal: container.refusal }

    const refusal = refuseStructuralEdit({ kind: 'reparent', node, destination: container.node, multi })
    if (refusal) return { ok: false, refusal }
    return {
      ok: true,
      commit: {
        nodeId,
        destinationParentNodeId: container.node.id,
        // `newIndex` counts the DROP PARENT's children. When the container had
        // to be re-resolved (the page root became the page's root element), that
        // index names a position in a different list, so it is dropped rather
        // than applied to the wrong one — appending is an honest position, and
        // the user can drag within the new parent, which already writes.
        ...resolveContainerAnchor(tree, container.node, container.node.id === newParentId ? newIndex : undefined),
      },
    }
  }

  const reordered = simulateStructuralReorder(newParent.children, nodeIds, newIndex)
  if (reordered === null) return { ok: true, commit: null }

  const index = reordered.indexOf(nodeId)
  // A reorder always names a real sibling — `anchorNodeId` is only nullable for
  // the reparent case above, where appending is a position of its own.
  const candidates: { anchorNodeId: string; position: 'before' | 'after' }[] = []
  const previous = reordered[index - 1]
  if (previous !== undefined) candidates.push({ anchorNodeId: previous, position: 'after' })
  const next = reordered[index + 1]
  if (next !== undefined) candidates.push({ anchorNodeId: next, position: 'before' })

  let firstRefusal: StructuralRefusal | null = null
  for (const candidate of candidates) {
    const refusal = refuseStructuralEdit({
      kind: 'reorder',
      node,
      anchor: tree.nodes[candidate.anchorNodeId] ?? { id: candidate.anchorNodeId },
      multi,
    })
    if (!refusal) return { ok: true, commit: isSourceDerivedNodeId(nodeId) ? { nodeId, ...candidate } : null }
    firstRefusal ??= refusal
  }

  const refusal = firstRefusal ?? refuseStructuralEdit({ kind: 'reorder', node, anchor: null, multi })
  return refusal ? { ok: false, refusal } : { ok: true, commit: null }
}

/**
 * The container a write into `parentId` really targets, or why there isn't one.
 *
 * **The synthetic page root becomes the page's returned root element.**
 * `<pageId>:body` is not a source location — nothing was written at it — so it
 * can never be a container. A page's JSX returns exactly one root element, and
 * that element is what "put this in the page" means. When the root has anything
 * other than exactly one source-derived child (an empty imported page, or a
 * route composed entirely from layout chrome), there is no single honest answer
 * and it refuses with what the user can do about it.
 *
 * Shared by every write that names a container: `planSourceInsert` (which
 * dresses these refusals as `EditConstraint`s) and `previewStructuralMove`'s
 * reparent branch. One resolution, so dropping a node on a page's background
 * and adding one from the picker cannot disagree about which element that means.
 */
export function resolveSourceContainer(
  tree: NodeTree<PageNode>,
  parentId: string,
): { ok: true; node: PageNode } | { ok: false; refusal: StructuralRefusal } {
  const parent = tree.nodes[parentId]
  if (!parent) {
    // No node to point at: the whole refusal is that there ISN'T one any more.
    return {
      ok: false,
      refusal: {
        reason: 'insert',
        message: 'The element this would go inside is no longer on the board. Reload the project and try again.',
      },
    }
  }
  if (parentId !== tree.rootNodeId || !isStudioPageRootId(tree.rootNodeId)) return { ok: true, node: parent }

  const sourceChildren = parent.children.filter((id) => isSourceDerivedNodeId(id))
  const only = sourceChildren.length === 1 ? tree.nodes[sourceChildren[0]!] : undefined
  if (!only) {
    // Same "no single node to point at" case: the page root is synthetic, and
    // the several real candidates are exactly what makes this ambiguous.
    return {
      ok: false,
      refusal: {
        reason: 'insert',
        message:
          sourceChildren.length === 0
            ? 'This page has no element in its code to put anything inside. Add a root element to the file first.'
            : 'This page has several top-level elements, so Studio cannot tell which one this belongs inside. Select the container you want, then try again.',
      },
    }
  }
  return { ok: true, node: only }
}

/**
 * The existing child a written element is placed beside, resolved from a canvas
 * child index — shared by an insert and by a reparent, because "which neighbour
 * does this land next to" is the same question for both.
 *
 * `index` names a position among the CANVAS's children, which is not the
 * source's child list. When the neighbour it points at is an ordinary element,
 * the write is made against it; when it is not (a `.map` row, an inlined
 * component, an expression child), the element is appended as the last child
 * instead. Appending is a real position, not a silent no-op — and the user can
 * then drag it within its new parent, which already writes.
 */
export function resolveContainerAnchor(
  tree: NodeTree<PageNode>,
  container: PageNode,
  index: number | undefined,
): { anchorNodeId: string | null; position: 'before' | 'after' } {
  const children = container.children
  if (index === undefined || index >= children.length) return { anchorNodeId: null, position: 'after' }

  const addressable = (id: string | undefined): boolean =>
    id !== undefined && isSourceDerivedNodeId(id) && refusePlacement(tree.nodes[id] ?? { id }, 'Moved') === null

  const previous = children[index - 1]
  if (addressable(previous)) return { anchorNodeId: previous!, position: 'after' }
  const next = children[index]
  if (addressable(next)) return { anchorNodeId: next!, position: 'before' }
  return { anchorNodeId: null, position: 'after' }
}

/**
 * Reason-only counterpart of `structuralSourceEdits.ts`'s
 * `refuseCanvasOnlyNodeIntoSource` — see `previewStructuralMove`'s doc for why
 * the two aren't the same function. `reason: 'insert'` matches what
 * `refuseStructuralEdit`'s own `insert` case would say for the same
 * situation (a write with no addressable source target), since "a canvas-only
 * node has nothing to move into a studio file" is the insert refusal's
 * question asked about a drag instead of the picker.
 */
function previewCanvasOnlyNodeIntoSourceRefusal(
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
 * The parent's child order AFTER a move would run, or `null` when the order
 * does not actually change (dropping a row back where it started). Mirrors
 * `moveNode`/`moveNodes`'s own arithmetic exactly (`mutations.ts`: remove
 * every dragged id first, then splice at a clamped index) — an anchor derived
 * from different arithmetic than the mutation uses would preview a different
 * order than the one that actually lands.
 */
function simulateStructuralReorder(
  children: readonly string[],
  nodeIds: readonly string[],
  newIndex: number,
): string[] | null {
  const moving = nodeIds.filter((id) => children.includes(id))
  if (moving.length === 0) return null
  const without = children.filter((id) => !moving.includes(id))
  const at = Math.max(0, Math.min(newIndex, without.length))
  const next = [...without.slice(0, at), ...moving, ...without.slice(at)]
  return next.every((id, i) => id === children[i]) ? null : next
}

// ---------------------------------------------------------------------------
// K3 — ⌘G. The half of the group rule that needs the tree: are these elements
// siblings, and are they next to each other?
// ---------------------------------------------------------------------------

/**
 * A group that may proceed. `commit` is the ordered list of source nodes the
 * wrapper is written around — `null` when there is nothing to write (an
 * ordinary CMS tree, or an empty/unknown selection), exactly like
 * {@link StructuralMovePreview}'s own `null` commit.
 */
export type StructuralGroupPreview =
  | { ok: true; commit: string[] | null }
  /**
   * `nodeId` is the member the refusal is ABOUT, when one member is — a `.map`
   * row or a shared component inside an otherwise fine run. The caller needs
   * it to dress the constraint (`origin`, the row's jump-to-source) and to
   * build the retry closure a detach/extract remedy re-issues the gesture
   * with. Absent when the refusal is about the SELECTION rather than any one
   * member (a gap, two parents).
   */
  | { ok: false; refusal: StructuralRefusal; nodeId?: string }

/**
 * Whether one container can be written around `nodeIds`, and if so around
 * WHICH SPAN — pure, tree-only.
 *
 * `wrapJsxElement` writes a wrapper around ONE element's own range; K3's
 * `wrapJsxElements` writes one around a SPAN, which is honest for exactly one
 * shape of selection and no other:
 *
 *   - **Same parent.** Two elements nested differently in the code have no
 *     single span between them, however adjacent they look on the canvas.
 *   - **Next to each other.** A gap means an element the user did not select
 *     sits inside the span, so the wrapper would land around it too — N
 *     targets for a gesture that named one.
 *
 * Both refuse as `multi-select` with the same remedy sentence, because to the
 * person holding ⌘G they are one fact: these are not a run. The refusals only
 * a PARSE can answer (an expression child between them, a run whose members
 * disagree about owning their line) stay with the codemod and arrive at save
 * time — see `src/core/ast-codemods/wrapJsxElements.ts`.
 *
 * A selection of ONE is a legitimate group and returns a one-element commit:
 * the store writes it through the existing single-element `wrap`, so ⌘G on one
 * node is the write that already shipped.
 */
export function previewStructuralGroup(
  tree: NodeTree<PageNode>,
  nodeIds: readonly string[],
): StructuralGroupPreview {
  const nodes = nodeIds.map((id) => tree.nodes[id]).filter((node): node is PageNode => node !== undefined)
  if (nodes.length === 0) return { ok: true, commit: null }

  const sourceNodes = nodes.filter((node) => isSourceDerivedNodeId(node.id))
  // An ordinary CMS tree: nothing to write, the caller takes its normal
  // in-memory path.
  if (sourceNodes.length === 0) return { ok: true, commit: null }
  if (sourceNodes.length !== nodes.length) {
    return {
      ok: false,
      refusal: {
        reason: 'group',
        message:
          "Some of these elements come from your project's code and some exist only on the canvas, so there is no single container Studio could write around them. Group the imported ones on their own.",
      },
    }
  }

  const multi = nodes.length > 1
  for (const node of nodes) {
    const refusal = refuseStructuralEdit({ kind: 'group', node, multi })
    if (refusal) return { ok: false, refusal, nodeId: node.id }
  }

  const parent = getParent(tree, nodes[0]!.id)
  if (!parent) {
    return {
      ok: false,
      nodeId: nodes[0]!.id,
      refusal: {
        reason: 'group',
        message:
          'This element is the outermost thing its component returns, so it has no siblings in the code to be grouped with — and a container around it would have to replace what the component returns.',
      },
    }
  }
  if (nodes.some((node) => getParent(tree, node.id) !== parent)) {
    return { ok: false, refusal: NOT_A_RUN }
  }

  const selected = new Set(nodes.map((node) => node.id))
  const positions = parent.children
    .map((childId, index) => (selected.has(childId) ? index : -1))
    .filter((index) => index >= 0)
  if (positions.length !== selected.size) return { ok: false, refusal: NOT_A_RUN }
  if (positions[positions.length - 1]! - positions[0]! + 1 !== positions.length) {
    return { ok: false, refusal: NOT_A_RUN }
  }

  // Ordered by the CHILD LIST, not by the order the user clicked: the wrapper
  // is written around a span, and a span runs in source order.
  return { ok: true, commit: parent.children.filter((childId) => selected.has(childId)) }
}

/**
 * The one sentence both "not siblings" and "not adjacent" get. One fact to the
 * user, one remedy: put them next to each other first — which is a drag that
 * already writes.
 */
const NOT_A_RUN: StructuralRefusal = {
  reason: 'multi-select',
  message:
    'Studio writes a group as one container around a run of elements that sit next to each other in the code, and these do not. Select siblings next to each other, or move them together first.',
}
