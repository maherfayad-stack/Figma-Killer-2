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
 * WHAT "CONTIGUOUS" HAS TO MEAN IN THE SOURCE, AND WHAT HAPPENS WHEN IT ISN'T
 * -----------------------------------------------------------------------------
 * The canvas child list and the JSX child list are not the same list, so
 * "these three rows looked adjacent on the board" is not enough. The span form
 * above is honest for exactly one shape of selection: siblings of ONE JSX
 * parent with nothing the person did not select between the first and the last
 * (no other element, no `{cond && <X/>}`, no `.map`) - otherwise the wrapper
 * would swallow something never selected.
 *
 * Any other selection used to refuse (`not-siblings`, `not-contiguous`,
 * `expression-child`) and ask the person to rearrange their elements first. It
 * is written by `gatherGroupRun.ts` instead (G-7): the first member keeps its
 * place and gets the container, the others are cut from where they are and
 * written inside it, in source order, and everything unselected stays exactly
 * where it was. Ordinary TEXT and comments between the members of an unbroken
 * run are carried, because they are inert, visible, and leaving them outside
 * would REORDER them out of the group rather than group.
 *
 * THE CONTAINER'S TAG FOLLOWS THE HTML CONTENT MODEL (`struct-11`). The caller
 * names `div`; this writes `div` or `span`, whichever is legal between the
 * parent above the run and the elements in it, and refuses (`content-model`)
 * when neither is — grouping two `<li>`s, or anything inside a `<ul>`. The
 * rule is `@core/utils/htmlContentModel`; the two facts it needs are collected
 * from the AST by `wrapperContentModel.ts`.
 *
 * INDENTATION, AND THE ONE PLACE IT MOVES. Exactly `wrapJsxElement`'s rule:
 * the wrapped span gains one level (`reindentBlock` — leading whitespace only),
 * every line outside it is untouched to the byte, and a run that sits on one
 * line (`<div><a/><b/></div>`) is wrapped in place with no reindentation at
 * all. A run that spans lines but starts or ends in the middle of one (WB-21:
 * `<x/><a/>` then `<b/>` on the next line, grouping `a` and `b`) is split at
 * its two ends so the container owns its lines: the sibling that shared the
 * run's first line keeps it, and one that shared its last line moves to a line
 * of its own after the container. Inside the container every byte of the run
 * travels as it was.
 */
import { type Project, type SourceFile } from 'ts-morph'
import { createProject, loadSourceFile } from './locateJsxElement'
import {
  applyTextEdits,
  resolveJsxChildRange,
  verbatimSourceText,
  writeVerbatimSource,
  type JsxChildRange,
} from './jsxChildRange'
import { indentUnit, lineIndentAt, reindentBlock, trimTrailingBlankBack } from './jsxChildPlacement'
import { applyGather, gatherRun, isUnbrokenRun, namesLostByGathering, topLevelMembers } from './gatherGroupRun'
import { planImportBindings, resolveImportEdits } from './jsxImportEdits'
import { validateSubtree } from './jsxSubtree'
import type { WrapJsxRefusalReason } from './wrapJsxElement'
import { createdJsxLocation, offsetAfterEdits, type CreatedJsxLocation } from './createdJsxLocation'
import { ancestorTagNames, intrinsicTagName, resolveWrapperTag } from './wrapperContentModel'
import { jsStringSpelling, preferredQuote } from './stringSpelling'

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
  /**
   * Inline style the wrapper is written with (`style={{ position: 'absolute',
   * left: '10px' }}`), camelCase CSS keys in the order given. Frame selection
   * (PA-6) is the caller: a frame is a container that is sized and placed.
   * Omit for the bare container ⌘G writes.
   */
  wrapperStyle?: Readonly<Record<string, string>>
  /** Refuse a selection that is not one unbroken run instead of gathering it (a frame, PA-6). */
  requireRun?: true
  /** Optional pre-existing project to reuse. */
  project?: Project
}

/** ` style={{ a: 'x', b: 'y' }}` — the attribute text, or `''` for no style. */
function styleAttributeText(style: Readonly<Record<string, string>> | undefined, sourceFile: SourceFile): string {
  const entries = Object.entries(style ?? {})
  if (entries.length === 0) return ''
  const quote = preferredQuote(sourceFile)
  return ` style={{ ${entries.map(([key, value]) => `${key}: ${jsStringSpelling(value, quote)}`).join(', ')} }}`
}

/**
 * Why a group could not be written. `out-of-scope` is this codemod's own: a
 * member that has to be gathered next to the first reads a name that is not
 * visible where the container would sit (G-7).
 */
export type WrapJsxElementsRefusalReason =
  // Everything an insert can refuse (`not-found`, `no-jsx-parent`,
  // `expression-child`, `stale-source`,
  // `unsafe-tag`, …) plus `content-model` — the wrapper is written through the
  // same gates as `wrapJsxElement`, and refuses for the same extra reason.
  | WrapJsxRefusalReason
  | 'out-of-scope'
  // `requireRun` only: a frame measured its members where they sit, so gathering them would change what it measured.
  | 'not-contiguous'
  | 'no-targets'
  // PA-6 — `frameJsxElements` could not write a member's offsets, so the frame was taken back.
  | 'frame-unwritable'

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
  const gathered = !isUnbrokenRun(run.ranges)
  if (gathered && params.requireRun === true) {
    return refuseWrap(
      'not-contiguous',
      'There are other elements in the code between the ones selected, and a frame is measured around where they sit, so it cannot gather them. Select siblings next to each other.',
    )
  }
  if (gathered) {
    const lost = namesLostByGathering(sourceFile, run.ranges)
    if (lost.length > 0) {
      const names = lost.map((variable) => `\`${variable}\``).join(', ')
      return refuseWrap(
        'out-of-scope',
        `Grouping these would move an element that reads ${names} from the code around it, and ${lost.length === 1 ? 'that name is' : 'those names are'} not in scope where the container would sit — that would break the file. Group elements that sit in the same component, or pass ${lost.length === 1 ? 'the value' : 'those values'} through first.`,
      )
    }
  }

  // `struct-11` — WHAT the container is, decided from where it lands and what
  // it holds rather than hard-coded by the caller. A generic `div`/`span` is
  // re-picked from the HTML content model; anything else is checked and
  // refused rather than re-spelled. See `wrapperContentModel.ts`.
  const wrapper = resolveWrapperTag(name, importSpecifier, {
    ancestorTags: ancestorTagNames(run.ranges[0]!.parent),
    memberTags: run.ranges.map((range) => intrinsicTagName(range.element)),
  })
  if (!wrapper.ok) return refuseWrap(wrapper.refusal.reason, wrapper.refusal.message)
  // WB-19 — a component whose name the file already uses for something else
  // is imported under an alias (`{ Card as Card2 }`) and written by it,
  // never refused: the alias renders the same component and shadows nothing.
  const bindings = planImportBindings(
    sourceFile,
    importSpecifier === undefined ? new Map() : new Map([[wrapper.name, { specifier: importSpecifier }]]),
  )
  const tag = bindings.localName(wrapper.name)

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

  const opening = `${tag}${styleAttributeText(params.wrapperStyle, sourceFile)}`
  const importEdits = resolveImportEdits(sourceFile, verbatim, bindings.required)

  if (gathered) {
    // The first member's own span is where the container goes; the rest of the
    // members are cut out of wherever they were and travel inside it.
    const { span: gatheredSpan, removals } = gatherRun(verbatim, run.ranges)
    const wrap = ownLinesWrap(verbatim, spanStart, first.element.getEnd(), gatheredSpan, tag, opening, baseIndent, unit)
    writeVerbatimSource(sourceFile, file, applyGather(verbatim, [wrap, ...removals, ...importEdits]))
    return { ok: true, created: createdJsxLocation(sourceFile, offsetAfterEdits(importEdits, wrap.start), wrap.text) }
  }

  const edit = !span.includes('\n') && !first.wholeLine
    ? { start: spanStart, end: spanEnd, text: `<${opening}>${span}</${tag}>` }
    : ownLinesWrap(verbatim, spanStart, spanEnd, span, tag, opening, baseIndent, unit)

  writeVerbatimSource(sourceFile, file, applyTextEdits(verbatim, [edit, ...importEdits]))
  return { ok: true, created: createdJsxLocation(sourceFile, offsetAfterEdits(importEdits, edit.start), edit.text) }
}

/**
 * The edit that writes the container on lines of its own around a run that
 * spans lines. When the run already owns its first and last lines this is
 * byte-for-byte the classic whole-line wrap; when it starts or ends mid-line
 * the line is split there (see the module doc).
 */
function ownLinesWrap(
  verbatim: string,
  spanStart: number,
  spanEnd: number,
  span: string,
  tag: string,
  opening: string,
  baseIndent: string,
  unit: string,
): { start: number; end: number; text: string } {
  const lineStart = verbatim.lastIndexOf('\n', spanStart - 1) + 1
  const opensLine = verbatim.slice(lineStart, spanStart).trim() === ''
  const newlineAfter = verbatim.indexOf('\n', spanEnd)
  const lineEnd = newlineAfter === -1 ? verbatim.length : newlineAfter
  const closesLine = verbatim.slice(spanEnd, lineEnd).trim() === ''
  let trailing = spanEnd
  while (trailing < lineEnd && (verbatim[trailing] === ' ' || verbatim[trailing] === '\t')) trailing += 1
  const block = [
    `${baseIndent}<${opening}>`,
    `${baseIndent}${unit}${reindentBlock(span, baseIndent, baseIndent + unit)}`,
    `${baseIndent}</${tag}>`,
  ].join('\n')
  return {
    start: opensLine ? lineStart : trimTrailingBlankBack(verbatim, spanStart),
    end: closesLine ? Math.min(lineEnd + 1, verbatim.length) : trailing,
    text: `${opensLine ? '' : '\n'}${block}${closesLine ? '\n' : `\n${baseIndent}`}`,
  }
}

/**
 * The named elements, in source order, with any element that sits inside another
 * named one dropped (it travels with the one that holds it) - or why one of them
 * cannot be addressed at all. Whether they form an unbroken run is a separate
 * question, answered by `isUnbrokenRun`; either way they are written.
 */
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
  return { ok: true, ranges: topLevelMembers(ranges) }
}
