/**
 * The single rule for "can the editor change this node's PLACE in the source?"
 * — the structural counterpart to `sourceWritability.ts`'s per-prop rule, and
 * the reason a structural gesture on a studio-imported board either writes a
 * file or says why it cannot.
 *
 * Until `struct-01` there was no third option: `StudioEdit` had no `move`,
 * `delete`, `insert` or `reorder` kind, and `saveSite` diffed values only. A
 * user dragged a row in the layers tree, the tree updated, the save reported
 * success, the `.tsx` was untouched, and the move was gone on reload. In
 * Studio the repository IS the document, so an edit the repository never saw
 * did not happen — a silent no-op is exactly the failure the "one honest write
 * target" invariant exists to prevent.
 *
 * Two questions, asked in this order:
 *
 *   1. **Is this ours?** A CMS node (a nanoid id) is not source-backed and
 *      these rules must not narrow what the ordinary editor can do to it.
 *      `isSourceDerivedNodeId` decides.
 *   2. **Does the edit have exactly one honest target?** For a REORDER or a
 *      DELETE of a plain element written at a known `line:col`, it does: the
 *      JSX child moves or goes, and nothing else in the file changes. For
 *      everything else it provably does not, and the answer is a refusal
 *      carrying a sentence a person can act on.
 *
 * What refuses, and why it is not solvable by trying harder:
 *
 *   - **`list-row`** — a `.map` row (`…:70:21#2`). One piece of source JSX
 *     renders every row; there is no position an edit to row 2 could occupy
 *     that would not rewrite all of them.
 *   - **`shared-component`** — an inlined id (`callSite~component:l:c`). The
 *     markup lives in the component's own file, so moving it here moves it for
 *     every instance on the board.
 *   - **`route-chrome`** — a Next `layout`/`template` file, composed into
 *     every route beneath it. Same "one file, many frames" problem.
 *   - **`code-placed`** — the parser recorded a structural `lockReason`: a
 *     spread, a dynamic child, a branch the source chooses at runtime. The
 *     source does not place this element at a fixed position, so neither can
 *     we.
 *   - **`multi-select`** — several elements REORDERED (or WRAPPED) at once.
 *     Each write shifts the others' line numbers, and the anchor a reorder
 *     writes against is resolved per element; one gesture, N interdependent
 *     targets. (A multi DELETE or DUPLICATE is fine — the save route orders a
 *     batch bottom-to-top, so no write can move a pending one's line.)
 *   - **`cross-file`** / **`no-sibling-anchor`** — a reorder is written as
 *     "put this element before/after that one", so it needs a sibling that is
 *     itself a plain element in the same file to write against. A reparent
 *     needs its new parent in that same file, for a stronger reason: across
 *     files the markup would land where the values it reads do not exist.
 *
 * **What `insert` taught the other four verbs (`struct-02`, then W4-1).**
 * `reparent`, `duplicate` and `wrap` used to be blanket refusals, on the stated
 * grounds that each "needs a source position that does not exist yet". That was
 * true of a node MINTED ON THE CANVAS, and false of a position the SOURCE is
 * asked to grow: `insertJsxElement` writes the element (and the import that
 * names it) into the user's file, the board re-reads it, and what appears on the
 * canvas is an ordinary parsed node with a real `rel:line:col`. W4-1 generalised
 * that write-then-re-read shape to the other three —
 * `duplicateJsxElement`/`wrapJsxElement`/`moveJsxElement`'s destination-parent
 * form — so the question for all of them is the one this rule was always able to
 * answer: is this an ordinary, singly-placed element (`refusePlacement`), and is
 * the second location it names in the same file?
 *
 * An `insert` is the one asked about a CONTAINER rather than about a node that
 * exists; `planSourceInsert` resolves the container (the synthetic page root
 * becomes the page's returned root element) before asking here.
 *
 * The refusals only a PARSE can answer stay with the codemods and arrive at
 * save time: `not-siblings`, `expression-child`, `mixed-indentation`,
 * `no-jsx-parent`, `into-own-descendant`, and — the one W4-1 added —
 * `out-of-scope`, a reparent whose markup reads a binding that does not exist
 * where it would land. See `src/core/ast-codemods/moveJsxElement.ts`.
 *
 * The rule is pure and knows nothing about HTTP: the store's mutation guards
 * consult it BEFORE mutating, `applyTreeOperation` consults it so a plugin or
 * an agent rides the same gate, and the server's codemods re-derive the same
 * facts from the AST. See `src/core/ast-codemods/moveJsxElement.ts` for the
 * residual refusals only the AST can answer (`not-siblings`, `mixed-indentation`).
 */
import {
  decodeSourceNodeId,
  hasWritableSourceLocation,
  isInlinedNodeId,
  isRouteChromeNodeId,
  isSourceDerivedNodeId,
  isStudioPageRootId,
} from './sourceNodeId'
import type { PageNode } from './pageNode'
import type { NodeTree } from './treeSchema'

/** The structural gestures the editor offers. One refusal vocabulary for all of them. */
export type StructuralEditKind = 'reorder' | 'reparent' | 'delete' | 'insert' | 'duplicate' | 'wrap'

/** Why a structural edit has no single honest target in the user's source. */
export type StructuralRefusalReason =
  | 'list-row'
  | 'shared-component'
  | 'route-chrome'
  | 'code-placed'
  | 'reparent'
  | 'insert'
  | 'duplicate'
  | 'wrap'
  | 'multi-select'
  | 'cross-file'
  | 'no-sibling-anchor'

/** A refused structural edit: the machine-readable reason plus the sentence the user reads. */
export interface StructuralRefusal {
  reason: StructuralRefusalReason
  message: string
}

/** The only two fields these rules read — structural, so a `BaseNode` can be asked the question too. */
export interface SourceStructureNode {
  id: string
  lockReason?: string
}

/** Human label for the gesture, used in every refusal sentence. */
const GESTURE: Record<StructuralEditKind, string> = {
  reorder: 'Moved',
  reparent: 'Moved',
  delete: 'Deleted',
  // An insert is asked about the CONTAINER it lands in, not about a node that
  // exists yet, so its refusals read "Added into <what this container is>".
  insert: 'Added into',
  duplicate: 'Duplicated',
  wrap: 'Wrapped',
}

/**
 * Whether this node's PLACE can be written back to the user's source, and if
 * not, why. `null` means the edit may proceed — either because the node is not
 * source-derived at all (an ordinary CMS node), or because it is a plain
 * element the codemods can honestly move, copy, wrap or remove.
 *
 * `anchor` is required for `reorder` only: the sibling the moved element is
 * written against (`moveJsxElement` writes "put A immediately before/after B",
 * never an index, because the editor's child order and the JSX child order
 * disagree wherever an expression child renders more than one node).
 *
 * `destination` is required for `reparent` only: the container the element
 * lands INSIDE. It has to satisfy the same "ordinary, singly-placed element"
 * test the moved node does, and live in the same file.
 */
export function refuseStructuralEdit(input: {
  kind: StructuralEditKind
  node: SourceStructureNode
  anchor?: SourceStructureNode | null
  /** The new parent, for `reparent`. */
  destination?: SourceStructureNode | null
  /** True when this gesture moves or wraps more than one node at once. */
  multi?: boolean
}): StructuralRefusal | null {
  const { kind, node, anchor, destination, multi } = input
  if (!isSourceDerivedNodeId(node.id)) return null

  const gesture = GESTURE[kind]

  // A multi-DELETE or multi-DUPLICATE is safe: the save route orders a batch
  // bottom-to-top, so a write cannot move the line of one still pending above
  // it. A multi-REORDER is not — each element is written against an anchor
  // whose position the previous write may already have changed, and the
  // gesture's meaning ("all of these, in this order, there") has no single
  // source target. A multi-WRAP is not either, for a nearer reason: one
  // wrapper around several elements is one write spanning all of them, and
  // Studio writes a wrapper around one element's own range.
  if (multi && (kind === 'reorder' || kind === 'reparent')) {
    return {
      reason: 'multi-select',
      message: `${gesture} several elements at once — Studio writes a move one element at a time, because each write moves the others' line numbers. Drag them one by one.`,
    }
  }
  if (multi && kind === 'wrap') {
    return {
      reason: 'multi-select',
      message:
        'Studio wraps one element at a time: a single wrapper around several elements is one write spanning all of them, and in the code they may not even be neighbours. Wrap them one by one, or wrap a container they already share.',
    }
  }

  const placement = refusePlacement(node, gesture)
  if (placement) return placement

  switch (kind) {
    case 'insert':
      // An insert is asked about the CONTAINER, not about a node that exists —
      // the new element has no id yet, and it never gets a canvas-minted one:
      // `insertJsxElement` writes it to the file and the board re-reads it. So
      // the only question is whether this container is a place the codemod can
      // honestly write a child, which `refusePlacement` just answered.
      //
      // The synthetic page root is the one container with no source location of
      // its own; `planSourceInsert` resolves it to the page's returned root
      // element before asking, so it never reaches here.
      return null
    case 'delete':
      return null
    case 'duplicate':
      // `duplicateJsxElement` writes the element's own source text in again as
      // its next sibling, in the same file and the same scope — so an ordinary
      // element at a known location is the whole requirement. There is no
      // second place to check: no anchor (the copy's position is "right here"),
      // and no import to reconcile (every binding the markup reads was already
      // in scope one line up).
      return null
    case 'wrap':
      // `wrapJsxElement` replaces the element's own range with the same element
      // inside a container it writes. The wrapper is REAL DOM once it is in the
      // file — Studio's "no wrapper divs" rule is about the CANVAS inventing
      // elements the source does not contain, which is the opposite of this.
      return null
    case 'reparent': {
      if (!destination) {
        return {
          reason: 'reparent',
          message:
            'Studio writes a move into a new parent as "put this element inside that one", so it needs a container that is itself an ordinary element in the code.',
        }
      }
      const destinationPlacement = refusePlacement(destination, 'Moved into')
      if (destinationPlacement) {
        return {
          reason: destinationPlacement.reason,
          message: `The container this would move into is not an ordinary element: ${lowerFirst(destinationPlacement.message)}`,
        }
      }
      const fromFile = decodeSourceNodeId(node.id)?.rel
      const intoFile = decodeSourceNodeId(destination.id)?.rel
      if (fromFile !== intoFile) {
        return {
          reason: 'cross-file',
          message: `This element is written in ${fromFile} and the container is in a different file (${intoFile}). Studio moves an element to a new parent within one file; across files the markup would land where the values it reads do not exist.`,
        }
      }
      return null
    }
    case 'reorder':
      break
  }

  if (!anchor) {
    return {
      reason: 'no-sibling-anchor',
      message:
        'This element has no plain sibling to be written next to. Studio records a reorder as "put this before that one", so it needs a neighbour that is itself an ordinary element in the same file.',
    }
  }
  const anchorPlacement = refusePlacement(anchor, 'Moved')
  if (anchorPlacement) {
    return {
      reason: 'no-sibling-anchor',
      message: `The element this would be written next to is not an ordinary one: ${lowerFirst(anchorPlacement.message)}`,
    }
  }
  const nodeFile = decodeSourceNodeId(node.id)?.rel
  const anchorFile = decodeSourceNodeId(anchor.id)?.rel
  if (nodeFile !== anchorFile) {
    return {
      reason: 'cross-file',
      message: `These two elements come from different files (${nodeFile} and ${anchorFile}), so there is no single place to write the new order.`,
    }
  }
  return null
}

/**
 * The half of the rule that is about the node's own source position rather
 * than the gesture — shared by the moved element and by the sibling a reorder
 * is written against, because "is this an ordinary element at a known line"
 * is the same question for both.
 *
 * **Published contract (E2.1/D2/F2, `STUDIO-FIGMA-PARITY-PLAN.md` §8's
 * Track E).** Originally a private half of `refuseStructuralEdit`; exported
 * because three more verbs — extract-to-component (E2.1), and the two work
 * orders serialized after it (D2, F2) — ask exactly this question ("is this
 * node an ordinary, singly-placed element, or does the parser's own
 * structural verdict rule out ANY single honest writeback target here") for
 * gestures that are not reorder/delete/insert at all. Reusing this function
 * means all of them refuse `list-row` / `shared-component` / `route-chrome` /
 * `code-placed` with the IDENTICAL vocabulary the user already sees on a
 * failed move or delete, rather than each verb inventing its own parallel
 * set of reasons for the same four underlying facts.
 *
 * `gesture` is the only thing a new caller supplies beyond `node` — a past-
 * tense verb (`'Moved'`, `'Extracted'`, …) the four messages below splice in
 * (`` `${gesture} a row of a list…` ``). `node.lockReason` is the parser's
 * OWN structural verdict (`ParsedNode.lockReason`) — this function is pure
 * and has no access to the loaded page tree itself, so a caller that HAS one
 * (the store, a server handler that already parsed the workspace) must pass
 * it through; a caller that only has raw AST coordinates (no parsed tree)
 * gets `route-chrome` for free (`isRouteChromeNodeId` reads the id's
 * filename alone) but not `list-row`/`shared-component`/`code-placed`, which
 * need information only a parse carries. See `extractSubtreeToComponent.ts`'s
 * own module doc for how it threads this through when a caller can supply it,
 * and what it checks independently from the AST when a caller cannot.
 */
export function refusePlacement(node: SourceStructureNode, gesture: string): StructuralRefusal | null {
  if (!hasWritableSourceLocation(node.id)) {
    return {
      reason: 'list-row',
      message: `${gesture} a row of a list that the code generates. One piece of source JSX renders every row, so there is no way to change just this one — edit the array it maps over.`,
    }
  }
  if (isInlinedNodeId(node.id)) {
    return {
      reason: 'shared-component',
      message: `${gesture} markup that lives in a shared component's own file, so the change would apply to every place that component is used, not just here.`,
    }
  }
  if (isRouteChromeNodeId(node.id)) {
    return {
      reason: 'route-chrome',
      message: `${gesture} markup from a layout file, which every page below it renders — the change would apply to all of them, not just this frame.`,
    }
  }
  if (node.lockReason) {
    return {
      reason: 'code-placed',
      message: `The code decides where this element goes (${node.lockReason}), so its position is not something Studio can write.`,
    }
  }
  return null
}

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

/** Lower-cases the first character so a refusal can be quoted mid-sentence. */
function lowerFirst(text: string): string {
  return text.length > 0 ? text[0]!.toLowerCase() + text.slice(1) : text
}

/**
 * The refusal for adding an ALREADY-MINTED node to a studio-imported tree, or
 * `null` when the destination is an ordinary CMS tree.
 *
 * This is the other half of `insert`, and the distinction is the node's origin,
 * not the container. The editor's own picker path never mints a node: it asks
 * `insertJsxElement` to write the element into the file and re-reads the board,
 * so what lands is a real parsed node — and `refuseStructuralEdit`'s `insert`
 * case asks only whether the CONTAINER can hold a written child.
 * `applyTreeOperation`'s callers (a plugin, an agent) hand over a node object
 * that already exists, id and all, and that id can never be a source location.
 * Accepting it would put something on the board that no file describes, which
 * is the silent no-op `struct-01` exists to prevent — so it refuses, and points
 * at the path that does work.
 *
 * `studioPageRoot` answers the question for the one container that cannot
 * answer it from its own id: the synthetic `<pageId>:body` root of an imported
 * page, which is where an insert into an EMPTY one lands.
 */
export function refuseMintedNodeInsert(input: {
  parent: SourceStructureNode
  studioPageRoot: boolean
}): StructuralRefusal | null {
  if (!input.studioPageRoot && !isSourceDerivedNodeId(input.parent.id)) return null
  return {
    reason: 'insert',
    message:
      'This element was created in the editor, so it has no markup in your project for Studio to write. Add a component from the canvas picker instead — that one writes the element and its import into the file.',
  }
}

/**
 * The refusal for DUPLICATING, WRAPPING or REPARENTING a studio-imported node
 * through a caller that mutates a tree instead of writing source — or `null` on
 * an ordinary CMS tree, where a canvas mutation is the whole story.
 *
 * The sibling of `refuseMintedNodeInsert`, and W4-1 is why it exists. Those
 * three verbs now WRITE (`duplicateJsxElement`, `wrapJsxElement`,
 * `moveJsxElement`'s destination-parent form), so `refuseStructuralEdit` no
 * longer refuses them — but "the source can take this edit" is only half the
 * question. The other half is whether the CALLER is one that issues the write.
 *
 *   - The editor is: `nodeActions` asks the source to grow the element and the
 *     board re-reads it, so the copy/wrapper on screen is a parsed node with a
 *     real `rel:line:col`.
 *   - `applyTreeOperation`'s callers are not: `mutatePageTree` persists a tree
 *     into a `data_row`, never into a `.tsx`. Duplicating a source-derived node
 *     there mints a nanoid child that no file describes — the silent no-op
 *     `struct-01` exists to prevent, in a new place.
 *
 * A REORDER through that dispatcher is a different case and stays permitted:
 * it mints nothing, and the node ids it rearranges keep meaning exactly what
 * they meant.
 */
export function refuseMintedNodeCopy(input: {
  kind: 'duplicate' | 'wrap' | 'reparent'
  node: SourceStructureNode
}): StructuralRefusal | null {
  if (!isSourceDerivedNodeId(input.node.id)) return null
  const verb = input.kind === 'duplicate' ? 'duplicate' : input.kind === 'wrap' ? 'wrap' : 'move'
  return {
    reason: input.kind,
    message: `Studio ${verb}s imported markup by editing your project's source and re-reading it. This path changes the canvas tree only, so the ${input.kind === 'reparent' ? 'move' : input.kind} would never reach the file — do it from the editor, which writes it.`,
  }
}

/**
 * Thrown by `applyTreeOperation` when a structural operation would silently
 * fail to reach a studio-imported node's source. The editor asks
 * `refuseStructuralEdit` before mutating and never sees this; a plugin or an
 * agent driving the dispatcher directly does, so it gets the same reason
 * rather than a mutation nothing will ever persist.
 */
export class SourceStructureError extends Error {
  readonly reason: StructuralRefusalReason

  constructor(refusal: StructuralRefusal, nodeId: string) {
    super(`[page-tree] ${nodeId}: ${refusal.message}`)
    this.name = 'SourceStructureError'
    this.reason = refusal.reason
  }
}
