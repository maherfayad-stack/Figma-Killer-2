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
import { startTransition } from 'react'
import {
  decodeSourceNodeId,
  describeStructuralRefusal,
  isSourceDerivedNodeId,
  previewStructuralGroup,
  previewStructuralMove,
  previewStructuralTransplant,
  refuseStructuralEdit,
  resolveContainerAnchor,
  resolveSourceContainer,
  type EditConstraint,
  type EditConstraintAction,
  type ListRowEditPlan,
  type NodeTree,
  type PageNode,
  type StructuralMoveCommit,
  type StructuralTransplantCommit,
} from '@core/page-tree'
import { pushToast } from '@ui/components/Toast'
import { constraintPrimaryAction, constraintToastBody } from '../../constraintActions'
import { openSourceFile } from '../../openSourceFile'
import type { EditorStore } from '@site/store/types'
import { applyToThisInstanceOnly } from './instanceOnlyGesture'
import { nodeHtmlTag } from './nodeHtmlTag'
import type { EditorStoreSetter } from './types'

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
 *
 * `nodeId` (R2, `store-10`) is the id of the node the refusal is ABOUT — the
 * one `presentStructuralRefusal`'s caller needs to build a `retry` closure
 * against once a detach/extract lands. Optional because one failure branch
 * genuinely has no node: `planSourceInsert`'s `resolveSourceContainer`
 * failure fires before any container node was resolved at all.
 */
export type StructuralPlan<TCommit> =
  | { ok: true; commit: TCommit | null }
  | { ok: false; constraint: EditConstraint; nodeId?: string }

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
): StructuralPlan<SourceMoveCommit> & { listRow?: ListRowEditPlan } {
  const preview = previewStructuralMove(tree, nodeIds, newParentId, newIndex)
  // OD-8 — `listRow` is a reorder of `.map` rows, written to their array:
  // `commit` is `null` and the caller must NOT mutate the tree.
  if (preview.ok) return { ok: true, commit: preview.commit, ...(preview.listRow ? { listRow: preview.listRow } : {}) }
  const node = nodeIds[0] === undefined ? undefined : tree.nodes[nodeIds[0]]
  return {
    ok: false,
    constraint: describeStructuralRefusal({ refusal: preview.refusal, ...(node ? { node } : {}) }),
    ...(node ? { nodeId: node.id } : {}),
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
    if (refusal) {
      return { ok: false, constraint: describeStructuralRefusal({ refusal, node }), nodeId: node.id }
    }
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
  if (refusal) {
    return { ok: false, constraint: describeStructuralRefusal({ refusal, node }), nodeId: node.id }
  }

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
    if (refusal) {
      return { ok: false, constraint: describeStructuralRefusal({ refusal, node }), nodeId: node.id }
    }
    if (isSourceDerivedNodeId(node.id)) commit.push(node.id)
  }
  return { ok: true, commit: commit.length > 0 ? commit : null }
}

/** Where one Alt-dragged or pasted COPY is written: inside which container, beside which existing child. */
export interface SourceDuplicateToCommit {
  /** The element being copied. */
  nodeId: string
  /** The container the copy lands in — a real source node, never the synthetic page root. */
  parentNodeId: string
  /** The existing child the copy is written next to, or `null` to append as the last child. */
  anchorNodeId: string | null
  position: 'before' | 'after'
  /**
   * ERR-16 — the container is written in ANOTHER file than the element, so the
   * copy is a `transplant` with `copy: true`: it carries the imports the markup
   * needs there, and refuses by name when a local it reads cannot travel.
   */
  crossFile?: true
}

/**
 * K2 — whether `nodeIds` may be copied into `newParentId` at `newIndex`
 * (Alt+drag, ⌘V), and if so where each copy is written.
 *
 * **Two questions per element, each answered by the function that already
 * owns it**, so Alt+drag cannot disagree with either of the gestures it is
 * made of:
 *
 *  1. *May this element be copied at all?* — `refuseStructuralEdit`'s
 *     `duplicate`, the identical question ⌘D asks.
 *  2. *May it land THERE?* — `previewStructuralMove`, the identical question a
 *     plain drag asks. This is what makes an Alt+drag refuse with the same
 *     sentence (`list-row`, `shared-component`, a container that is not an
 *     ordinary element) the same drag without Alt would have. A container in
 *     another file is not a refusal (ERR-16): the copy is written as a
 *     transplant (`crossFile`).
 *
 * The anchor, though, is an insert's, not a move's: `resolveContainerAnchor`,
 * the function `planSourceInsert` uses, because a duplicate-to is precisely an
 * insert of markup that already exists.
 *
 * SEVERAL ELEMENTS (ERR-7) land as one run, in the order given, all against
 * the SAME anchor — an element that is not moving, so every step of the
 * sequence the store posts names something that is there. "After X" is
 * written last-first (each copy lands right after X, pushing the ones already
 * written down); "before Y" and an append are written first-first. The commits
 * come back in that WRITE order. All or nothing: one refused element refuses
 * the gesture.
 */
export function planSourceDuplicateTo(
  tree: NodeTree<PageNode>,
  nodeIds: readonly string[],
  newParentId: string,
  newIndex: number,
  /**
   * ERR-8 — a copied element that is not in `tree`: a paste of something
   * copied in ANOTHER frame. It is asked the same per-element questions; its
   * landing is judged against the container alone, because it has no place in
   * this tree to move from.
   */
  elsewhere: (nodeId: string) => PageNode | undefined = () => undefined,
): StructuralPlan<SourceDuplicateToCommit[]> {
  const nodeOf = (id: string): PageNode | undefined => tree.nodes[id] ?? elsewhere(id)
  // A stale drop source — the mutation itself already no-ops on this;
  // inventing a refusal for it would explain the wrong thing.
  const ids = nodeIds.filter((id) => nodeOf(id) !== undefined)
  const first = ids[0]
  if (first === undefined) return { ok: true, commit: null }

  for (const nodeId of ids) {
    const node = nodeOf(nodeId)!
    const copyRefusal = refuseStructuralEdit({ kind: 'duplicate', node })
    if (copyRefusal) {
      return { ok: false, constraint: describeStructuralRefusal({ refusal: copyRefusal, node }), nodeId }
    }
    if (!tree.nodes[nodeId]) continue
    const landing = previewStructuralMove(tree, [nodeId], newParentId, newIndex)
    if (!landing.ok) {
      return { ok: false, constraint: describeStructuralRefusal({ refusal: landing.refusal, node }), nodeId }
    }
  }

  if (!isSourceDerivedNodeId(first)) return { ok: true, commit: null }

  const container = resolveSourceContainer(tree, newParentId)
  if (!container.ok) {
    return { ok: false, constraint: describeStructuralRefusal({ refusal: container.refusal }) }
  }
  for (const nodeId of ids) {
    if (tree.nodes[nodeId]) continue
    const node = nodeOf(nodeId)!
    const landing = refuseStructuralEdit({ kind: 'reparent', node, destination: container.node })
    if (landing && landing.reason !== 'cross-file') {
      return { ok: false, constraint: describeStructuralRefusal({ refusal: landing, node }), nodeId }
    }
  }
  // `newIndex` counts the DROP PARENT's children. When the container had to be
  // re-resolved (the page root became the page's root element), that index
  // names a position in a different list, so it is dropped rather than applied
  // to the wrong one — appending is an honest position. Identical reasoning to
  // `previewStructuralMove`'s reparent branch.
  const anchor = resolveContainerAnchor(tree, container.node, container.node.id === newParentId ? newIndex : undefined)
  const intoFile = decodeSourceNodeId(container.node.id)?.rel
  const writeOrder = anchor.anchorNodeId !== null && anchor.position === 'after' ? [...ids].reverse() : ids
  return {
    ok: true,
    commit: writeOrder.map((nodeId) => ({
      nodeId,
      parentNodeId: container.node.id,
      ...anchor,
      ...(decodeSourceNodeId(nodeId)?.rel !== intoFile ? { crossFile: true as const } : {}),
    })),
  }
}

/**
 * Whether ONE node may be wrapped in a new container, and if so which node the
 * SOURCE writes the wrapper around (W4-1).
 *
 * One node: `wrapJsxElement` replaces one element's own range with that
 * element inside a container. Several are a GROUP (ERR-7) — one container
 * around their run — and `writeWrapToSource` sends them to `planSourceGroup`
 * before this is asked.
 */
export function planSourceWrap(
  tree: NodeTree<PageNode>,
  nodeIds: readonly string[],
): StructuralPlan<string> {
  for (const id of nodeIds) {
    const node = tree.nodes[id]
    if (!node) continue
    const refusal = refuseStructuralEdit({ kind: 'wrap', node })
    if (refusal) {
      return { ok: false, constraint: describeStructuralRefusal({ refusal, node }), nodeId: node.id }
    }
  }
  const only = nodeIds.length === 1 ? nodeIds[0] : undefined
  return { ok: true, commit: only !== undefined && isSourceDerivedNodeId(only) ? only : null }
}

/**
 * Whether `nodeIds` may be GROUPED into one new container, and if so around
 * which run of source nodes (K3, ⌘G).
 *
 * A thin wrapper over `previewStructuralGroup` (`@core/page-tree`), for the
 * same reason `planSourceMove` is one over `previewStructuralMove`: the rule —
 * same parent, no gap, every member writable on its own — is pure and belongs
 * next to the other structural rules, and the only thing the store adds is the
 * `EditConstraint` dressing, which needs the NODE in hand to derive `origin`.
 *
 * `commit` is the run in SOURCE order. One id in it is an ordinary single
 * `wrap`; several are `wrapJsxElements`' one-container-around-a-span. `null`
 * means an ordinary CMS tree — mutate it and do not write.
 *
 * `nodeHtmlTag` is the second thing the store adds (`struct-11`): the rule
 * needs to know which HTML element each node is before it can say whether a
 * container may legally go around them, and that mapping lives in the module
 * registry rather than in `@core/page-tree`.
 */
export function planSourceGroup(
  tree: NodeTree<PageNode>,
  nodeIds: readonly string[],
): StructuralPlan<string[]> {
  const preview = previewStructuralGroup(tree, nodeIds, nodeHtmlTag)
  if (preview.ok) return { ok: true, commit: preview.commit }
  // The member the refusal is about when it is about one (a `.map` row inside
  // an otherwise fine run) — that node is where `origin` and the retry closure
  // come from. A refusal about the SELECTION (a gap, two parents) names none,
  // and falls back to the first node so the constraint still carries a file.
  const refusedId = preview.nodeId
  const node = refusedId === undefined
    ? nodeIds.map((id) => tree.nodes[id]).find((candidate) => candidate !== undefined)
    : tree.nodes[refusedId]
  return {
    ok: false,
    constraint: describeStructuralRefusal({ refusal: preview.refusal, ...(node ? { node } : {}) }),
    ...(node ? { nodeId: node.id } : {}),
  }
}

/**
 * Whether the container `nodeId` may be DISSOLVED (K3, ⌘⇧G).
 *
 * One node, so this asks `refuseStructuralEdit` directly rather than through a
 * tree preview — `unwrapJsxElement` replaces the container's own range with its
 * children, in the same file and the same scope, so an ordinary element at a
 * known location is the whole requirement here. The question only the AST can
 * answer — is this container ONLY a container, or does it carry a handler, a
 * ref, a `key`, a spread — arrives at save time as `has-behaviour`.
 */
export function planSourceUngroup(
  tree: NodeTree<PageNode>,
  nodeId: string,
): StructuralPlan<string> {
  const node = tree.nodes[nodeId]
  if (!node) return { ok: true, commit: null }
  const refusal = refuseStructuralEdit({ kind: 'ungroup', node })
  if (refusal) {
    return { ok: false, constraint: describeStructuralRefusal({ refusal, node }), nodeId: node.id }
  }
  return { ok: true, commit: isSourceDerivedNodeId(node.id) ? node.id : null }
}

/**
 * D2 G3 — whether ONE element may leave the page it is written in and land in
 * a container on ANOTHER page (a cross-frame drop), and if so where.
 *
 * A thin wrapper over `previewStructuralTransplant` (`@core/page-tree`), for
 * exactly the reason `planSourceMove` is one over `previewStructuralMove`: the
 * rule is pure and belongs next to the other structural rules, and the only
 * thing the store adds is the `EditConstraint` dressing, which needs the NODE
 * in hand to derive `origin` (the `rel:line:col` a "show me" button jumps to).
 *
 * `commit` is never `null` on success. Unlike every other plan here there is
 * no "ordinary CMS tree" branch to fall through to: a cross-PAGE move has no
 * in-memory equivalent at all — the two trees are two files — so either the
 * source can take the write or the gesture refuses.
 */
export function planSourceTransplant(
  originTree: NodeTree<PageNode>,
  nodeIds: readonly string[],
  destinationTree: NodeTree<PageNode>,
  newParentId: string,
  newIndex: number,
  copy: boolean,
): StructuralPlan<StructuralTransplantCommit> {
  const preview = previewStructuralTransplant({
    originTree,
    nodeIds,
    destinationTree,
    newParentId,
    newIndex,
    copy,
  })
  if (preview.ok) return { ok: true, commit: preview.commit }
  // The node the refusal is about — either end of the gesture, since a
  // transplant can be refused for what the CONTAINER is as well as for what
  // the moved element is. `previewStructuralTransplant` names which.
  const node = preview.nodeId === undefined
    ? undefined
    : (originTree.nodes[preview.nodeId] ?? destinationTree.nodes[preview.nodeId])
  const constraint = describeStructuralRefusal({ refusal: preview.refusal, ...(node ? { node } : {}) })
  return {
    ok: false,
    constraint: offersCopyInstead(originTree, nodeIds, destinationTree, newParentId, newIndex, copy)
      ? { ...constraint, actions: [...constraint.actions, DUPLICATE_INTO_FRAME_ACTION] }
      : constraint,
    ...(node ? { nodeId: node.id } : {}),
  }
}

/**
 * D2 G3's one remedy: the refused MOVE, re-issued as a copy.
 *
 * The label says what the button does rather than naming the mechanism,
 * because a user who has just been told "moving this would change every place
 * it is used" is being offered the thing that does not.
 */
const DUPLICATE_INTO_FRAME_ACTION: EditConstraintAction = {
  label: 'Duplicate into frame instead',
  kind: 'duplicate-into-frame',
}

/**
 * Whether the SAME gesture with Alt held would be allowed — the only honest
 * basis for offering "Duplicate into frame instead".
 *
 * It re-asks `previewStructuralTransplant`, the identical function that just
 * refused, rather than testing the refusal's reason against a list here: the
 * rule about which refusals a copy escapes belongs in the engine
 * (`copyEscapesOriginRefusal`), and a second copy of it in the store is exactly
 * the hand-kept-in-sync duplication `planSourceMove`'s own doc was written to
 * stop repeating. A gesture that was ALREADY a copy has nothing to offer — it
 * refused with Alt already held.
 */
function offersCopyInstead(
  originTree: NodeTree<PageNode>,
  nodeIds: readonly string[],
  destinationTree: NodeTree<PageNode>,
  newParentId: string,
  newIndex: number,
  copy: boolean,
): boolean {
  if (copy) return false
  return previewStructuralTransplant({
    originTree,
    nodeIds,
    destinationTree,
    newParentId,
    newIndex,
    copy: true,
  }).ok
}

/** Titles the refusal toasts use, one per gesture. Matches the `Detach refused` / `Swap refused` vocabulary. */
export const STRUCTURAL_REFUSAL_TITLE = {
  move: 'Move refused',
  /**
   * D2 G3 — a drag that crossed a frame boundary. Its own title because the
   * refusals are about crossing (a binding that cannot travel, a container in
   * a file that cannot take it), and "Move refused" on a gesture the user
   * experienced as moving between SCREENS reads as if the drag itself failed.
   */
  transplant: 'Cannot move this between frames',
  delete: 'Delete refused',
  insert: 'Cannot add this to imported code',
  duplicate: 'Duplicate refused',
  wrap: 'Wrap refused',
  group: 'Group refused',
  ungroup: 'Ungroup refused',
  /**
   * K6 — a ⌘-drag that asked to place an element by coordinates. The only
   * entry here that is not a source-writability refusal: the file would take
   * the write, the CSS would not do what the user pointed at. Same channel
   * regardless, so one refusal vocabulary reaches the user.
   */
  freeMove: 'Cannot place this by hand',
  /** P5-C — the Detach verb (`instanceActions.ts`): a refusal names why this instance's markup can't be written in place. */
  detach: 'Detach refused',
} as const

/**
 * Surface a refused structural gesture. Every path into the store shares this,
 * so the wording cannot drift per surface.
 *
 * `store-10` (R2) split what used to be one toast into two presentations,
 * chosen by whether `constraint.actions` is EMPTY — the same array R1's
 * remedies table already fills in exhaustively per `StructuralRefusalReason`:
 *
 *  - `constraint.actions.length === 0` (the 6 R1 reasons with no remedy at
 *    all — `reparent`, plain `insert`, `duplicate`, `wrap`, `multi-select`,
 *    `no-sibling-anchor`) → the toast below, byte-for-byte what
 *    `toastStructuralRefusal` always rendered.
 *  - a non-empty `actions` array (`shared-component`, `list-row`,
 *    `route-chrome`, `code-placed`, `cross-file`) → `RefusalDialog` (Phase B)
 *    instead, by writing `structuralRefusalDialog` into `uiSlice`. A gesture
 *    refused with "Open the component definition" / "Detach this instance" /
 *    "Duplicate as a new file" deserves buttons a user can actually press,
 *    not a sentence competing with a toast's 6-second attention span
 *    (extended to `null` here, same as before, but a modal reads as
 *    intentional in a way a toast in the corner does not). Checked on the
 *    ARRAY, not on whether `resolveConstraintAction` can resolve a handler
 *    for THIS caller's context — every real call site always supplies
 *    `getState`, so in production the two conditions coincide; keying on the
 *    array keeps the split a pure function of the constraint instead of a
 *    property of which caller happened to omit `getState` in a test.
 *
 * The toast keeps the three properties it always had, all because a refusal
 * is not a notification — it is the answer to something the user just tried
 * to do:
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
 *
 * `speed-05` — the dialog branch's `context.set` is wrapped in `startTransition`.
 * Every real call site into this function runs synchronously inside a keydown
 * (Delete) or a mouse-gesture handler, none of them a React-owned event — React
 * 18+'s automatic batching still schedules the resulting re-render (and
 * `RefusalDialog`'s first portal mount) at DEFAULT priority there, which keeps
 * it in the SAME main-thread task as the keystroke: measured at 393 ms for a
 * cold mount (`STUDIO-SPEED-PLAN.md` speed-05). `startTransition` marks that
 * state write low-priority, so React can finish the keydown task immediately
 * and mount the dialog in its own, interruptible task instead. The toast branch
 * below is untouched — `pushToast` does not go through this store's `set` at
 * all, so it was never inside this cost.
 */
export function presentStructuralRefusal(
  title: (typeof STRUCTURAL_REFUSAL_TITLE)[keyof typeof STRUCTURAL_REFUSAL_TITLE],
  constraint: EditConstraint,
  context: {
    /** The node the refusal is about, when the plan had one — see `StructuralPlan.nodeId`. */
    nodeId?: string
    /**
     * Re-run the gesture this refusal blocked with every id it named passed
     * through `mapId` — OD-7's detach-and-replay (`instanceOnlyGesture.ts`).
     */
    retry?: (mapId: (nodeId: string) => string) => void
    /**
     * D2 G3 — the `duplicate-into-frame` remedy's handler, when the refusing
     * gesture had one to offer. Travels to the dialog on its state, because
     * the destination it closes over cannot be rebuilt from a node id — see
     * `StructuralRefusalDialogState.duplicateIntoFrame`.
     */
    duplicateIntoFrame?: () => void
    /**
     * The store's own `get`. Supplied by every real call site; what makes the
     * toast's/dialog's jump-to-source button possible from inside a store
     * action without importing the composed store (see `openSourceFile`'s
     * doc), and what OD-7's detach-and-replay reads the board through.
     * Omitted only in tests that assert the sentence rather than the jump.
     */
    getState?: () => EditorStore
    /** The store's own `set` — opens `structuralRefusalDialog` when the constraint has a runnable remedy. */
    set: EditorStoreSetter
  },
): void {
  const openSourceContext = context.getState
    ? {
        openSource: (origin: Parameters<typeof openSourceFile>[1]) => openSourceFile(context.getState!(), origin),
        detachInstances: (nodeIds: readonly string[]) => context.getState!().detachInstances(nodeIds),
      }
    : {}

  const openDialog = (): void => {
    // `speed-05` — deferred so the keydown/gesture task that refused this
    // edit ends immediately; see this function's own doc comment.
    startTransition(() => {
      context.set((state) => {
        state.structuralRefusalDialog = {
          title,
          constraint,
          ...(context.nodeId !== undefined ? { nodeId: context.nodeId } : {}),
          ...(context.duplicateIntoFrame ? { duplicateIntoFrame: context.duplicateIntoFrame } : {}),
        }
      })
    })
  }

  // OD-7 — a gesture inside a shared component applies to THIS instance:
  // detach it, replay the gesture, one undo. The dialog is the answer only
  // when that cannot happen. See `instanceOnlyGesture.ts`.
  if (constraint.reason === 'shared-component' && context.nodeId && context.retry && context.getState) {
    const tookOver = applyToThisInstanceOnly({
      get: context.getState,
      set: context.set,
      refusedNodeId: context.nodeId,
      retry: context.retry,
      // OD-7 — both the detach and the component copy refused: ONE warning,
      // never the dialog (its remedies are the two writes that just refused).
      onRefused: () =>
        pushToast({
          kind: 'warning',
          title,
          body: `This instance could not be detached or copied, so nothing was changed. ${constraint.explanation}`,
          location: 'site-editor',
          dedupeKey: `structural-refusal:${title}:instance-only`,
        }),
    })
    if (tookOver) return
  }

  if (constraint.actions.length > 0) {
    openDialog()
    return
  }

  const action = constraintPrimaryAction(constraint, { ...openSourceContext, nodeId: context.nodeId })
  pushToast({
    kind: 'warning',
    title,
    body: constraintToastBody(constraint, { ...openSourceContext, nodeId: context.nodeId }),
    location: 'site-editor',
    durationMs: null,
    // Same gesture + same reason + same sentence = the same refusal. The
    // sentence is in the key because one reason (`insert`) covers several
    // genuinely different explanations.
    dedupeKey: `structural-refusal:${title}:${constraint.reason}:${constraint.explanation}`,
    ...(action ? { action } : {}),
  })
}
