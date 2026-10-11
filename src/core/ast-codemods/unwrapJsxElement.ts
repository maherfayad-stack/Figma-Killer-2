/**
 * unwrapJsxElement — K3, the write behind ⌘⇧G: a container disappears and its
 * children take its place, at its own index, in its own parent.
 *
 * THE INVERSE OF `wrapJsxElement`, AND THE SAME KIND OF WRITE. One span — the
 * wrapper's own bytes — replaced by the bytes between its tags, re-hung one
 * indentation level out (`reindentBlock`'s rule: leading whitespace only).
 * Every comment, blank line and attribute inside the children survives
 * verbatim, and nothing outside the wrapper's own lines is touched.
 *
 * BEHAVIOUR IS KEPT, NOT DROPPED (G-7: `has-behaviour` no longer refuses)
 * ----------------------------------------------------------------------
 * Deleting an element from someone's repository is only honest when the
 * element is doing nothing but holding its children. A wrapper may carry
 * `className`, `style`, `id` or `data-*` and still be exactly that — Studio
 * itself writes the first two, and losing a class costs a visual the user can
 * see and re-apply. Anything else is BEHAVIOUR, and behaviour cannot be
 * hoisted into the children:
 *
 *   - an event handler (`onClick`) — the children do not inherit it;
 *   - a `ref` — code elsewhere reads that node;
 *   - a `key` — this element is a row of a list the code renders;
 *   - a spread (`{...props}`) — Studio cannot see what is in it;
 *   - a COMPONENT tag (`<Card>`) rather than an intrinsic element — its own
 *     file decides what the wrapper renders, and removing the call site here
 *     is not "ungroup", it is deleting a component usage.
 *
 * It used to refuse all five, and the person was left with a toast and no
 * ungroup. Now the children are handed back to the wrapper's parent and the
 * wrapper STAYS, emptied: `<div onClick={save}>…</div>` becomes
 * `<div onClick={save} />` followed by the children, every attribute byte
 * untouched. Nothing the code relied on is deleted - the ref still points at an
 * element, the handler is still attached to something - and the person decides
 * whether the husk goes (it stays in the layers tree, one Delete away).
 * `keptWrapper` on the result is how a caller can tell the two outcomes apart.
 *
 * WHAT THIS CANNOT SEE, and says so here rather than pretending otherwise: a
 * stylesheet rule that crosses the wrapper (`.list > .row`, `.card + .card`)
 * stops matching once the wrapper is gone. That is true of deleting any
 * element and is not something the AST can answer; the CSS lives in another
 * file and may not even be in the workspace.
 */
import { Node, type Project, type SourceFile } from 'ts-morph'
import { createProject, loadSourceFile } from './locateJsxElement'
import {
  applyTextEdits,
  resolveJsxChildRange,
  verbatimSourceText,
  writeVerbatimSource,
  type JsxChildRange,
  type JsxChildRangeReason,
} from './jsxChildRange'
import { lineIndentAt } from './jsxChildPlacement'
import { createdJsxLocationsIn, type CreatedJsxLocation } from './createdJsxLocation'
import type { JsxOpeningLikeElement } from './locateJsxElement'
import { STALE_SOURCE_MESSAGE } from '@core/utils/refusalCopy'

export interface UnwrapJsxElementParams {
  file: string
  /** 1-based line/col of the wrapper being removed (its tag-name start). */
  line: number
  col: number
  /** Optional pre-existing project to reuse. */
  project?: Project
}

/** Why a container could not be dissolved - only the ways the location itself fails. */
export type UnwrapJsxRefusalReason = JsxChildRangeReason

export interface UnwrapJsxRefusal {
  reason: UnwrapJsxRefusalReason
  /** Human-readable, suitable for a toast. */
  message: string
}

type UnwrapJsxRefused = { ok: false; refusal: UnwrapJsxRefusal }

/**
 * `relocated` (`store-14`) is the tag-name `line:col` of every child the
 * wrapper handed back, in source order — the ids the parser will mint for them
 * on the next read.
 *
 * An ungroup creates nothing and it is the one write that RELOCATES several
 * elements at once, which is both why the board used to be left with nothing
 * selected after ⌘⇧G and why its own undo (a group around the same run) needs
 * them. Empty for a self-closing wrapper, which hands nothing back.
 */
export type UnwrapJsxElementResult =
  | {
      ok: true
      relocated: CreatedJsxLocation[]
      /** G-7 - the container carried behaviour (see the module doc), so it was kept, emptied, and only its children moved out. */
      keptWrapper?: true
    }
  | UnwrapJsxRefused

function refuseUnwrap(reason: UnwrapJsxRefusalReason, message: string): UnwrapJsxRefused {
  return { ok: false, refusal: { reason, message } }
}

/**
 * The attributes a container may carry and still be ONLY a container.
 * `data-*` is matched by prefix; everything else is an exact name.
 */
const INERT_ATTRIBUTES: ReadonlySet<string> = new Set(['className', 'style', 'id'])

export function unwrapJsxElement(params: UnwrapJsxElementParams): UnwrapJsxElementResult {
  const { file, line, col } = params
  const project = params.project ?? createProject()
  const sourceFile = loadSourceFile(project, file)

  const target = resolveJsxChildRange(sourceFile, line, col)
  if (!target.ok) return refuseUnwrap(target.reason, target.message)

  const verbatim = verbatimSourceText(sourceFile, file)
  if (verbatim === null) {
    return refuseUnwrap(
      'stale-source',
      STALE_SOURCE_MESSAGE,
    )
  }

  const { element, opening, wholeLine, start, end } = target.range
  if (carriesBehaviour(opening)) return keepWrapper(sourceFile, file, verbatim, target.range)
  // A self-closing wrapper (`<div />`) holds nothing, so "hoist the children"
  // is an empty hoist: the container goes and nothing takes its place. That IS
  // ungrouping an empty group, and it is the one case where this write and a
  // delete produce the same file.
  const inner = Node.isJsxElement(element)
    ? verbatim.slice(opening.getEnd(), element.getClosingElement().getStart())
    : ''

  const text = wholeLine
    ? hoistedLines(verbatim, inner, element.getStart())
    : inner

  const edit = wholeLine
    ? { start, end, text }
    : { start: element.getStart(), end: element.getEnd(), text }
  writeVerbatimSource(sourceFile, file, applyTextEdits(verbatim, [edit]))
  // One edit, so nothing shifts its own start: the released children occupy
  // exactly `[edit.start, edit.start + text.length)` in the re-parsed file.
  return { ok: true, relocated: createdJsxLocationsIn(sourceFile, edit.start, edit.start + text.length) }
}

/**
 * The children's own lines, re-hung from the wrapper's indentation — the
 * replacement for the whole-line range the wrapper owned.
 *
 * The newline immediately after the opening tag and the indentation before the
 * closing one are the WRAPPER's whitespace, not the children's, so they go
 * with it. What is left is dedented by exactly the distance between the first
 * child's indentation and the wrapper's; a line that does not start with the
 * child indentation (a template literal's continuation, a hand-outdented line)
 * is left exactly as it is rather than guessed at — the same rule
 * `reindentBlock` follows, for the same reason.
 */
function hoistedLines(verbatim: string, inner: string, elementStart: number): string {
  const body = inner.replace(/^[ \t]*\r?\n/, '').replace(/\r?\n[ \t]*$/, '')
  if (body.trim() === '') return ''

  const baseIndent = lineIndentAt(verbatim, elementStart)
  const childIndent = /^[ \t]*/.exec(body)?.[0] ?? ''
  const lines = body.split('\n').map((line) =>
    childIndent.length > 0 && line.startsWith(childIndent) ? baseIndent + line.slice(childIndent.length) : line,
  )
  return `${lines.join('\n')}\n`
}

/** True when the wrapper is doing anything other than holding its children - see the module doc. */
function carriesBehaviour(opening: JsxOpeningLikeElement): boolean {
  if (!/^[a-z][a-z0-9-]*$/.test(opening.getTagNameNode().getText())) return true
  return opening.getAttributes().some((attribute) => {
    if (Node.isJsxSpreadAttribute(attribute)) return true
    const name = attribute.getNameNode().getText()
    return !INERT_ATTRIBUTES.has(name) && !name.startsWith('data-')
  })
}

/** `<div a="1">` -> `<div a="1" />`; a tag whose `>` sat on a line of its own keeps that line (`/>` there). */
function selfClosed(openingText: string): string {
  const match = /(\s*)>$/.exec(openingText)
  if (!match) return openingText
  return `${openingText.slice(0, match.index)}${match[1]!.includes('\n') ? match[1] : ' '}/>`
}

/**
 * The ungroup of a container that carries behaviour: its children go to the
 * container's parent, in order, and the container stays as an empty element
 * with every attribute exactly as written (see the module doc).
 */
function keepWrapper(sourceFile: SourceFile, file: string, verbatim: string, range: JsxChildRange): UnwrapJsxElementResult {
  const { element, opening, wholeLine, start, end } = range
  // Paired tags only have children to hand back; `<Card onClick />` is already a husk.
  if (!Node.isJsxElement(element)) return { ok: true, relocated: [], keptWrapper: true }
  const husk = selfClosed(opening.getText())
  const inner = verbatim.slice(opening.getEnd(), element.getClosingElement().getStart())
  // Measured before the write: it refreshes the parsed file and forgets these nodes.
  const elementStart = element.getStart()
  const elementEnd = element.getEnd()
  if (inner.trim() === '') {
    // Nothing inside: the paired tag becomes the self-closed one and that is all.
    writeVerbatimSource(sourceFile, file, applyTextEdits(verbatim, [{ start: elementStart, end: elementEnd, text: husk }]))
    return { ok: true, relocated: [], keptWrapper: true }
  }

  if (wholeLine) {
    const lead = verbatim.slice(start, elementStart)
    const hoisted = hoistedLines(verbatim, inner, element.getStart())
    const text = `${lead}${husk}\n${hoisted}`
    writeVerbatimSource(sourceFile, file, applyTextEdits(verbatim, [{ start, end, text }]))
    const from = start + lead.length + husk.length + 1
    return { ok: true, relocated: createdJsxLocationsIn(sourceFile, from, from + hoisted.length), keptWrapper: true }
  }
  const text = `${husk}${inner}`
  writeVerbatimSource(sourceFile, file, applyTextEdits(verbatim, [{ start: elementStart, end: elementEnd, text }]))
  const from = elementStart + husk.length
  return { ok: true, relocated: createdJsxLocationsIn(sourceFile, from, from + inner.length), keptWrapper: true }
}
