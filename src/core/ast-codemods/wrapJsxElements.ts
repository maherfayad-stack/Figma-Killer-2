/**
 * wrapJsxElements — K3, the write behind ⌘G on SEVERAL elements: one new
 * container written around a CONTIGUOUS RUN of JSX siblings.
 *
 * WHY THIS IS NOT `wrapJsxElement` IN A LOOP
 * ------------------------------------------
 * Wrapping three siblings one at a time produces three wrappers, not a group.
 * The gesture the user made is "put these, together, inside one thing", and in
 * the source that is a SINGLE span — from the first element's tag start to the
 * last element's closing `>` — replaced by itself inside one new element. One
 * write, one target, and every byte between the endpoints (the blank line the
 * user left, a comment, the text between two inline tags) travels verbatim,
 * because it is inside the span rather than something this codemod re-renders.
 *
 * WHAT "CONTIGUOUS" HAS TO MEAN IN THE SOURCE
 * -------------------------------------------
 * The canvas child list and the JSX child list are not the same list, so
 * "these three rows looked adjacent on the board" is not enough. Two checks,
 * both on the AST:
 *
 *   1. Every element is a child of the SAME JSX parent (`not-siblings`).
 *   2. The parent's element children between the first and the last are
 *      EXACTLY the ones named (`not-contiguous`). Otherwise the wrapper would
 *      swallow an element the user never selected — N targets for a gesture
 *      that named one span.
 *
 * An EXPRESSION child inside the span (`{cond && <X/>}`, a `.map`) refuses
 * (`expression-child`). The bytes sit between the endpoints, so a wrapper
 * around the span necessarily contains them — but what they render is decided
 * when the app runs, so Studio cannot say what it would be nesting. Ordinary
 * TEXT between the endpoints is carried, because it is inert, visible, and
 * leaving it outside would REORDER it out of the group rather than group.
 *
 * INDENTATION, AND THE ONE PLACE IT MOVES. Exactly `wrapJsxElement`'s rule:
 * the wrapped span gains one level (`reindentBlock` — leading whitespace only),
 * every line outside it is untouched to the byte, and a run that shares one
 * line (`<div><a/><b/></div>`) is wrapped in place with no reindentation at
 * all. A run where some elements own their line and others share one refuses
 * (`mixed-indentation`), for the same reason a move across that boundary does:
 * there is no correct answer for where the newlines go.
 */
import { Node, type Project, type SourceFile } from 'ts-morph'
import { createProject, loadSourceFile } from './locateJsxElement'
import {
  applyTextEdits,
  resolveJsxChildRange,
  verbatimSourceText,
  writeVerbatimSource,
  type JsxChildRange,
} from './jsxChildRange'
import { elementChildren, indentUnit, lineIndentAt, reindentBlock } from './jsxChildPlacement'
import { conflictingBinding, resolveImportEdits } from './jsxImportEdits'
import { validateSubtree, type InsertJsxRefusalReason } from './jsxSubtree'
import { createdJsxLocation, offsetAfterEdits, type CreatedJsxLocation } from './createdJsxLocation'

export interface WrapJsxElementsParams {
  file: string
  /**
   * 1-based line/col of each element in the run (its tag-name start), in any
   * order. One target is allowed and behaves exactly like `wrapJsxElement`.
   */
  targets: readonly { line: number; col: number }[]
  /**
   * Tag name of the wrapper — an intrinsic element (`div`, `section`) with no
   * `importSpecifier`, a component (`Stack`) with one. Same distinction
   * `insertJsxElement`/`wrapJsxElement` draw, for the same reason.
   */
  name: string
  /** Module the wrapper is imported from. Omit for an intrinsic tag, which needs no import. */
  importSpecifier?: string
  /** Optional pre-existing project to reuse. */
  project?: Project
}

/**
 * Why a group could not be written. `not-contiguous` is this codemod's own:
 * the named elements do not form an unbroken run of the parent's element
 * children, so one wrapper around them would also wrap something else.
 */
export type WrapJsxElementsRefusalReason =
  // Everything an insert can refuse (`not-found`, `no-jsx-parent`,
  // `expression-child`, `stale-source`, `not-siblings`, `binding-conflict`,
  // `unsafe-tag`, …) — the wrapper is written through the same gates.
  | InsertJsxRefusalReason
  | 'not-contiguous'
  | 'mixed-indentation'
  | 'no-targets'

export interface WrapJsxElementsRefusal {
  reason: WrapJsxElementsRefusalReason
  /** Human-readable, suitable for a toast. */
  message: string
}

/** A refused group, as both the public result and every internal helper return it. */
type WrapJsxElementsRefused = { ok: false; refusal: WrapJsxElementsRefusal }

/** `created` is the CONTAINER's own tag-name `line:col` — see `createdJsxLocation.ts`. */
export type WrapJsxElementsResult = { ok: true; created: CreatedJsxLocation | null } | WrapJsxElementsRefused

function refuseWrap(reason: WrapJsxElementsRefusalReason, message: string): WrapJsxElementsRefused {
  return { ok: false, refusal: { reason, message } }
}

export function wrapJsxElements(params: WrapJsxElementsParams): WrapJsxElementsResult {
  const { file, targets, name, importSpecifier } = params
  if (targets.length === 0) {
    return refuseWrap('no-targets', 'A group is written around elements, and none were named.')
  }

  const project = params.project ?? createProject()
  const sourceFile = loadSourceFile(project, file)

  // The wrapper is source that runs the moment the user starts their dev
  // server, so it goes through the identical tag-safety gate every written tag
  // does — before a byte is read, let alone written.
  const invalid = validateSubtree({ name, ...(importSpecifier === undefined ? {} : { importSpecifier }) })
  if (invalid) return invalid

  const run = resolveRun(sourceFile, targets)
  if (!run.ok) return run

  if (importSpecifier !== undefined) {
    const binding = conflictingBinding(sourceFile, name, importSpecifier)
    if (binding) {
      return refuseWrap(
        'binding-conflict',
        `This file already uses the name "${name}" for something else (${binding}), so grouping with that component here would shadow it. Rename one of them in the file first.`,
      )
    }
  }

  const verbatim = verbatimSourceText(sourceFile, file)
  if (verbatim === null) {
    return refuseWrap(
      'stale-source',
      'This file changed on disk since the canvas last read it. Reload the project and try again.',
    )
  }

  const first = run.ranges[0]!
  const last = run.ranges[run.ranges.length - 1]!
  // The span is measured between the ELEMENTS, not between their owned ranges:
  // the indentation before the first and the newline after the last stay
  // exactly where they are — what moves inside the wrapper is the run itself.
  const spanStart = first.element.getStart()
  const spanEnd = last.element.getEnd()
  const span = verbatim.slice(spanStart, spanEnd)

  const baseIndent = lineIndentAt(verbatim, spanStart)
  const unit = indentUnit(verbatim)

  const edit = first.wholeLine
    ? {
        start: first.start,
        end: last.end,
        text:
          [
            `${baseIndent}<${name}>`,
            `${baseIndent}${unit}${reindentBlock(span, baseIndent, baseIndent + unit)}`,
            `${baseIndent}</${name}>`,
          ].join('\n') + '\n',
      }
    : { start: spanStart, end: spanEnd, text: `<${name}>${span}</${name}>` }

  const importEdits = resolveImportEdits(
    sourceFile,
    verbatim,
    importSpecifier === undefined ? new Map() : new Map([[name, importSpecifier]]),
  )

  writeVerbatimSource(sourceFile, file, applyTextEdits(verbatim, [edit, ...importEdits]))
  return { ok: true, created: createdJsxLocation(sourceFile, offsetAfterEdits(importEdits, edit.start), edit.text) }
}

/** The named elements as one unbroken run of a single parent's element children, or why they are not one. */
function resolveRun(
  sourceFile: SourceFile,
  targets: readonly { line: number; col: number }[],
): { ok: true; ranges: JsxChildRange[] } | WrapJsxElementsRefused {
  const ranges: JsxChildRange[] = []
  for (const target of targets) {
    const resolved = resolveJsxChildRange(sourceFile, target.line, target.col)
    if (!resolved.ok) return refuseWrap(resolved.reason, resolved.message)
    // The same element named twice is one member of the run, not two.
    if (!ranges.some((range) => range.element === resolved.range.element)) ranges.push(resolved.range)
  }

  const parent = ranges[0]!.parent
  if (ranges.some((range) => range.parent !== parent)) {
    return refuseWrap(
      'not-siblings',
      'These elements are not siblings in the code — the canvas shows them side by side, but the source nests them differently, so one container cannot be written around them. Select siblings next to each other.',
    )
  }

  ranges.sort((a, b) => a.element.getStart() - b.element.getStart())

  if (ranges.some((range) => range.wholeLine !== ranges[0]!.wholeLine)) {
    return refuseWrap(
      'mixed-indentation',
      'Some of these elements sit on a line of their own and others share a line, so Studio cannot put one container around them without reformatting code you did not touch. Group them in the file instead.',
    )
  }

  const contiguity = refuseGaps(parent, ranges)
  if (contiguity) return contiguity

  return { ok: true, ranges }
}

/** Refuses when anything the user did not name sits between the first and last element of the run. */
function refuseGaps(
  parent: Node,
  ranges: readonly JsxChildRange[],
): WrapJsxElementsRefused | null {
  if (!Node.isJsxElement(parent) && !Node.isJsxFragment(parent)) return null

  const siblings: Node[] = elementChildren(parent)
  const first = siblings.indexOf(ranges[0]!.element)
  const last = siblings.indexOf(ranges[ranges.length - 1]!.element)
  if (first === -1 || last === -1) return null
  if (last - first + 1 !== ranges.length) {
    return refuseWrap(
      'not-contiguous',
      'There are other elements in the code between the ones selected, so a single container around them would wrap those too. Select siblings next to each other.',
    )
  }

  // An expression child inside the span is NOT skippable: its bytes are
  // between the endpoints, so the wrapper necessarily contains it — and what
  // it renders is decided when the app runs, so Studio cannot say what it
  // would be nesting.
  const spanStart = ranges[0]!.element.getStart()
  const spanEnd = ranges[ranges.length - 1]!.element.getEnd()
  for (const child of parent.getJsxChildren()) {
    if (!Node.isJsxExpression(child)) continue
    if (child.getStart() > spanStart && child.getEnd() < spanEnd) {
      return refuseWrap(
        'expression-child',
        'Something the code decides — a condition, a list, or a helper — sits between these elements, so a container around them would also contain whatever it renders. Group the elements around it instead.',
      )
    }
  }
  return null
}
