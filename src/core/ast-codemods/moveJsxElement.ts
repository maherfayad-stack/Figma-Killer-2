/**
 * moveJsxElement — `struct-01`, the write behind a sibling reorder on the
 * board. Moves the JSX child element at one `line:col` to sit immediately
 * before or after the sibling element at another, and writes the file back.
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
 * FAILS CLOSED, and says why. `struct-01`'s whole point is that a structural
 * edit either changes the file or reports a reason; there is no third outcome.
 * The refusals here are the ones only the AST can answer — whether the two
 * elements are really siblings, and whether their formatting admits a move
 * that leaves every other byte alone. The refusals that can be decided from a
 * node id alone (a `.map` row, a shared component, route chrome) are answered
 * earlier and cheaper by `refuseStructuralEdit` in `@core/page-tree`.
 *
 * BYTE-EXACTNESS. The AST locates; the write is a splice of the original
 * bytes (see `jsxChildRange.ts`). Comments, blank lines, attribute wrapping
 * and every untouched sibling survive verbatim — asserted in
 * `__tests__/moveJsxElement.test.ts` against whole-file fixtures.
 */
import { Project } from 'ts-morph'
import { createProject, loadSourceFile } from './locateJsxElement'
import {
  resolveJsxChildRange,
  spliceRange,
  verbatimSourceText,
  writeVerbatimSource,
  type JsxChildRangeReason,
} from './jsxChildRange'

export interface MoveJsxElementParams {
  file: string
  /** 1-based line/col of the element being moved (its tag-name start). */
  line: number
  col: number
  /** 1-based line/col of the sibling it is written against. */
  anchorLine: number
  anchorCol: number
  /** Which side of the anchor the element lands on. */
  position: 'before' | 'after'
  /** Optional pre-existing project to reuse. */
  project?: Project
}

export type MoveJsxRefusalReason = JsxChildRangeReason | 'same-element' | 'not-siblings' | 'mixed-indentation'

export interface MoveJsxRefusal {
  reason: MoveJsxRefusalReason
  /** Human-readable, suitable for a toast. */
  message: string
}

export type MoveJsxElementResult = { ok: true } | { ok: false; refusal: MoveJsxRefusal }

export function moveJsxElement(params: MoveJsxElementParams): MoveJsxElementResult {
  const { file, line, col, anchorLine, anchorCol, position } = params
  const project = params.project ?? createProject()
  const sourceFile = loadSourceFile(project, file)

  const target = resolveJsxChildRange(sourceFile, line, col)
  if (!target.ok) return { ok: false, refusal: { reason: target.reason, message: target.message } }
  const anchor = resolveJsxChildRange(sourceFile, anchorLine, anchorCol)
  if (!anchor.ok) return { ok: false, refusal: { reason: anchor.reason, message: anchor.message } }

  if (target.range.element === anchor.range.element) {
    return {
      ok: false,
      refusal: { reason: 'same-element', message: 'An element cannot be moved next to itself.' },
    }
  }
  if (target.range.parent !== anchor.range.parent) {
    return {
      ok: false,
      refusal: {
        reason: 'not-siblings',
        message:
          'These two elements are not siblings in the code — the canvas shows them side by side, but the source nests them differently, so there is no single place to write the new order.',
      },
    }
  }
  if (target.range.wholeLine !== anchor.range.wholeLine) {
    return {
      ok: false,
      refusal: {
        reason: 'mixed-indentation',
        message:
          'One of these elements is on a line of its own and the other shares a line, so Studio cannot move one past the other without reformatting code you did not touch. Reorder them in the file instead.',
      },
    }
  }

  const verbatim = verbatimSourceText(sourceFile, file)
  if (verbatim === null) {
    return {
      ok: false,
      refusal: {
        reason: 'stale-source',
        message: 'This file changed on disk since the canvas last read it. Reload the project and try the move again.',
      },
    }
  }

  const at = position === 'before' ? anchor.range.start : anchor.range.end
  writeVerbatimSource(sourceFile, file, spliceRange(verbatim, target.range.start, target.range.end, at))
  return { ok: true }
}
