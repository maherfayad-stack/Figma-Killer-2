/**
 * structuralHistory — the two halves of "undo a gesture that changed the
 * user's markup, not just its values" (`store-08`).
 *
 * The store's history is a stack of Mutative patch pairs, and for a VALUE edit
 * that is complete: `saveSite` diffs node values, so replaying the inverse
 * patch and letting the autosave write it out is a real, durable undo.
 *
 * A STRUCTURAL edit is not like that. `saveSite` has no notion of parent,
 * order or child list at all — that is exactly why `struct-01` gave moves,
 * deletes and inserts their own one-shot source commits. So replaying a move's
 * inverse patch changes the canvas and nothing else: the `.tsx` still says the
 * element moved, and the next reparse snaps the canvas back to it. The undo
 * has to be the INVERSE WRITE.
 *
 * `tagStructuralGesture` records what that inverse write is at gesture time
 * (the only moment the pre-move position is still known), and
 * `reissueStructuralMove` performs it through the same `moveNodes` action a
 * drag uses — so an undo rides every refusal gate, resolves its own anchor
 * against the tree as it is NOW, and writes to source exactly once.
 *
 * `captureDeleteOrigin` (`store-15`) is the same idea for a DELETE: the tree
 * is still what it was, one moment before `deleteNode`/`deleteNodes` removes
 * the element, so this is the last chance to record where it sat. Unlike a
 * move, a delete's undo does not re-issue through a store action — it is
 * folded into the `source` gesture family (`tagStructuralGesture(set,
 * {gesture:'source', …})`, built in `deleteNodesAction.ts`/`nodeActions.ts`
 * from what this function returns) and writes a `reinsert-source` edit once
 * the delete's own commit reports the bytes it discarded.
 */
import { hasWritableSourceLocation, type NodeTree, type PageNode, type SequencedMove } from '@core/page-tree'
import { resolveActiveTreeTarget } from './helpers'
import type { SiteSliceHelpers, StructuralHistory, StructuralHistoryMove } from './types'

/**
 * Mark the transaction just committed by `mutateActiveTree` as structural.
 *
 * Called AFTER the mutation, because that is when the entry exists — and only
 * when the gesture actually issued a source write, so a CMS/Visual-Component
 * tree (nothing on disk to disagree with) keeps plain patch-replay undo.
 *
 * Also ends any in-progress coalescing burst: a structural gesture is never
 * part of a typing run, and folding one into a text burst would make a single
 * Ctrl+Z revert a drag and five keystrokes together.
 */
export function tagStructuralGesture(
  set: SiteSliceHelpers['set'],
  structural: StructuralHistory,
): void {
  set((state) => {
    const top = state._historyPast[state._historyPast.length - 1]
    if (!top) return
    top.structural = structural
    // `store-15` — a `source` gesture's undo is a WRITE (or nothing), never a
    // patch replay: `structuralSourceHistory.ts`'s own contract for the rest
    // of the family is "the entry carries empty inverse/forward patch lists".
    // `delete` is the one caller of this function that tags a `source`
    // gesture onto an entry that did NOT start that way — its patches are the
    // real tree mutation `mutateActiveTree` already committed, and they name
    // the exact node id this gesture just made permanently gone. Left
    // standing, `historyPreservation.ts`'s reload-safety check reads them as
    // a still-live reference and wipes the WHOLE stack on the very next
    // reparse — including this gesture's own resync, before its `fill` even
    // lands. Clearing them here is safe for every OTHER `source` gesture too:
    // `recordStructuralSourceWrite`'s `push` already builds them empty, so
    // this is a no-op for any entry that reaches this function through them.
    if (structural.gesture === 'source') {
      top.inverse = []
      top.forward = []
    }
    state._historyCoalesceKey = null
  })
}

/**
 * Where `nodeId` sits right now, in the terms `moveNodes` takes.
 *
 * The index is read off the parent's own child list rather than a stored
 * counter, and `moveNode` detaches before it splices — so feeding this pair
 * straight back in restores the exact slot, same-parent reorder or reparent
 * alike.
 */
export function captureMoveOrigin(
  tree: NodeTree<PageNode>,
  nodeId: string,
): StructuralHistoryMove | null {
  const parentId = tree.nodes[nodeId]?.parentId
  if (parentId === undefined || parentId === null) return null
  const index = tree.nodes[parentId]?.children.indexOf(nodeId) ?? -1
  if (index < 0) return null
  return { nodeId, parentId, index }
}

/**
 * What one structural undo/redo step came to (`undoRedoActions.ts`'s
 * `runStructuralStep` reads it):
 *  - `posted` — a write is on its way; `pendingCommitId` is the id its
 *    rollback answers to (ERR-6), when the write carries one;
 *  - `skipped` — the step can never happen as recorded, so the entry is
 *    dropped rather than left to jam the stack (ERR-2, ERR-28). `notice` is
 *    the one sentence saying why, or `null` when the refusal has already been
 *    presented (the move gate's own toast or dialog).
 */
export type StructuralStepOutcome =
  | { kind: 'posted'; pendingCommitId: number | null }
  | { kind: 'skipped'; notice: string | null }

/**
 * Re-issue one direction of a structural move, through the same `moveNodes`
 * a drag uses — so it rides every refusal gate, resolves its anchor against the
 * tree as it is NOW, and writes to source exactly once.
 *
 * ERR-3 — the move is re-issued on the page that OWNS the element, not the
 * active one. Pressing on a frame activates its page, so "drag in frame A,
 * click frame B, ⌘Z" is the normal flow, and it used to answer "Nothing to
 * undo here" while leaving the entry on top of the stack. The owner is found
 * through `_nodeIdToPageIds` (O(1) per id; many-valued for shared layout
 * chrome, so the first page that also holds the destination parent wins) and
 * activated silently, the way Figma takes you to the page an undo changes —
 * `moveNodes` routes through `mutateActiveTree`, which is the one place that
 * decides which tree is active.
 */
export function reissueStructuralMove(
  get: SiteSliceHelpers['get'],
  step: StructuralHistoryMove,
): StructuralStepOutcome {
  const state = get()
  const owner = owningPageOfMove(state, step)
  if (owner === null) {
    return { kind: 'skipped', notice: 'The element it moved is no longer on the board.' }
  }
  if (owner !== ACTIVE_TREE) state.openPageInCanvas(owner)
  const before = get()._historyPast.at(-1)
  get().moveNodes([step.nodeId], step.parentId, step.index)
  const top = get()._historyPast.at(-1)
  // A performed move always commits one transaction; a refused one commits
  // none — and has already said why, in its own toast or dialog.
  if (!top || top === before) return { kind: 'skipped', notice: null }
  return { kind: 'posted', pendingCommitId: top.pendingCommit?.id ?? null }
}

/**
 * P2-C2 / P3-D — re-issue one direction of a move sequence through
 * `moveNodesInSequence`, the action that made it: one write, one entry, every
 * refusal gate. Same owning-page rule as {@link reissueStructuralMove}; every
 * move of a sequence is on one page (a gesture acts within the active tree),
 * so the first move decides it.
 */
export function reissueStructuralMoves(
  get: SiteSliceHelpers['get'],
  moves: readonly SequencedMove[],
): StructuralStepOutcome {
  const [first] = moves
  const owner = first ? owningPageOfMove(get(), first) : null
  if (owner === null || !first) {
    return { kind: 'skipped', notice: 'The elements it moved are no longer on the board.' }
  }
  if (owner !== ACTIVE_TREE) get().openPageInCanvas(owner)
  const before = get()._historyPast.at(-1)
  get().moveNodesInSequence([...moves])
  const top = get()._historyPast.at(-1)
  if (!top || top === before) return { kind: 'skipped', notice: null }
  return { kind: 'posted', pendingCommitId: top.pendingCommit?.id ?? null }
}

const ACTIVE_TREE = Symbol('active-tree')

/** The page `step` can be re-issued on: the active tree when it holds both ends, else the first owning page that does. */
function owningPageOfMove(
  state: ReturnType<SiteSliceHelpers['get']>,
  step: StructuralHistoryMove,
): string | typeof ACTIVE_TREE | null {
  const active = resolveActiveTreeTarget(state)
  if (active?.tree.nodes[step.nodeId] && active.tree.nodes[step.parentId]) return ACTIVE_TREE
  for (const pageId of state._nodeIdToPageIds.get(step.nodeId) ?? []) {
    const page = state.site?.pages.find((candidate) => candidate.id === pageId)
    if (page?.nodes[step.parentId]) return pageId
  }
  return null
}

/**
 * `store-15` — where `nodeId` sits right now, in the terms a `reinsert-source`
 * edit needs: the parent to write into, and the child position among the
 * parent's PLAIN JSX element siblings only — `reinsertJsxSource`'s own
 * `elementChildren` count, which never sees a `.map` row or a conditional
 * branch's element (those sit inside an expression the parent's direct JSX
 * children list does not contain). Call this BEFORE the delete: it is the
 * last moment the pre-delete tree still has the node to ask about.
 *
 * `null` — no origin an undo could use — for three cases, none of them
 * partial:
 *  - the node has no parent (should not happen; a delete never targets the
 *    tree root);
 *  - the parent has no writable source position at all — the synthetic page
 *    root, whose only "position" is the page's own return statement.
 *    Deleting the page's sole returned element is already refused there by
 *    `deleteJsxElement`'s own `no-jsx-parent` (the AST answers a question the
 *    tree cannot), so a delete that reaches here with such a parent is one
 *    the write is about to refuse anyway — recording no origin for it is
 *    honest, not a gap;
 *  - the node itself does not turn up among its own parent's plain-element
 *    siblings, which cannot happen for a node `refuseStructuralEdit` already
 *    let through as `kind: 'delete'` — checked anyway, because a wrong index
 *    would restore the wrong thing.
 */
export interface StructuralHistoryDeleteOrigin {
  nodeId: string
  parentId: string
  index: number
}

export function captureDeleteOrigin(
  tree: NodeTree<PageNode>,
  nodeId: string,
): StructuralHistoryDeleteOrigin | null {
  const parentId = tree.nodes[nodeId]?.parentId
  if (parentId === undefined || parentId === null) return null
  if (!hasWritableSourceLocation(parentId)) return null
  const siblings = (tree.nodes[parentId]?.children ?? []).filter((id) => isPlainJsxSibling(tree.nodes[id]))
  const index = siblings.indexOf(nodeId)
  return index < 0 ? null : { nodeId, parentId, index }
}

/** A parent's own direct JSX element/self-closing child — never a `.map` row, a conditional branch, or anything else `lockReason` marks as structurally decided elsewhere. */
function isPlainJsxSibling(node: PageNode | undefined): boolean {
  return node !== undefined && hasWritableSourceLocation(node.id) && !node.lockReason
}
