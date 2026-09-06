/**
 * moveJsxElement — `struct-01`, the write behind a reorder on the board, and
 * (W4-1) behind a REPARENT: moving the JSX child at one `line:col` next to a
 * sibling, or into a different parent element in the same file.
 *
 * WHY AN ANCHOR RATHER THAN AN INDEX
 * ----------------------------------
 * The editor's child order and the JSX child order are not the same list. One
 * `{items.map(…)}` child contributes N nodes to the tree; a `{cond && <X/>}`
 * contributes one node the parser chose out of two; whitespace `JsxText`
 * children contribute none. An index computed on the canvas therefore does not
 * name a position in the source. "Put this element immediately after that one"
 * does — it is well defined under every one of those shapes, and it is exactly
 * what the user expressed by dragging one row past another.
 *
 * TWO FORMS, ONE FUNCTION
 * -----------------------
 *  - **Reorder** (no `destination`) — target and anchor must be siblings, and
 *    the move is a pure splice: bytes cut from one place, re-inserted at
 *    another, nothing reformatted.
 *  - **Reparent** (`destinationLine`/`destinationCol`) — the destination names
 *    the NEW PARENT. Placement inside it is `jsxChildPlacement.ts`'s job, the
 *    same function an insert uses, so the moved subtree lands with exactly the
 *    whitespace a newly inserted element would have had; the subtree is
 *    re-hung at the destination's indentation (`reindentBlock` — leading
 *    whitespace only).
 *
 * WHY REPARENT IS SAME-FILE ONLY (v1)
 * -----------------------------------
 * Not a technical limit of the splice — a limit of what a cross-file move would
 * MEAN. The markup would land in a different module, where the bindings it
 * reads do not exist and the component it left may still need it. The refusal
 * for that is decided one layer up, from the two node ids alone
 * (`refuseStructuralEdit`'s `cross-file`), and never reaches this codemod.
 *
 * THE SCOPE CHECK IS THE HONESTY CHECK. Within one file a move can still break
 * the code: markup lifted out of a `.map` callback loses the row it read, and
 * markup dragged from one component into another loses that component's props.
 * `freeVariablesOutOfScopeAt` answers that statically — which declarations
 * enclose the destination, never what any of them hold — and the refusal names
 * the variables, because "some binding" is not something a person can act on.
 *
 * FAILS CLOSED, and says why. `struct-01`'s whole point is that a structural
 * edit either changes the file or reports a reason; there is no third outcome.
 * The refusals here are the ones only the AST can answer. The ones decidable
 * from a node id alone (a `.map` row, a shared component, route chrome, a
 * cross-file anchor) are answered earlier and cheaper by `refuseStructuralEdit`
 * in `@core/page-tree`.
 *
 * BYTE-EXACTNESS. The AST locates; the write is a splice of the original
 * bytes (see `jsxChildRange.ts`). Comments, blank lines, attribute wrapping
 * and every untouched sibling survive verbatim — asserted in
 * `__tests__/structuralJsxCodemods.test.ts` against whole-file fixtures.
 */
import { Project, type SourceFile } from 'ts-morph'
import { createProject, findJsxElementAtLocation, loadSourceFile } from './locateJsxElement'
import {
  applyTextEdits,
  resolveJsxChildRange,
  spliceRange,
  verbatimSourceText,
  writeVerbatimSource,
  type JsxChildRange,
  type JsxChildRangeReason,
  type TextEdit,
} from './jsxChildRange'
import { lineIndentAt, reindentBlock, resolveChildPlacement } from './jsxChildPlacement'
import { freeVariablesOutOfScopeAt } from './subtreeFreeVariables'

export interface MoveJsxElementParams {
  file: string
  /** 1-based line/col of the element being moved (its tag-name start). */
  line: number
  col: number
  /**
   * 1-based line/col of the NEW PARENT element, for a cross-parent move.
   * Omit for a same-parent reorder.
   */
  destinationLine?: number
  destinationCol?: number
  /**
   * 1-based line/col of the element it is written against — a sibling for a
   * reorder (required), an existing child of the destination for a reparent
   * (optional: without one the element is appended as the last child).
   */
  anchorLine?: number
  anchorCol?: number
  /** Which side of the anchor the element lands on. */
  position?: 'before' | 'after'
  /** Optional pre-existing project to reuse. */
  project?: Project
}

export type MoveJsxRefusalReason =
  | JsxChildRangeReason
  | 'same-element'
  | 'not-siblings'
  | 'mixed-indentation'
  | 'no-anchor'
  | 'not-a-container'
  | 'into-own-descendant'
  | 'out-of-scope'
  | 'binding-conflict'
  | 'unsafe-tag'
  | 'void-element-children'

export interface MoveJsxRefusal {
  reason: MoveJsxRefusalReason
  /** Human-readable, suitable for a toast. */
  message: string
}

export type MoveJsxElementResult = { ok: true } | { ok: false; refusal: MoveJsxRefusal }

function refuseMove(reason: MoveJsxRefusalReason, message: string): MoveJsxElementResult {
  return { ok: false, refusal: { reason, message } }
}

export function moveJsxElement(params: MoveJsxElementParams): MoveJsxElementResult {
  const { file, line, col } = params
  const project = params.project ?? createProject()
  const sourceFile = loadSourceFile(project, file)

  const target = resolveJsxChildRange(sourceFile, line, col)
  if (!target.ok) return refuseMove(target.reason, target.message)

  const verbatim = verbatimSourceText(sourceFile, file)
  if (verbatim === null) {
    return refuseMove(
      'stale-source',
      'This file changed on disk since the canvas last read it. Reload the project and try again.',
    )
  }

  return params.destinationLine !== undefined && params.destinationCol !== undefined
    ? reparent(sourceFile, file, verbatim, target.range, params, params.destinationLine, params.destinationCol)
    : reorder(sourceFile, file, verbatim, target.range, params)
}

/** The original sibling reorder: two children of one parent, one byte splice. */
function reorder(
  sourceFile: SourceFile,
  file: string,
  verbatim: string,
  target: JsxChildRange,
  params: MoveJsxElementParams,
): MoveJsxElementResult {
  const { anchorLine, anchorCol, position } = params
  if (anchorLine === undefined || anchorCol === undefined) {
    return refuseMove(
      'no-anchor',
      'A reorder is written as "put this element next to that one", so it needs a sibling to be written against.',
    )
  }

  const anchor = resolveJsxChildRange(sourceFile, anchorLine, anchorCol)
  if (!anchor.ok) return refuseMove(anchor.reason, anchor.message)

  if (target.element === anchor.range.element) {
    return refuseMove('same-element', 'An element cannot be moved next to itself.')
  }
  if (target.parent !== anchor.range.parent) {
    return refuseMove(
      'not-siblings',
      'These two elements are not siblings in the code — the canvas shows them side by side, but the source nests them differently, so there is no single place to write the new order.',
    )
  }
  if (target.wholeLine !== anchor.range.wholeLine) {
    return refuseMove(
      'mixed-indentation',
      'One of these elements is on a line of its own and the other shares a line, so Studio cannot move one past the other without reformatting code you did not touch. Reorder them in the file instead.',
    )
  }

  const at = position === 'before' ? anchor.range.start : anchor.range.end
  writeVerbatimSource(sourceFile, file, spliceRange(verbatim, target.start, target.end, at))
  return { ok: true }
}

/**
 * W4-1's cross-parent move: cut the subtree, and write it into the destination
 * exactly where an insert would have put a new element.
 *
 * Both edits are measured against the ORIGINAL text and applied last-first
 * (`applyTextEdits`), so neither shifts the other's arithmetic. They cannot
 * overlap: the destination is refused when it lies inside the moved subtree,
 * and the placement is told to ignore the subtree's own range when it looks for
 * an anchor or a last child.
 */
function reparent(
  sourceFile: SourceFile,
  file: string,
  verbatim: string,
  target: JsxChildRange,
  params: MoveJsxElementParams,
  destinationLine: number,
  destinationCol: number,
): MoveJsxElementResult {
  const destination = findJsxElementAtLocation(sourceFile, destinationLine, destinationCol)
  if (!destination) {
    return refuseMove(
      'not-found',
      `No JSX element is written at line ${destinationLine}, column ${destinationCol} any more — the file changed since the canvas last read it. Reload and try again.`,
    )
  }

  if (destination.getStart() >= target.start && destination.getEnd() <= target.end) {
    return refuseMove(
      'into-own-descendant',
      'That container is inside the element being moved, so moving one into the other would leave neither with a place in the file.',
    )
  }

  const outOfScope = freeVariablesOutOfScopeAt(target.element, destination, sourceFile)
  if (outOfScope.length > 0) {
    const names = outOfScope.map((name) => `\`${name}\``).join(', ')
    return refuseMove(
      'out-of-scope',
      `This element reads ${names} from the code around it, and ${outOfScope.length === 1 ? 'that name is' : 'those names are'} not in scope where it would land — moving it there would break the file. Move it somewhere inside the same component, or pass ${outOfScope.length === 1 ? 'the value' : 'those values'} through first.`,
    )
  }

  const subtree = verbatim.slice(target.element.getStart(), target.element.getEnd())
  const fromIndent = lineIndentAt(verbatim, target.element.getStart())

  const placement = resolveChildPlacement(
    sourceFile,
    verbatim,
    destination,
    {
      anchor:
        params.anchorLine !== undefined && params.anchorCol !== undefined
          ? { line: params.anchorLine, col: params.anchorCol }
          : null,
      ...(params.position ? { position: params.position } : {}),
      exclude: { start: target.start, end: target.end },
    },
    (indent) => reindentBlock(subtree, fromIndent, indent),
  )
  if (!placement.ok) return refuseMove(placement.refusal.reason, placement.refusal.message)

  const removal: TextEdit = { start: target.start, end: target.end, text: '' }
  writeVerbatimSource(sourceFile, file, applyTextEdits(verbatim, [placement.edit, removal]))
  return { ok: true }
}
