/**
 * jsxChildPlacement — WHERE a child's bytes go inside a JSX parent, and with
 * what surrounding whitespace.
 *
 * Split out of `insertJsxElement.ts` (W4-1) because placement was never that
 * codemod's alone. Writing a NEW element into a container and moving an
 * EXISTING one into a different container ask the identical question — "this
 * parent, beside this child, on this side: which bytes change, and what
 * indentation does the newcomer get?" — and differ only in what gets rendered
 * into the hole. `moveJsxElement`'s cross-parent form renders the subtree's own
 * source text; `insertJsxElement` renders a subtree it was handed. Both call
 * the function below, so a reparent lands with exactly the whitespace an insert
 * would have produced at the same spot.
 *
 * FOUR SHAPES, and the difference between them is entirely about whitespace the
 * user already wrote:
 *
 *  - **Against a whole-line anchor** — the newcomer gets its own line, at the
 *    anchor's own indentation.
 *  - **Against an inline anchor** (`<div><a/><b/></div>`) — it joins the line,
 *    separated by a single space.
 *  - **Appended to a parent that has children** — same two cases, resolved from
 *    the last child.
 *  - **Appended to an EMPTY parent** — the only case that rewrites existing
 *    bytes, and only ever whitespace: the run between `>` and `</` is replaced
 *    with a properly indented line. A self-closing parent (`<div />`) is
 *    reopened into a paired tag, which is the same idea one step further.
 *
 * Indentation is COPIED from the file (`indentUnit`, `lineIndentAt`) rather
 * than assumed, so a file written with tabs or four spaces keeps its own style
 * and no unrelated line is reformatted.
 */
import { Node, type JsxElement, type JsxSelfClosingElement, type SourceFile } from 'ts-morph'
import { resolveJsxChildRange, type TextEdit } from './jsxChildRange'
import { refuse, type InsertJsxRefusal } from './jsxSubtree'
import type { JsxOpeningLikeElement } from './locateJsxElement'

/**
 * Renders the newcomer at a known base indentation. `indent` is the whitespace
 * the FIRST line will sit at (the caller writes that prefix itself, so the
 * returned string's first line is bare); `unit` is one indentation step, copied
 * from the file.
 */
export type RenderJsx = (indent: string, unit: string) => string

export interface ChildPlacementRequest {
  /** 1-based line/col of an existing child to write beside. `null`/absent appends as the last child. */
  anchor?: { line: number; col: number } | null
  /** Which side of the anchor the newcomer lands on. Ignored without an anchor. */
  position?: 'before' | 'after'
  /**
   * A byte range this placement must pretend is not there — the subtree being
   * MOVED. Without it, a reparent into an ancestor could resolve its own moved
   * element as the "last child" of the destination and write the copy beside
   * the hole it is about to cut.
   */
  exclude?: { start: number; end: number } | null
}

export type ChildPlacementResult = { ok: true; edit: TextEdit } | { ok: false; refusal: InsertJsxRefusal }

/** The single edit that puts a rendered child inside `parentOpening`'s element. */
export function resolveChildPlacement(
  sourceFile: SourceFile,
  text: string,
  parentOpening: JsxOpeningLikeElement,
  request: ChildPlacementRequest,
  render: RenderJsx,
): ChildPlacementResult {
  const parentIndent = lineIndentAt(text, parentOpening.getStart())
  const unit = indentUnit(text)

  if (Node.isJsxSelfClosingElement(parentOpening)) {
    // `<Foo />` has no children region at all. Reopening it into `<Foo>…</Foo>`
    // rewrites only the `/>` the user wrote, and is the only honest way to give
    // a leaf element a first child.
    const tagName = parentOpening.getTagNameNode().getText()
    const end = parentOpening.getEnd()
    const selfCloseStart = text.lastIndexOf('/>', end)
    if (selfCloseStart < parentOpening.getStart()) {
      return refuse('not-a-container', 'Studio could not read where this element closes, so it cannot add a child to it.')
    }
    // Drop the whitespace the user had before `/>` — `<Foo />` closes as `<Foo>`.
    const beforeSlash = trimTrailingBlankBack(text, selfCloseStart)
    const childIndent = parentIndent + unit
    return {
      ok: true,
      edit: {
        start: beforeSlash,
        end,
        text: `>\n${childIndent}${render(childIndent, unit)}\n${parentIndent}</${tagName}>`,
      },
    }
  }

  const parentElement = parentOpening.getParent()
  if (!parentElement || !Node.isJsxElement(parentElement)) {
    return refuse('not-a-container', 'Studio could not resolve this element to something that can hold children.')
  }

  const anchorEdit = resolveAnchorPlacement(sourceFile, text, parentElement, request, render, unit)
  if (anchorEdit) return anchorEdit

  const children = elementChildren(parentElement).filter((child) => !isWithin(child, request.exclude))
  const last = children[children.length - 1]
  if (last) {
    const range = resolveJsxChildRange(sourceFile, ...tagLocation(sourceFile, last))
    if (range.ok) return { ok: true, edit: insertBeside(range.range, 'after', render, unit, text) }
  }

  // Empty parent: replace the whitespace-only run between the tags.
  const innerStart = parentOpening.getEnd()
  const innerEnd = parentElement.getClosingElement().getStart()
  const childIndent = parentIndent + unit
  const inner = text.slice(innerStart, innerEnd)
  const jsx = render(childIndent, unit)
  if (inner.trim() !== '') {
    // Children exist but none of them resolved to a plain element (an
    // expression child, a bare text node, or the very subtree being moved out
    // of here). Append after them without touching what is already there.
    return { ok: true, edit: { start: innerEnd, end: innerEnd, text: `\n${childIndent}${jsx}\n${parentIndent}` } }
  }
  return {
    ok: true,
    edit: { start: innerStart, end: innerEnd, text: `\n${childIndent}${jsx}\n${parentIndent}` },
  }
}

/** Placement against an explicit child anchor, or `null` when the caller gave none. */
function resolveAnchorPlacement(
  sourceFile: SourceFile,
  text: string,
  parentElement: JsxElement,
  request: ChildPlacementRequest,
  render: RenderJsx,
  unit: string,
): ChildPlacementResult | null {
  const { anchor } = request
  if (!anchor) return null

  const resolved = resolveJsxChildRange(sourceFile, anchor.line, anchor.col)
  if (!resolved.ok) return refuse(resolved.reason, resolved.message)
  if (resolved.range.parent !== parentElement) {
    return refuse(
      'not-siblings',
      'The element this would be written next to is not a child of the container it was dropped into, so there is no single place in the file to write it.',
    )
  }
  if (isWithin(resolved.range.element, request.exclude)) {
    // The anchor is inside the subtree being moved — it is about to stop
    // existing, so it cannot be what the new position is written against.
    return refuse(
      'not-siblings',
      'The element this would be written next to is part of the element being moved, so there is no fixed position in the file to write it against.',
    )
  }
  return {
    ok: true,
    edit: insertBeside(resolved.range, request.position ?? 'after', render, unit, text),
  }
}

/** The zero-length edit that puts the rendered child immediately before or after an existing child's owned range. */
function insertBeside(
  range: { start: number; end: number; wholeLine: boolean },
  position: 'before' | 'after',
  render: RenderJsx,
  unit: string,
  text: string,
): TextEdit {
  if (range.wholeLine) {
    // `start` is the line start and `end` is one past the newline, so a whole
    // line (indentation + element + newline) inserted at either point lands
    // exactly where a hand-written sibling would.
    const indent = lineIndentAt(text, range.start + countLeadingWhitespace(text, range.start))
    const at = position === 'before' ? range.start : range.end
    return { start: at, end: at, text: `${indent}${render(indent, unit)}\n` }
  }
  // Inline sibling (`<div><a/><b/></div>`). A multi-line subtree would break
  // the line the user chose to keep on one line, so it is rendered with no
  // base indent and simply joins the row.
  const at = position === 'before' ? range.start : range.end
  const jsx = render('', unit)
  return { start: at, end: at, text: position === 'before' ? `${jsx} ` : ` ${jsx}` }
}

/** True when `node` lies entirely inside `range` — the moved subtree's own bytes. */
function isWithin(node: Node, range: { start: number; end: number } | null | undefined): boolean {
  if (!range) return false
  return node.getStart() >= range.start && node.getEnd() <= range.end
}

/** The element children of a JSX element, in source order — whitespace and expression children excluded. */
export function elementChildren(element: JsxElement): (JsxElement | JsxSelfClosingElement)[] {
  const children: (JsxElement | JsxSelfClosingElement)[] = []
  for (const child of element.getJsxChildren()) {
    if (Node.isJsxElement(child) || Node.isJsxSelfClosingElement(child)) children.push(child)
  }
  return children
}

/** The 1-based `line, col` of a JSX element's tag name — the coordinate `resolveJsxChildRange` speaks. */
export function tagLocation(sourceFile: SourceFile, element: JsxElement | JsxSelfClosingElement): [number, number] {
  const opening = Node.isJsxElement(element) ? element.getOpeningElement() : element
  const { line, column } = sourceFile.getLineAndColumnAtPos(opening.getTagNameNode().getStart())
  return [line, column]
}

/** The leading whitespace of the line `pos` sits on. */
export function lineIndentAt(text: string, pos: number): string {
  const lineStart = text.lastIndexOf('\n', pos - 1) + 1
  return text.slice(lineStart, lineStart + countLeadingWhitespace(text, lineStart))
}

export function countLeadingWhitespace(text: string, from: number): number {
  let i = from
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i += 1
  return i - from
}

/**
 * One level of indentation, as this file writes it — a tab when the file is
 * tab-indented, otherwise the smallest non-zero space indent it uses (falling
 * back to two spaces). Copied rather than assumed so a write never mixes a
 * second indentation style into a file.
 */
export function indentUnit(text: string): string {
  let smallest = 0
  for (const line of text.split('\n')) {
    const width = countLeadingWhitespace(line, 0)
    if (width === 0 || line.trim() === '') continue
    if (line[0] === '\t') return '\t'
    if (smallest === 0 || width < smallest) smallest = width
  }
  return ' '.repeat(smallest > 0 ? smallest : 2)
}

/** Walks back over spaces/tabs from `pos`, so `<Foo />` closes as `<Foo>` rather than `<Foo >`. */
export function trimTrailingBlankBack(text: string, pos: number): number {
  let i = pos
  while (i > 0 && (text[i - 1] === ' ' || text[i - 1] === '\t')) i -= 1
  return i
}

/**
 * Re-hang a block of source text from one indentation to another: every line
 * after the first loses `from` and gains `to`, and nothing else changes.
 *
 * This is the ONE place a structural codemod alters bytes it did not otherwise
 * touch, and it is deliberate. A subtree that moves into a different parent (or
 * gains a wrapper) sits at a different depth, and leaving its inner lines at
 * their old column produces code no one would have written by hand — the
 * change the user asked for IS the new nesting. Only leading whitespace is
 * rewritten: every non-whitespace byte of the subtree, comments included,
 * survives verbatim.
 *
 * A line that does not start with `from` (a template literal's continuation, a
 * line the user hand-outdented) is left exactly as it is rather than guessed
 * at — under-indenting one line is a cosmetic wrinkle, rewriting the inside of
 * a template literal is a bug.
 */
export function reindentBlock(block: string, from: string, to: string): string {
  if (from === to) return block
  const [first, ...rest] = block.split('\n')
  return [
    first ?? '',
    ...rest.map((line) => (from.length > 0 && line.startsWith(from) ? to + line.slice(from.length) : line)),
  ].join('\n')
}
