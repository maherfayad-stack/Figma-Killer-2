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
  previewStructuralGroup,
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
): StructuralPlan<SourceMoveCommit> {
  const preview = previewStructuralMove(tree, nodeIds, newParentId, newIndex)
  if (preview.ok) return { ok: true, commit: preview.commit }
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

/** Where an Alt-dragged COPY is written: inside which container, beside which existing child. */
export interface SourceDuplicateToCommit {
  /** The element being copied. */
  nodeId: string
  /** The container the copy lands in — a real source node, never the synthetic page root. */
  parentNodeId: string
  /** The existing child the copy is written next to, or `null` to append as the last child. */
  anchorNodeId: string | null
  position: 'before' | 'after'
}

/**
 * K2 — whether ONE element may be copied into `newParentId` at `newIndex`
 * (Alt+drag), and if so where the copy is written.
 *
 * **Two questions, each answered by the function that already owns it**, so
 * Alt+drag cannot disagree with either of the gestures it is made of:
 *
 *  1. *May this element be copied at all?* — `refuseStructuralEdit`'s
 *     `duplicate`, the identical question ⌘D asks.
 *  2. *May it land THERE?* — `previewStructuralMove`, the identical question a
 *     plain drag asks. This is what makes an Alt+drag refuse with the same
 *     sentence (`list-row`, `shared-component`, `cross-file`, a container that
 *     is not an ordinary element) the same drag without Alt would have.
 *
 * The COMMIT, though, is an insert's, not a move's. `previewStructuralMove`
 * resolves its anchor from the child list with the dragged node REMOVED,
 * because that is what a move does to it; a copy removes nothing, so the same
 * `newIndex` names a different neighbour. `resolveContainerAnchor` — the
 * function `planSourceInsert` uses, for exactly the question "where in this
 * container does a NEW element go" — is the honest resolver here, and a
 * duplicate-to is precisely an insert of markup that already exists.
 *
 * ONE NODE ONLY. The drag session resolves one drop target; N copies dropped
 * at one position would have to be ordered against each other inside a child
 * list each of them is shifting, which is the same reason a multi-node
 * reorder refuses. Refused as `multi-select`, with the remedy that is actually
 * true — drag them one at a time.
 */
export function planSourceDuplicateTo(
  tree: NodeTree<PageNode>,
  nodeIds: readonly string[],
  newParentId: string,
  newIndex: number,
): StructuralPlan<SourceDuplicateToCommit> {
  const nodeId = nodeIds[0]
  if (nodeId === undefined) return { ok: true, commit: null }
  const node = tree.nodes[nodeId]
  // A stale drop source — the mutation itself already no-ops on this;
  // inventing a refusal for it would explain the wrong thing.
  if (!node) return { ok: true, commit: null }

  if (nodeIds.length > 1) {
    return {
      ok: false,
      constraint: describeStructuralRefusal({
        refusal: {
          reason: 'multi-select',
          message:
            'Studio copies one element at a time: each copy changes the line numbers the next one would be written against, and several copies dropped at one position have no single order in the code. Alt-drag them one by one.',
        },
        node,
      }),
      nodeId,
    }
  }

  const copyRefusal = refuseStructuralEdit({ kind: 'duplicate', node })
  if (copyRefusal) {
    return { ok: false, constraint: describeStructuralRefusal({ refusal: copyRefusal, node }), nodeId }
  }

  const landing = previewStructuralMove(tree, [nodeId], newParentId, newIndex)
  if (!landing.ok) {
    return { ok: false, constraint: describeStructuralRefusal({ refusal: landing.refusal, node }), nodeId }
  }

  if (!isSourceDerivedNodeId(nodeId)) return { ok: true, commit: null }

  const container = resolveSourceContainer(tree, newParentId)
  if (!container.ok) {
    return { ok: false, constraint: describeStructuralRefusal({ refusal: container.refusal }) }
  }

  return {
    ok: true,
    commit: {
      nodeId,
      parentNodeId: container.node.id,
      // `newIndex` counts the DROP PARENT's children. When the container had
      // to be re-resolved (the page root became the page's root element), that
      // index names a position in a different list, so it is dropped rather
      // than applied to the wrong one — appending is an honest position.
      // Identical reasoning to `previewStructuralMove`'s reparent branch.
      ...resolveContainerAnchor(tree, container.node, container.node.id === newParentId ? newIndex : undefined),
    },
  }
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
 */
export function planSourceGroup(
  tree: NodeTree<PageNode>,
  nodeIds: readonly string[],
): StructuralPlan<string[]> {
  const preview = previewStructuralGroup(tree, nodeIds)
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

/** Titles the refusal toasts use, one per gesture. Matches the `Detach refused` / `Swap refused` vocabulary. */
export const STRUCTURAL_REFUSAL_TITLE = {
  move: 'Move refused',
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
 */
export function presentStructuralRefusal(
  title: (typeof STRUCTURAL_REFUSAL_TITLE)[keyof typeof STRUCTURAL_REFUSAL_TITLE],
  constraint: EditConstraint,
  context: {
    /** The node the refusal is about, when the plan had one — see `StructuralPlan.nodeId`. */
    nodeId?: string
    /**
     * Re-run the gesture this refusal blocked, against the node that replaces
     * `nodeId` once a detach/extract's reload lands. Only ever consulted by
     * `RefusalDialog` (Phase B) after a `detach`/`extract` action settles —
     * every other path through this function ignores it.
     */
    retry?: (newNodeId: string) => void
    /**
     * The store's own `get`. Supplied by every real call site; what makes the
     * toast's/dialog's jump-to-source button possible from inside a store
     * action without importing the composed store (see `openSourceFile`'s
     * doc). Omitted only in tests that assert the sentence rather than the
     * jump.
     */
    getState?: () => SourceFileOpener
    /** The store's own `set` — opens `structuralRefusalDialog` when the constraint has a runnable remedy. */
    set: EditorStoreSetter
  },
): void {
  const openSourceContext = context.getState
    ? { openSource: (origin: Parameters<typeof openSourceFile>[1]) => openSourceFile(context.getState!(), origin) }
    : {}

  if (constraint.actions.length > 0) {
    context.set((state) => {
      state.structuralRefusalDialog = {
        title,
        constraint,
        ...(context.nodeId !== undefined ? { nodeId: context.nodeId } : {}),
        ...(context.retry ? { retry: context.retry } : {}),
      }
    })
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
