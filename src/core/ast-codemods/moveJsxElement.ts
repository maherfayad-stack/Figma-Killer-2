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
import { indentUnit, insertBeside, lineIndentAt, reindentBlock, resolveChildPlacement } from './jsxChildPlacement'
import { createdJsxLocation, offsetAfterEdits, type CreatedJsxLocation } from './createdJsxLocation'
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

export interface MoveJsxRefusal {
  reason: MoveJsxRefusalReason
  /** Human-readable, suitable for a toast. */
  message: string
}

/**
 * `relocated` (`store-14`) is the MOVED element's own tag-name `line:col`
 * after the write — the id the parser will mint for it on the next read.
 *
 * A move creates nothing, so it has no `created` to report; but it is exactly
 * the kind whose node id CHANGES, which is why the board loses the selection
 * across a reorder or a reparent unless the codemod says where the element
 * went. `null` when the re-parsed file does not confirm the position — the
 * same refusal-to-guess `createdJsxLocation` documents.
 */
export type MoveJsxElementResult =
  | { ok: true; relocated: CreatedJsxLocation | null }
  | { ok: false; refusal: MoveJsxRefusal }

function refuseMove(reason: MoveJsxRefusalReason, message: string): MoveJsxElementResult {
  return { ok: false, refusal: { reason, message } }
}

export function moveJsxElement(params: MoveJsxElementParams): MoveJsxElementResult {
  const { file, line, col } = params
  const project = params.project ?? createProject()
  const sourceFile = loadSourceFile(project, file)

  // WB-20 — `{cond && <X/>}` moves as the whole container: the condition
  // travels with the element it decides.
  const target = resolveJsxChildRange(sourceFile, line, col, 'conditional')
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

  // WB-22 — an anchor the code produces is its `{…}` container.
  const anchor = resolveJsxChildRange(sourceFile, anchorLine, anchorCol, 'container')
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
    return reorderAcrossLineShapes(sourceFile, file, verbatim, target, anchor.range, position ?? 'after')
  }

  const at = position === 'before' ? anchor.range.start : anchor.range.end
  const moved = verbatim.slice(target.start, target.end)
  writeVerbatimSource(sourceFile, file, spliceRange(verbatim, target.start, target.end, at))
  // `spliceRange`'s own arithmetic, read back: the block lands at `at`, minus
  // its own length when it was cut from above that point.
  const landedAt = at >= target.end ? at - (target.end - target.start) : at
  return { ok: true, relocated: createdJsxLocation(sourceFile, landedAt, moved) }
}

/**
 * WB-21 — a reorder between an element on a line of its own and one that
 * shares a line. The moved element takes the ANCHOR's shape, the way an insert
 * beside that anchor would (`insertBeside`): it gets its own line at the
 * anchor's indentation when the anchor has one, and joins the anchor's line
 * (one space apart) when the anchor shares a line.
 *
 * The only bytes this touches that a plain splice would not are the ones the
 * moved element leaves behind: an inline element takes one of its separating
 * runs of spaces with it (`inlineRemoval`), so `<a/> <b/>` minus `<b/>` is
 * `<a/>`, not `<a/> `. Every other sibling on either line keeps its bytes.
 */
function reorderAcrossLineShapes(
  sourceFile: SourceFile,
  file: string,
  verbatim: string,
  target: JsxChildRange,
  anchor: JsxChildRange,
  position: 'before' | 'after',
): MoveJsxElementResult {
  const subtree = verbatim.slice(target.element.getStart(), target.element.getEnd())
  const fromIndent = lineIndentAt(verbatim, target.element.getStart())
  const removal: TextEdit = target.wholeLine
    ? { start: target.start, end: target.end, text: '' }
    : { ...inlineRemoval(verbatim, target.start, target.end), text: '' }
  const insertion = insertBeside(
    anchor,
    position,
    (indent) => reindentBlock(subtree, fromIndent, indent),
    indentUnit(verbatim),
    verbatim,
  )
  writeVerbatimSource(sourceFile, file, applyTextEdits(verbatim, [insertion, removal]))
  return {
    ok: true,
    relocated: createdJsxLocation(sourceFile, offsetAfterEdits([removal], insertion.start), insertion.text),
  }
}

/**
 * The bytes an inline element owns once it LEAVES its line: itself, plus the
 * run of spaces that separated it from the sibling before it — or, when it was
 * first on the line, from the sibling after it. A run that holds a newline is
 * never taken; that is the line structure, not a separator.
 */
export function inlineRemoval(text: string, start: number, end: number): { start: number; end: number } {
  let before = start
  while (before > 0 && (text[before - 1] === ' ' || text[before - 1] === '\t')) before -= 1
  const lineStart = text.lastIndexOf('\n', start - 1) + 1
  if (before > lineStart && before < start) return { start: before, end }
  let after = end
  while (after < text.length && (text[after] === ' ' || text[after] === '\t')) after += 1
  if (after > end && after < text.length && text[after] !== '\n') return { start, end: after }
  return { start, end }
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
  return {
    ok: true,
    // The placement's offset is measured against the ORIGINAL text; only the
    // removal can have moved it. Same arithmetic `insertJsxElement` runs for
    // the import edit above its own splice.
    relocated: createdJsxLocation(sourceFile, offsetAfterEdits([removal], placement.edit.start), placement.edit.text),
  }
}
