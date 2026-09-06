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
 * THE ANCHOR. A move is written to source as "put this element immediately
 * before/after that one", never as an index — the editor's child list and the
 * JSX child list are not the same list (one `{items.map(…)}` child contributes
 * N nodes, `{cond && <X/>}` contributes one of two, whitespace contributes
 * none). `previewStructuralMove` simulates the move against the parent's
 * children, finds the neighbour the moved node lands beside, and checks THAT
 * neighbour is itself an ordinary element in the same file.
 *
 * W4-1 — THREE OF THESE NOW WRITE INSTEAD OF REFUSING. `duplicate`, `wrap` and
 * a cross-parent move (`reparent`) used to refuse on every studio-imported
 * node, because a copy or a wrapper minted on the canvas has no source location
 * to be written back to. They now take `insert`'s route instead: the SOURCE is
 * asked to grow the markup and the board re-reads it. So on a studio tree those
 * three plans return a COMMIT and the caller must NOT also mutate the tree —
 * the same discipline `writeInsertToSource` already follows in `nodeActions`.
 */
import {
  describeStructuralRefusal,
  isSourceDerivedNodeId,
  previewStructuralMove,
  refuseStructuralEdit,
  resolveContainerAnchor,
  resolveSourceContainer,
  type EditConstraint,
  type NodeTree,
  type PageNode,
  type StructuralMoveCommit,
} from '@core/page-tree'
import { pushToast } from '@ui/components/Toast'
import { constraintPrimaryAction, constraintToastBody } from '../../constraintActions'
import { openSourceFile, type SourceFileOpener } from '../../openSourceFile'

/**
 * Where a moved element is written — `@core/page-tree`'s own
 * `StructuralMoveCommit`, re-exported under the name the store's callers use.
 * A same-parent reorder names the sibling it lands beside; a REPARENT (W4-1)
 * also names `destinationParentNodeId`, the container it lands inside.
 */
export type SourceMoveCommit = StructuralMoveCommit

/**
 * A gesture that may proceed. `commit` is the source write to issue AFTER the
 * tree mutation lands, or `null` when there is nothing to write (an ordinary
 * CMS tree, or a move that turned out to change no order).
 *
 * A refusal is carried as the full `EditConstraint`, not the bare
 * `{reason, message}` the rule returns: only the planner still has the NODE in
 * hand, and the node is where `origin` (the `rel:line:col` a "show me" button
 * needs) comes from. Deriving it later, at the toast, would mean re-finding a
 * node the plan already had.
 */
export type StructuralPlan<TCommit> =
  | { ok: true; commit: TCommit | null }
  | { ok: false; constraint: EditConstraint }

/**
 * Whether a move of `nodeIds` into `newParentId` at `newIndex` can be written
 * back to source, and if so, where.
 *
 * **A thin wrapper over `previewStructuralMove` (`@core/page-tree`), and that
 * is the point.** The two used to be line-for-line copies of one rule — the
 * pure one for the drag PREVIEW (verdict while the pointer is still down), this
 * one for the COMMITTED gesture — with a comment in each promising they would
 * be kept in sync by hand. W4-1 collapsed them, because lifting the reparent
 * refusal in one copy and not the other is exactly the drift that comment was
 * describing: the drop line would have gone green on a gesture the store still
 * refused, or the reverse.
 *
 * What the store still adds is the only thing the pure module cannot: the
 * `EditConstraint` dressing, which needs the NODE in hand to derive `origin`
 * (the `rel:line:col` a "show me" button jumps to).
 */
export function planSourceMove(
  tree: NodeTree<PageNode>,
  nodeIds: readonly string[],
  newParentId: string,
  newIndex: number,
): StructuralPlan<SourceMoveCommit> {
  const preview = previewStructuralMove(tree, nodeIds, newParentId, newIndex)
  if (preview.ok) return { ok: true, commit: preview.commit }
  const node = nodeIds[0] === undefined ? undefined : tree.nodes[nodeIds[0]]
  return {
    ok: false,
    constraint: describeStructuralRefusal({ refusal: preview.refusal, ...(node ? { node } : {}) }),
  }
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
    if (refusal) return { ok: false, constraint: describeStructuralRefusal({ refusal, node }) }
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
 * Both halves of the answer are `@core/page-tree`'s, so a drop and a picker
 * insert cannot disagree: `resolveSourceContainer` turns the synthetic page
 * root into the page's own returned root element (and refuses when there is no
 * single one), and `resolveContainerAnchor` decides which existing child the
 * new element is written beside — or that appending is the honest position.
 * This function adds the `EditConstraint` dressing and nothing else.
 */
export function planSourceInsert(
  tree: NodeTree<PageNode>,
  parentId: string,
  index?: number,
): StructuralPlan<SourceInsertCommit> {
  const container = resolveSourceContainer(tree, parentId)
  if (!container.ok) {
    return { ok: false, constraint: describeStructuralRefusal({ refusal: container.refusal }) }
  }

  const node = container.node
  if (!isSourceDerivedNodeId(node.id)) return { ok: true, commit: null }

  const refusal = refuseStructuralEdit({ kind: 'insert', node })
  if (refusal) return { ok: false, constraint: describeStructuralRefusal({ refusal, node }) }

  return { ok: true, commit: { parentNodeId: node.id, ...resolveContainerAnchor(tree, node, index) } }
}

/**
 * Whether `nodeIds` may be duplicated, and if so which of them the SOURCE
 * writes (W4-1).
 *
 * `commit` non-null means "this is a studio-imported tree: do not mutate it".
 * Duplicate follows `insert`'s shape exactly — `duplicateJsxElement` writes the
 * copy into the `.tsx`, the board re-reads it, and the copy arrives as an
 * ordinary parsed node with a real `rel:line:col`. Mutating the tree as well
 * would mint a nanoid twin that the next parse silently deletes.
 *
 * All-or-nothing across the selection, matching `planSourceDelete`: a selection
 * where half the elements can be copied and half cannot has no honest outcome.
 * Several ids in one commit are safe because the save route orders a batch
 * bottom-to-top, so no copy can move the line of one still pending above it.
 */
export function planSourceDuplicate(
  tree: NodeTree<PageNode>,
  nodeIds: readonly string[],
): StructuralPlan<string[]> {
  const commit: string[] = []
  for (const id of nodeIds) {
    const node = tree.nodes[id]
    if (!node) continue
    const refusal = refuseStructuralEdit({ kind: 'duplicate', node })
    if (refusal) return { ok: false, constraint: describeStructuralRefusal({ refusal, node }) }
    if (isSourceDerivedNodeId(node.id)) commit.push(node.id)
  }
  return { ok: true, commit: commit.length > 0 ? commit : null }
}

/**
 * Whether `nodeIds` may be wrapped in a new container, and if so which node the
 * SOURCE writes the wrapper around (W4-1).
 *
 * One node only: `wrapJsxElement` replaces ONE element's own range with that
 * element inside a container. A single wrapper around several elements is one
 * write spanning all of their ranges — and in the code they may not even be
 * neighbours — so a multi-selection refuses (`multi-select`) rather than
 * wrapping the first and pretending.
 */
export function planSourceWrap(
  tree: NodeTree<PageNode>,
  nodeIds: readonly string[],
): StructuralPlan<string> {
  const multi = nodeIds.length > 1
  for (const id of nodeIds) {
    const node = tree.nodes[id]
    if (!node) continue
    const refusal = refuseStructuralEdit({ kind: 'wrap', node, multi })
    if (refusal) return { ok: false, constraint: describeStructuralRefusal({ refusal, node }) }
  }
  const only = nodeIds.length === 1 ? nodeIds[0] : undefined
  return { ok: true, commit: only !== undefined && isSourceDerivedNodeId(only) ? only : null }
}

/** Titles the refusal toasts use, one per gesture. Matches the `Detach refused` / `Swap refused` vocabulary. */
export const STRUCTURAL_REFUSAL_TITLE = {
  move: 'Move refused',
  delete: 'Delete refused',
  insert: 'Cannot add this to imported code',
  duplicate: 'Duplicate refused',
  wrap: 'Wrap refused',
} as const

/**
 * Surface a refused structural gesture. Every path into the store shares this,
 * so the wording cannot drift per surface.
 *
 * Three properties this toast has that an ordinary one does not, all of them
 * because a refusal is not a notification — it is the answer to something the
 * user just tried to do:
 *
 *  - **It does not expire** (`durationMs: null`). A refusal explains why the
 *    canvas did not change; a 6-second window to read a two-clause sentence
 *    about `.map` rows meant most of them were never read at all.
 *  - **It collapses repeats** (`dedupeKey`). Dragging the same locked element
 *    four times is one fact, not four cards; the provider counts the attempts
 *    on the card that is already showing.
 *  - **It carries the way forward** — the constraint's first runnable action,
 *    or failing that a jump to the source position it names. That is the whole
 *    point of `EditConstraint.actions`/`origin`, which nothing rendered until
 *    now.
 */
export function toastStructuralRefusal(
  title: (typeof STRUCTURAL_REFUSAL_TITLE)[keyof typeof STRUCTURAL_REFUSAL_TITLE],
  constraint: EditConstraint,
  /**
   * The store's own `get`. Supplied by every real call site; what makes the
   * toast's jump-to-source button possible from inside a store action without
   * importing the composed store (see `openSourceFile`'s doc). Omitted only in
   * tests that assert the sentence rather than the jump.
   */
  getState?: () => SourceFileOpener,
): void {
  const context = getState
    ? { openSource: (origin: Parameters<typeof openSourceFile>[1]) => openSourceFile(getState(), origin) }
    : {}
  const action = constraintPrimaryAction(constraint, context)
  pushToast({
    kind: 'warning',
    title,
    body: constraintToastBody(constraint, context),
    location: 'site-editor',
    durationMs: null,
    // Same gesture + same reason + same sentence = the same refusal. The
    // sentence is in the key because one reason (`insert`) covers several
    // genuinely different explanations.
    dedupeKey: `structural-refusal:${title}:${constraint.reason}:${constraint.explanation}`,
    ...(action ? { action } : {}),
  })
}
