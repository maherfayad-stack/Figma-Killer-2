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
 *   - **`reparent`**, **`insert`**, **`duplicate`**, **`wrap`** — each needs a
 *     source position that does not exist yet (a new JSX child, a new wrapper
 *     element, a copy with no line and column of its own). Deliberately NOT
 *     built this pass rather than approximated: a new node minted with a
 *     nanoid id can never be written back, so accepting the gesture would
 *     recreate the silent no-op in a new place.
 *   - **`multi-select`** — several elements REORDERED at once. Each move shifts
 *     the others' line numbers, and the anchor a reorder writes against is
 *     resolved per element; one gesture, N interdependent targets. (A multi
 *     DELETE is fine — the save route orders a batch bottom-to-top, so no
 *     removal can move another's line.)
 *   - **`cross-file`** / **`no-sibling-anchor`** — a reorder is written as
 *     "put this element before/after that one", so it needs a sibling that is
 *     itself a plain element in the same file to write against.
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
} from './sourceNodeId'

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
  insert: 'Added',
  duplicate: 'Duplicated',
  wrap: 'Wrapped',
}

/**
 * Whether this node's PLACE can be written back to the user's source, and if
 * not, why. `null` means the edit may proceed — either because the node is not
 * source-derived at all (an ordinary CMS node), or because it is a plain
 * element the codemods can honestly move or remove.
 *
 * `anchor` is required for `reorder` only: the sibling the moved element is
 * written against (`moveJsxElement` writes "put A immediately before/after B",
 * never an index, because the editor's child order and the JSX child order
 * disagree wherever an expression child renders more than one node).
 */
export function refuseStructuralEdit(input: {
  kind: StructuralEditKind
  node: SourceStructureNode
  anchor?: SourceStructureNode | null
  /** True when this gesture reorders more than one node at once. */
  multi?: boolean
  /**
   * Answers question 1 for the one node that cannot answer it from its own id:
   * the synthetic page root (`isStudioPageRootId`), which is where an insert
   * into an EMPTY imported page lands. Never a way to opt an ordinary CMS node
   * into these rules — the id test still runs for everything else.
   */
  sourceBacked?: boolean
}): StructuralRefusal | null {
  const { kind, node, anchor, multi } = input
  if (!input.sourceBacked && !isSourceDerivedNodeId(node.id)) return null

  const gesture = GESTURE[kind]

  switch (kind) {
    case 'reparent':
      return {
        reason: 'reparent',
        message:
          'Studio can reorder an element among its own siblings in the code, but not move it into a different parent yet — that needs a source position the element does not have. Move it in the file instead.',
      }
    case 'insert':
      return {
        reason: 'insert',
        message:
          'Studio cannot add a new element to imported code yet. A node created on the canvas has no line and column of its own, so there is nowhere to write it — add it in the file instead.',
      }
    case 'duplicate':
      return {
        reason: 'duplicate',
        message:
          'Studio cannot duplicate an element in imported code yet. The copy would have no source location of its own, so it could never be written back — copy the JSX in the file instead.',
      }
    case 'wrap':
      return {
        reason: 'wrap',
        message:
          'Studio cannot wrap imported code in a new element yet. The wrapper would have no source location of its own, so it could never be written back — add it in the file instead.',
      }
    case 'reorder':
    case 'delete':
      break
  }

  // A multi-DELETE is safe: the save route orders a batch bottom-to-top, so
  // removing a lower element cannot move a higher one's line. A multi-REORDER
  // is not — each element is written against an anchor whose position the
  // previous write may already have changed, and the gesture's meaning
  // ("all of these, in this order, there") has no single source target.
  if (multi && kind === 'reorder') {
    return {
      reason: 'multi-select',
      message: `${gesture} several elements at once — Studio writes a reorder one element at a time, because each write moves the others' line numbers. Drag them one by one.`,
    }
  }

  const placement = refusePlacement(node, gesture)
  if (placement) return placement

  if (kind === 'delete') return null

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
 */
function refusePlacement(node: SourceStructureNode, gesture: string): StructuralRefusal | null {
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

/** Lower-cases the first character so a refusal can be quoted mid-sentence. */
function lowerFirst(text: string): string {
  return text.length > 0 ? text[0]!.toLowerCase() + text.slice(1) : text
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
