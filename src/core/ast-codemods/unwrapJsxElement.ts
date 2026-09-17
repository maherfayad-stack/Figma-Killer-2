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
 * THE REFUSAL IS THE POINT: `has-behaviour`
 * -----------------------------------------
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
 * Each of those refuses by name with one way forward: open it in code. That is
 * the whole of the `has-behaviour` reason (`sourceStructure.ts`), and it is
 * deliberately conservative — an unwrap that silently dropped an `onClick` is
 * a defect no undo in the editor can fully explain.
 *
 * WHAT THIS CANNOT SEE, and says so here rather than pretending otherwise: a
 * stylesheet rule that crosses the wrapper (`.list > .row`, `.card + .card`)
 * stops matching once the wrapper is gone. That is true of deleting any
 * element and is not something the AST can answer; the CSS lives in another
 * file and may not even be in the workspace.
 */
import { Node, type Project } from 'ts-morph'
import { createProject, loadSourceFile } from './locateJsxElement'
import {
  applyTextEdits,
  resolveJsxChildRange,
  verbatimSourceText,
  writeVerbatimSource,
  type JsxChildRangeReason,
} from './jsxChildRange'
import { lineIndentAt } from './jsxChildPlacement'
import type { JsxOpeningLikeElement } from './locateJsxElement'

export interface UnwrapJsxElementParams {
  file: string
  /** 1-based line/col of the wrapper being removed (its tag-name start). */
  line: number
  col: number
  /** Optional pre-existing project to reuse. */
  project?: Project
}

/**
 * Why a container could not be dissolved. `has-behaviour` is the one this
 * codemod adds to the structural vocabulary — see the module doc.
 */
export type UnwrapJsxRefusalReason = JsxChildRangeReason | 'has-behaviour'

export interface UnwrapJsxRefusal {
  reason: UnwrapJsxRefusalReason
  /** Human-readable, suitable for a toast. */
  message: string
}

type UnwrapJsxRefused = { ok: false; refusal: UnwrapJsxRefusal }

export type UnwrapJsxElementResult = { ok: true } | UnwrapJsxRefused

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

  const behaviour = refuseBehaviour(target.range.opening)
  if (behaviour) return behaviour

  const verbatim = verbatimSourceText(sourceFile, file)
  if (verbatim === null) {
    return refuseUnwrap(
      'stale-source',
      'This file changed on disk since the canvas last read it. Reload the project and try again.',
    )
  }

  const { element, opening, wholeLine, start, end } = target.range
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

  writeVerbatimSource(
    sourceFile,
    file,
    applyTextEdits(verbatim, [
      wholeLine
        ? { start, end, text }
        : { start: element.getStart(), end: element.getEnd(), text },
    ]),
  )
  return { ok: true }
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

/** Refuses a wrapper that is doing anything other than holding its children. */
function refuseBehaviour(opening: JsxOpeningLikeElement): UnwrapJsxRefused | null {
  const tag = opening.getTagNameNode().getText()
  if (!/^[a-z][a-z0-9-]*$/.test(tag)) {
    return refuseUnwrap(
      'has-behaviour',
      `<${tag}> is a component, not a plain container — its own file decides what it renders, so removing it here would delete a component usage rather than ungroup anything. Open it in code to change that.`,
    )
  }

  for (const attribute of opening.getAttributes()) {
    if (Node.isJsxSpreadAttribute(attribute)) {
      return refuseUnwrap(
        'has-behaviour',
        'This container spreads props Studio cannot see, so removing it could drop behaviour the code relies on. Open it in code to change that.',
      )
    }
    const name = attribute.getNameNode().getText()
    if (INERT_ATTRIBUTES.has(name) || name.startsWith('data-')) continue
    return refuseUnwrap(
      'has-behaviour',
      `This container carries \`${name}\`, so it is doing more than holding its children — removing it would drop that. Open it in code to change that.`,
    )
  }
  return null
}
