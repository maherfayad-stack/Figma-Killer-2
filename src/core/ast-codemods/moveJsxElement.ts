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
 * WHAT USED TO REFUSE AND NOW WRITES (G-7)
 * ----------------------------------------
 *  - **`same-element`** - "put this next to itself" is a move that changes
 *    nothing, so it writes nothing and succeeds (`unchanged`).
 *  - **`no-anchor`** - a reorder that names no sibling means an edge of the
 *    element's own parent: `position: 'before'` is first, anything else last.
 *    Already there, it is the same no-op.
 *  - **`not-siblings`** - the canvas shows two elements side by side that the
 *    source nests differently (a `<Fragment>` is not a node). The element is
 *    written beside the anchor, in the anchor's own parent: it renders exactly
 *    where the person dropped it. What stays refused is an anchor INSIDE the
 *    moved element (`into-own-descendant`) and a name the new place cannot see
 *    (`out-of-scope`), both of which would break the file.
 *
 * BYTE-EXACTNESS. The AST locates; the write is a splice of the original
 * bytes (see `jsxChildRange.ts`). Comments, blank lines, attribute wrapping
 * and every untouched sibling survive verbatim — asserted in
 * `__tests__/structuralJsxCodemods.test.ts` against whole-file fixtures.
 */
import { Node, Project, type SourceFile } from 'ts-morph'
import { createProject, findJsxElementAtLocation, loadSourceFile } from './locateJsxElement'
import {
  applyTextEdits,
  ownedTextRange,
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
import { ELEMENT_GONE_MESSAGE, outOfScopeMessage, STALE_SOURCE_MESSAGE } from '@core/utils/refusalCopy'

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
  // Only a cross-file transplant asks a placement to refuse an anchor outside
  // its container; this codemod writes beside the anchor instead (G-7).
  | 'not-siblings'

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
  | {
      ok: true
      relocated: CreatedJsxLocation | null
      /** G-7 - the file already said what was asked (same element, or already at that edge): nothing was written. */
      unchanged?: true
    }
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
      STALE_SOURCE_MESSAGE,
    )
  }

  return params.destinationLine !== undefined && params.destinationCol !== undefined
    ? reparent(sourceFile, file, verbatim, target.range, params, params.destinationLine, params.destinationCol)
    : reorder(sourceFile, file, verbatim, target.range, params)
}

/**
 * What a move is written against: a child of some JSX parent and the bytes it
 * owns - an element, or (WB-22) the `{…}` container the code produces it with.
 */
type PlacementAnchor = Pick<JsxChildRange, 'element' | 'parent' | 'start' | 'end' | 'wholeLine'>

/** True when `inner` lies entirely inside `outer`. */
function lies(inner: Node, outer: Node): boolean {
  return inner.getStart() >= outer.getStart() && inner.getEnd() <= outer.getEnd()
}

/** The move changed nothing because the file already says it: reported as success, and the file is not written. */
function unchangedMove(sourceFile: SourceFile, target: JsxChildRange): MoveJsxElementResult {
  const { line, column } = sourceFile.getLineAndColumnAtPos(target.opening.getTagNameNode().getStart())
  return { ok: true, relocated: { line, col: column }, unchanged: true }
}

/**
 * The children of a JSX parent a move can be written against, in source order:
 * elements and the `{…}` containers that produce them. Whitespace text and
 * the empty containers that only hold a comment are not children in this sense.
 */
function placementUnits(parent: Node): Node[] {
  if (!Node.isJsxElement(parent) && !Node.isJsxFragment(parent)) return []
  return parent
    .getJsxChildren()
    .filter(
      (child) =>
        Node.isJsxElement(child) ||
        Node.isJsxSelfClosingElement(child) ||
        (Node.isJsxExpression(child) && child.getExpression() !== undefined),
    )
}

/**
 * A reorder: put the target next to an anchor, or - with no anchor - at an edge
 * of its own parent. Same parent and same line shape is one byte splice; every
 * other shape is a cut and an insertion beside the anchor.
 */
function reorder(
  sourceFile: SourceFile,
  file: string,
  verbatim: string,
  target: JsxChildRange,
  params: MoveJsxElementParams,
): MoveJsxElementResult {
  const { anchorLine, anchorCol, position } = params
  if (anchorLine === undefined || anchorCol === undefined) {
    // No sibling named: an edge of the element's own parent. 'before' is first,
    // anything else last; an element already there, or alone, has nowhere to go.
    const units = placementUnits(target.parent)
    const others = units.filter((unit) => unit !== target.element)
    const atEdge = position === 'before' ? units[0] === target.element : units[units.length - 1] === target.element
    if (others.length === 0 || atEdge) return unchangedMove(sourceFile, target)
    const edge = position === 'before' ? others[0]! : others[others.length - 1]!
    const owned = ownedTextRange(verbatim, edge.getStart(), edge.getEnd())
    return placeBesideAnchor(sourceFile, file, verbatim, target, { element: edge, parent: target.parent, ...owned }, position ?? 'after')
  }

  // WB-22 — an anchor the code produces is its `{…}` container.
  const anchor = resolveJsxChildRange(sourceFile, anchorLine, anchorCol, 'container')
  if (!anchor.ok) return refuseMove(anchor.reason, anchor.message)

  if (target.element === anchor.range.element) return unchangedMove(sourceFile, target)
  if (lies(anchor.range.element, target.element)) {
    return refuseMove(
      'into-own-descendant',
      'The element this would go next to is part of the element being moved. Drop it next to a different element.',
    )
  }
  return placeBesideAnchor(sourceFile, file, verbatim, target, anchor.range, position ?? 'after')
}

/** The bytes of a move beside `anchor`, whatever the two share: a parent, a line shape, a scope. */
function placeBesideAnchor(
  sourceFile: SourceFile,
  file: string,
  verbatim: string,
  target: JsxChildRange,
  anchor: PlacementAnchor,
  position: 'before' | 'after',
): MoveJsxElementResult {
  if (target.parent !== anchor.parent) {
    // The canvas shows these side by side (a `<Fragment>` is not a node) but the
    // source nests them differently: the element is written where the anchor is,
    // which is where it renders - provided it can still see what it reads there.
    const outOfScope = freeVariablesOutOfScopeAt(target.element, anchor.element, sourceFile)
    if (outOfScope.length > 0) return refuseMove('out-of-scope', outOfScopeMessage(outOfScope))
    return relocateBesideAnchor(sourceFile, file, verbatim, target, anchor, position)
  }
  if (target.wholeLine !== anchor.wholeLine) {
    return relocateBesideAnchor(sourceFile, file, verbatim, target, anchor, position)
  }

  const at = position === 'before' ? anchor.start : anchor.end
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
 *
 * G-7 - the same cut-and-insert is how a move lands in a DIFFERENT parent: the
 * element is re-hung at the anchor's indentation, `reindentBlock`'s leading
 * whitespace only.
 */
function relocateBesideAnchor(
  sourceFile: SourceFile,
  file: string,
  verbatim: string,
  target: JsxChildRange,
  anchor: PlacementAnchor,
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
      ELEMENT_GONE_MESSAGE,
    )
  }

  if (destination.getStart() >= target.start && destination.getEnd() <= target.end) {
    return refuseMove(
      'into-own-descendant',
      'That container is inside the element being moved, so one would end up inside the other. Drop it into a different container.',
    )
  }

  // The anchor is inside the subtree being moved: it is about to stop existing,
  // so it cannot be what the new position is written against.
  if (params.anchorLine !== undefined && params.anchorCol !== undefined) {
    const anchor = resolveJsxChildRange(sourceFile, params.anchorLine, params.anchorCol, 'container')
    if (anchor.ok && lies(anchor.range.element, target.element)) {
      return refuseMove(
        'into-own-descendant',
        'The element this would go next to is part of the element being moved. Drop it next to a different element.',
      )
    }
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
      // G-7 - an anchor the source nests elsewhere (inside a `<Fragment>` the
      // canvas flattens) is written beside, where it renders.
      besideAnchorInItsParent: true,
    },
    (indent) => reindentBlock(subtree, fromIndent, indent),
  )
  if (!placement.ok) return refuseMove(placement.refusal.reason, placement.refusal.message)

  // The names the markup reads must resolve where it LANDS - the container, or
  // the anchor's own parent when that is not the same place.
  const outOfScope = freeVariablesOutOfScopeAt(target.element, placement.landing, sourceFile)
  if (outOfScope.length > 0) return refuseMove('out-of-scope', outOfScopeMessage(outOfScope))

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
