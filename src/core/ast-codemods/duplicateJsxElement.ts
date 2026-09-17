/**
 * duplicateJsxElement — W4-1, the write behind "duplicate this element" on a
 * studio-imported board. Copies the JSX child at a `line:col` and writes the
 * copy in as its own next sibling.
 *
 * WHY THIS CAN EXIST AT ALL
 * -------------------------
 * Duplicate used to be a blanket refusal, on the stated grounds that "the copy
 * would have no source location of its own, so it could never be written back".
 * That was true of a copy MINTED ON THE CANVAS — and false of this one.
 * `insertJsxElement` had already shown the way out: write the element into the
 * `.tsx`, then re-read the board, and what comes back is an ordinary parsed
 * node with a real `rel:line:col`. Duplicate is the same move with the source
 * text taken from the element already on screen instead of from a picker.
 *
 * TWO FORMS, ONE FUNCTION (K2)
 * ----------------------------
 *  - **In place** (no `destination`) — the copy lands as the original's own
 *    next sibling. The ⌘D / toolbar gesture.
 *  - **Duplicate-to** (`destinationLine`/`destinationCol`) — Alt+drag. The
 *    destination names the CONTAINER the copy lands in; placement inside it is
 *    `jsxChildPlacement.ts`'s job, the same function an insert and a reparent
 *    both use, so an Alt-dragged copy lands with exactly the whitespace a
 *    newly inserted element would have had.
 *
 * The two forms mirror `moveJsxElement`'s reorder/reparent split deliberately:
 * Alt+drag and drag are the same gesture with one modifier, so they must not
 * be able to disagree about where "there" is.
 *
 * NO IMPORT RECONCILIATION, BY CONSTRUCTION
 * -----------------------------------------
 * The copy lands in the same FILE either way — cross-file is refused a layer
 * up (`refuseStructuralEdit`'s `cross-file`, from the two node ids alone), and
 * `applyStudioEdit` drops a `parentNodeId` that decodes to another file. So
 * every import the markup names is already present.
 *
 * SCOPE IS STILL A QUESTION FOR THE DUPLICATE-TO FORM. In place, every binding
 * the markup captures — a destructured prop, a `.map` callback's parameter —
 * is in scope at the new position precisely because it was in scope one line
 * up, which is what made the original duplicate the cheapest of the three
 * W4-1 verbs. A copy dropped into a DIFFERENT container in the same file has
 * no such guarantee: markup lifted out of a `.map` callback loses the row it
 * read. `freeVariablesOutOfScopeAt` answers that statically, exactly as it
 * does for a reparent, and the refusal names the variables.
 *
 * BYTE-EXACTNESS, same standard as its siblings: the AST only LOCATES, and the
 * write is a splice of the original bytes (`jsxChildRange.ts`). The copy is the
 * original's own text, character for character — its comments, its attribute
 * wrapping and its blank lines included — so a duplicated element reads like
 * the thing it was duplicated from rather than like something a printer
 * re-emitted.
 */
import { type Project, type SourceFile } from 'ts-morph'
import { createProject, findJsxElementAtLocation, loadSourceFile } from './locateJsxElement'
import {
  resolveJsxChildRange,
  verbatimSourceText,
  writeVerbatimSource,
  type JsxChildRange,
  type JsxChildRangeReason,
} from './jsxChildRange'
import { lineIndentAt, reindentBlock, resolveChildPlacement } from './jsxChildPlacement'
import { freeVariablesOutOfScopeAt } from './subtreeFreeVariables'

export interface DuplicateJsxElementParams {
  file: string
  /** 1-based line/col of the element being duplicated (its tag-name start). */
  line: number
  col: number
  /**
   * 1-based line/col of the CONTAINER the copy lands in (K2's Alt+drag).
   * Omit to copy in place, as the original's own next sibling.
   */
  destinationLine?: number
  destinationCol?: number
  /**
   * 1-based line/col of an existing child of the destination to land beside.
   * Only meaningful with a destination; without one the copy is appended as
   * the destination's last child, which is a real position — the same reading
   * `insert` and `reparent` give a missing anchor.
   */
  anchorLine?: number
  anchorCol?: number
  /** Which side of the anchor the copy lands on. */
  position?: 'before' | 'after'
  /** Optional pre-existing project to reuse. */
  project?: Project
}

/**
 * Every refusal here is `resolveJsxChildRange`'s own, and each stays a refusal
 * for a reason duplicate does not change:
 *
 *  - **`no-jsx-parent`** — the element is what the component RETURNS. A copy
 *    beside it would be a second root, which is not valid JSX; a component
 *    returns exactly one element.
 *  - **`expression-child`** — the element is produced by an expression
 *    (`{cond && <X/>}`, a `.map`). Copying the JSX would copy the branch, not
 *    the element the canvas is showing.
 *  - **`not-found` / `stale-source`** — the file no longer says what the board
 *    thinks it says.
 */
export type DuplicateJsxRefusalReason =
  | JsxChildRangeReason
  // The duplicate-to form only (K2) — the same three a reparent can hit, for
  // the same reasons; see `moveJsxElement`.
  | 'not-a-container'
  | 'into-own-descendant'
  | 'out-of-scope'
  | 'binding-conflict'
  | 'unsafe-tag'
  | 'void-element-children'
  | 'not-siblings'

export interface DuplicateJsxRefusal {
  reason: DuplicateJsxRefusalReason
  /** Human-readable, suitable for a toast. */
  message: string
}

export type DuplicateJsxElementResult = { ok: true } | { ok: false; refusal: DuplicateJsxRefusal }

function refuseDuplicate(
  reason: DuplicateJsxRefusalReason,
  message: string,
): DuplicateJsxElementResult {
  return { ok: false, refusal: { reason, message } }
}

export function duplicateJsxElement(params: DuplicateJsxElementParams): DuplicateJsxElementResult {
  const { file, line, col } = params
  const project = params.project ?? createProject()
  const sourceFile = loadSourceFile(project, file)

  const target = resolveJsxChildRange(sourceFile, line, col)
  if (!target.ok) return refuseDuplicate(target.reason, target.message)

  const verbatim = verbatimSourceText(sourceFile, file)
  if (verbatim === null) {
    return refuseDuplicate(
      'stale-source',
      'This file changed on disk since the canvas last read it. Reload the project and try again.',
    )
  }

  return params.destinationLine !== undefined && params.destinationCol !== undefined
    ? duplicateInto(sourceFile, file, verbatim, target.range, params, params.destinationLine, params.destinationCol)
    : duplicateInPlace(sourceFile, file, verbatim, target.range)
}

/** The original in-place copy: the element's own bytes, again, as its next sibling. */
function duplicateInPlace(
  sourceFile: SourceFile,
  file: string,
  verbatim: string,
  target: JsxChildRange,
): DuplicateJsxElementResult {
  const { start, end, wholeLine } = target
  const copy = verbatim.slice(start, end)
  // A whole-line range already carries its own indentation and trailing
  // newline, so re-inserting it verbatim at `end` produces a second, identically
  // indented line. An inline element owns only itself, so it joins the row the
  // way a hand-written sibling would: separated by one space.
  const inserted = wholeLine ? copy : ` ${copy}`

  writeVerbatimSource(sourceFile, file, verbatim.slice(0, end) + inserted + verbatim.slice(end))
  return { ok: true }
}

/**
 * K2's Alt+drag: the element's own bytes, written into a DIFFERENT container
 * in the same file, exactly where an insert would have put a new element.
 *
 * ONE edit, not two — this is what makes duplicate-to strictly simpler than
 * the reparent it mirrors: there is nothing to remove, so no last-first
 * `applyTextEdits` ordering and no `exclude` range for the placement to step
 * around. The original stays exactly where it is, byte for byte.
 */
function duplicateInto(
  sourceFile: SourceFile,
  file: string,
  verbatim: string,
  target: JsxChildRange,
  params: DuplicateJsxElementParams,
  destinationLine: number,
  destinationCol: number,
): DuplicateJsxElementResult {
  const destination = findJsxElementAtLocation(sourceFile, destinationLine, destinationCol)
  if (!destination) {
    return refuseDuplicate(
      'not-found',
      `No JSX element is written at line ${destinationLine}, column ${destinationCol} any more — the file changed since the canvas last read it. Reload and try again.`,
    )
  }

  // A copy INSIDE the thing being copied would splice the element's own bytes
  // into the middle of the range they were read from — the copy would contain
  // a stale, half-written version of itself. The canvas already refuses this
  // at the tree level (`resolvePageTreeDropTarget` never resolves a drop into
  // a descendant of the dragged node); this is the same refusal one layer
  // down, so a programmatic caller cannot reach past it.
  if (destination.getStart() >= target.start && destination.getEnd() <= target.end) {
    return refuseDuplicate(
      'into-own-descendant',
      'That container is inside the element being copied, so the copy would end up inside itself.',
    )
  }

  const outOfScope = freeVariablesOutOfScopeAt(target.element, destination, sourceFile)
  if (outOfScope.length > 0) {
    const names = outOfScope.map((name) => `\`${name}\``).join(', ')
    return refuseDuplicate(
      'out-of-scope',
      `This element reads ${names} from the code around it, and ${outOfScope.length === 1 ? 'that name is' : 'those names are'} not in scope where the copy would land — putting it there would break the file. Copy it somewhere inside the same component, or pass ${outOfScope.length === 1 ? 'the value' : 'those values'} through first.`,
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
    },
    (indent) => reindentBlock(subtree, fromIndent, indent),
  )
  if (!placement.ok) return refuseDuplicate(placement.refusal.reason, placement.refusal.message)

  const { start, end, text } = placement.edit
  writeVerbatimSource(sourceFile, file, verbatim.slice(0, start) + text + verbatim.slice(end))
  return { ok: true }
}
