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
 */
import type { NodeTree, PageNode } from '@core/page-tree'
import { pushToast } from '@ui/components/Toast'
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
 * Re-issue one direction of a structural move. Returns whether the gesture was
 * actually performed — `false` means the stack must be left exactly as it was,
 * because nothing happened.
 *
 * Two ways it can decline, both of them honest rather than silent:
 *  - the entry addresses a tree that is no longer open (the user switched page
 *    or opened a Visual Component), which would otherwise move the wrong
 *    element or throw inside a Mutative recipe;
 *  - `moveNodes` itself refuses (a locked node, a `.map` row, an anchor the
 *    AST will not accept) — it has already explained why in its own toast, and
 *    pushing a second one here would double it.
 */
export function reissueStructuralMove(
  get: SiteSliceHelpers['get'],
  step: StructuralHistoryMove,
): boolean {
  const state = get()
  const target = resolveActiveTreeTarget(state)
  if (!target || !target.tree.nodes[step.nodeId] || !target.tree.nodes[step.parentId]) {
    pushToast({
      kind: 'warning',
      title: 'Nothing to undo here',
      body: 'That move happened on a document that is no longer open. Open it again to undo it.',
      location: 'site-editor',
    })
    return false
  }
  const before = get()._historyPast.length
  state.moveNodes([step.nodeId], step.parentId, step.index)
  // A performed move always commits one transaction; a refused one commits
  // none. That count IS the outcome — no second return channel needed.
  return get()._historyPast.length > before
}

/**
 * A structural gesture whose inverse the writeback protocol cannot express.
 *
 * Undoing a source DELETE means writing the element's original markup back
 * into the file, and no `StudioEdit` kind carries a subtree's source text
 * (`insert` names a component plus literal props). Replaying the inverse patch
 * would re-add nodes the `.tsx` does not contain — a canvas that disagrees
 * with the file it mirrors, which is the one thing this editor refuses to do.
 * So it says so, and leaves the stack where it is.
 */
export function refuseStructuralUndo(gesture: 'delete'): void {
  pushToast({
    kind: 'warning',
    title: 'Undo can’t restore this yet',
    body:
      gesture === 'delete'
        ? 'The element was removed from your project source. Use your editor’s undo or `git` to bring it back.'
        : 'This change was written to your project source and cannot be reversed from the canvas.',
    location: 'site-editor',
    durationMs: null,
    dedupeKey: `structural-undo-unsupported:${gesture}`,
  })
}
