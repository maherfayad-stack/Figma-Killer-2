/**
 * deleteJsxElement — `struct-01`, the write behind "delete this element" on
 * the board. Removes the JSX child element at a `line:col`, along with the
 * indentation and newline it owned, and writes the file back.
 *
 * ## It no longer refuses over imports
 *
 * This used to REFUSE when every remaining reference to an imported binding
 * lived inside the deleted subtree — `<TabBar/>` was the only `TabBar` — on
 * the grounds that removing the import too would make the edit touch a second,
 * unrelated place in the file. That was the wrong reading of "one honest
 * target". The import's only reason to exist WAS the element; the two are one
 * fact written in two places, and the second is derived mechanically, not
 * guessed. `insertJsxElement` had the symmetric half right all along —
 * inserting `<Button/>` writes the `Button` import — so the asymmetry meant
 * Studio could add an element it was then unable to remove, and told the user
 * to go finish the job by hand.
 *
 * The import is retired by `pruneOrphanedImports`, which the save batch runs
 * ONCE PER FILE after every edit has landed. That module's doc explains why it
 * cannot live here: an import sits at the top of the file, so deleting its
 * line mid-batch shifts the pending `line:col` of every edit still queued
 * below it — the exact hazard `orderStudioEditsForApply` exists to prevent —
 * and a binding shared by two elements being deleted together is orphaned by
 * neither one alone, so asked per edit the answer is wrong anyway.
 *
 * ## Deleting what a component returns leaves `return null` (G-7)
 *
 * The outermost element of a component has no siblings, and removing its bytes
 * leaves `return ;`, a file that no longer parses - which is why this used to
 * refuse `no-jsx-parent`. "Nothing" is a thing a component can render, though,
 * and it is what the person asked for: the element is replaced by `null`, in
 * place (`return (\n<div/>\n)` becomes `return null`, a concise arrow body
 * `() => <div/>` becomes `() => null`). A returned conditional keeps its other
 * state exactly like a ternary branch inside markup does (`cond ? <A/> : <B/>`
 * loses `<A/>` to `null`), and `cond && <X/>` goes whole, its condition with it.
 * Whatever else an element can be the value of - a variable, an argument, a
 * list item - still refuses: nothing says `null` is what that code wants.
 *
 * ## A conditional element goes with its condition (WB-20)
 *
 * `{cond && <X/>}` renders `<X/>` or nothing, so deleting `<X/>` removes the
 * whole `{…}` container: what is left would otherwise be `{cond && }`, which
 * does not parse, and there is no other state to keep. A ternary BRANCH
 * (`{cond ? <X/> : <Y/>}`) is replaced with `null` instead, because the other
 * branch is a state the user did not delete. Either way the element is gone in
 * every state, which is what deleting it on the canvas means. A `.map` row
 * still refuses `expression-child` — see `resolveJsxChildRange`'s
 * `'conditional'` unit.
 *
 * ## Deliberately does NOT tidy up after itself
 *
 * A codemod that collapses a now-empty parent or reformats the gap it left is
 * a codemod that changes bytes the user never pointed at. What is left behind
 * is exactly the file minus one element.
 *
 * ## Its undo is not its business
 *
 * ⌘Z after a delete is the editor's undo journal (P3-F,
 * `server/handlers/studio/undoJournal.ts`), which records the whole file
 * before the batch runs and puts it back byte for byte. So nothing here hands
 * back the bytes it cut.
 */
import { Node, SyntaxKind, type Project } from 'ts-morph'
import { createProject, findJsxElementAtLocation, loadSourceFile } from './locateJsxElement'
import {
  resolveJsxChildRange,
  verbatimSourceText,
  writeVerbatimSource,
  type JsxChildRangeReason,
} from './jsxChildRange'
import { STALE_SOURCE_MESSAGE } from '@core/utils/refusalCopy'

export interface DeleteJsxElementParams {
  file: string
  /** 1-based line/col of the element being deleted (its tag-name start). */
  line: number
  col: number
  /** Optional pre-existing project to reuse. */
  project?: Project
}

export type DeleteJsxRefusalReason = JsxChildRangeReason

export interface DeleteJsxRefusal {
  reason: DeleteJsxRefusalReason
  /** Human-readable, suitable for a toast. */
  message: string
}

export type DeleteJsxElementResult = { ok: true } | { ok: false; refusal: DeleteJsxRefusal }

/** True when `node` is the whole value of a `return` or of a concise arrow body - what a component hands back. */
function isReturnedValue(node: Node): boolean {
  const parent = node.getParent()
  return Node.isReturnStatement(parent) || (Node.isArrowFunction(parent) && parent.getBody() === node)
}

/** `node` and the parentheses written around it: `(` ... `)` belong to the value, not to the element. */
function withParentheses(node: Node): Node {
  let outer = node
  while (Node.isParenthesizedExpression(outer.getParent())) outer = outer.getParent()!
  return outer
}

/**
 * The bytes to overwrite with `null` when the element at `line:col` is what its
 * component returns - see the module doc - or `null` when it is the value of
 * something else (a variable, an argument, a list), where `null` is a guess.
 */
function returnedRootReplacement(
  sourceFile: ReturnType<typeof loadSourceFile>,
  line: number,
  col: number,
): { start: number; end: number } | null {
  const opening = findJsxElementAtLocation(sourceFile, line, col)
  if (!opening) return null
  let value: Node = withParentheses(Node.isJsxSelfClosingElement(opening) ? opening : opening.getParentOrThrow())
  // Up through the conditionals the value is written inside. What is replaced is
  // decided by the INNERMOST one: a ternary branch alone (the other state stays),
  // the whole `a && <X/>` (the element's condition goes with it), the fallback of
  // `a || <X/>` alone. Outer layers only have to lead to the return.
  let replaced: Node | null = null
  for (;;) {
    const parent = value.getParent()
    if (Node.isConditionalExpression(parent) && (parent.getWhenTrue() === value || parent.getWhenFalse() === value)) {
      replaced ??= value
      value = withParentheses(parent)
      continue
    }
    if (Node.isBinaryExpression(parent) && parent.getRight() === value) {
      const operator = parent.getOperatorToken().getKind()
      if (operator === SyntaxKind.AmpersandAmpersandToken) replaced ??= withParentheses(parent)
      else if (operator === SyntaxKind.BarBarToken || operator === SyntaxKind.QuestionQuestionToken) replaced ??= value
      else return null
      value = withParentheses(parent)
      continue
    }
    break
  }
  if (!isReturnedValue(value)) return null
  const target = replaced ?? value
  return { start: target.getStart(), end: target.getEnd() }
}

export function deleteJsxElement(params: DeleteJsxElementParams): DeleteJsxElementResult {
  const { file, line, col } = params
  const project = params.project ?? createProject()
  const sourceFile = loadSourceFile(project, file)

  const target = resolveJsxChildRange(sourceFile, line, col, 'conditional')
  if (!target.ok && target.reason !== 'no-jsx-parent') {
    return { ok: false, refusal: { reason: target.reason, message: target.message } }
  }

  const verbatim = verbatimSourceText(sourceFile, file)
  if (verbatim === null) {
    return {
      ok: false,
      refusal: {
        reason: 'stale-source',
        message: STALE_SOURCE_MESSAGE,
      },
    }
  }

  if (!target.ok) {
    // What the component returns: `null` in its place, or the refusal it always was.
    const replaced = returnedRootReplacement(sourceFile, line, col)
    if (!replaced) return { ok: false, refusal: { reason: target.reason, message: target.message } }
    writeVerbatimSource(sourceFile, file, verbatim.slice(0, replaced.start) + 'null' + verbatim.slice(replaced.end))
    return { ok: true }
  }

  const branch = target.range.ternaryBranch
  if (branch) {
    // The other state stays; this one renders nothing from now on.
    writeVerbatimSource(sourceFile, file, verbatim.slice(0, branch.start) + 'null' + verbatim.slice(branch.end))
    return { ok: true }
  }
  writeVerbatimSource(sourceFile, file, verbatim.slice(0, target.range.start) + verbatim.slice(target.range.end))
  return { ok: true }
}
