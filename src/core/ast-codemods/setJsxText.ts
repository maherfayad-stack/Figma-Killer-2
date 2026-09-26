/**
 * Replaces a JSX element's TEXT CHILDREN with a new string, then writes the
 * change back to disk.
 *
 * FAILS CLOSED on any element/expression children other than plain text
 * (nested elements, icon+label mixes, non-literal expressions) — this codemod
 * only ever rewrites a "leaf text" node, never a structural subtree, so it
 * never silently destroys JSX it can't safely reason about.
 *
 * ## Spelling (WB-9)
 *
 * The text is written the way the file already writes it, so an edit touches
 * the words and nothing else:
 *
 *   - **Raw JSX text stays raw** — `<p>Hello</p>` becomes `<p>Bye</p>` —
 *     whenever raw text reads back as exactly the value: no `{ } < >`, no
 *     `&name;` the compiler would decode as an entity, no leading or trailing
 *     whitespace (the element's own layout owns that). The whitespace around
 *     the text is kept byte-for-byte; only the trimmed span is replaced.
 *   - **A multi-line text keeps its lines.** A value with no line break,
 *     written into text that spanned several source lines, is re-wrapped at its
 *     spaces across the same number of lines with the same indentation. React
 *     joins JSX text lines with one space, so it renders exactly the value —
 *     and no node id below the element moves, which is what used to force a
 *     re-read of the page after a copy edit.
 *   - **A `{"…"}` container stays a container**, in its own quote. A value raw
 *     text cannot say becomes one, in the file's own quote
 *     (`stringSpelling.ts`'s `preferredQuote`).
 *
 * See `locateJsxElement.ts` for the (line, col) → node resolution algorithm.
 */
import { Node, Project, SyntaxKind, type JsxElement, type JsxText, type SourceFile } from 'ts-morph'
import { createProject, findJsxElementAtLocationOrThrow, loadSourceFile } from './locateJsxElement'
import { JSX_ENTITY_RE, jsStringSpelling, preferredQuote, quoteOf } from './stringSpelling'

export interface SetJsxTextParams {
  file: string
  line: number
  col: number
  text: string
  /** Optional pre-existing project to reuse (e.g. across multiple edits). */
  project?: Project
}

/**
 * Thrown when `setJsxText`'s target element can't be safely rewritten as a
 * plain-text leaf — either it already holds non-text children (element /
 * fragment / non-literal expression), or holds more than one child at all
 * (mixed content). `path` is `<file>:<line>:<col>` of the target element.
 */
export class JsxTextTargetError extends Error {
  /** The stable refusal code the writeback batch reports (WB-12). */
  readonly reason = 'mixed-children'
  readonly path: string

  constructor(message: string, path: string) {
    super(`[ast-codemods/setJsxText] ${path}: ${message}`)
    this.name = 'JsxTextTargetError'
    this.path = path
  }
}

/** True for a `{"..."}` / `{'...'}` expression container — a literal string. */
function isStringLiteralExpressionContainer(child: ReturnType<JsxElement['getJsxChildren']>[number]): boolean {
  if (!Node.isJsxExpression(child)) return false
  const expression = child.getExpression()
  return expression !== undefined && Node.isStringLiteral(expression)
}

/**
 * Throws unless `jsxElement`'s children are safely text-only: empty, a
 * single `JsxText`, or a single string-literal expression container. Any
 * other shape (an element/fragment child, more than one child, a non-literal
 * expression) is "structural" content this codemod must not clobber.
 */
function assertTextOnlyChildren(jsxElement: JsxElement, path: string): void {
  const children = jsxElement.getJsxChildren()
  if (children.length === 0) return
  if (children.length === 1) {
    const only = children[0]!
    if (Node.isJsxText(only) || isStringLiteralExpressionContainer(only)) return
  }
  throw new JsxTextTargetError(
    'element has non-text children (nested elements or mixed content) — refusing to overwrite structural JSX',
    path,
  )
}

/** True when `text`, written as raw JSX text, reads back (`decodeJsxTextEntities(getText().trim())`) as exactly `text`. */
function isRawJsxTextSafe(text: string): boolean {
  return text.length > 0 && text === text.trim() && !/[{}<>\r]/.test(text) && !JSX_ENTITY_RE.test(text)
}

/** The value as a `{"…"}` expression container — for text raw JSX cannot say. */
function containerSpelling(text: string, sourceFile: SourceFile): string {
  return `{${jsStringSpelling(text, preferredQuote(sourceFile))}}`
}

/**
 * `text` laid out over the same source lines `original` used — each line
 * after the first starting with that line's own indentation — or `null` when
 * it cannot be: fewer words than lines, or a run of whitespace a line break
 * would collapse. Each break goes at the space nearest to where the original
 * line broke, proportionally, so a small edit leaves the wrap looking as it
 * did.
 */
function rewrapAcrossLines(text: string, original: string): string | null {
  const lines = original.split('\n')
  if (lines.length === 1) return text
  if (/\s{2,}|\t/.test(text)) return null
  const words = text.split(' ')
  if (words.length < lines.length) return null
  const indents = lines.map((line) => /^[ \t]*/.exec(line)![0])
  const lengths = lines.map((line) => line.trim().length)
  const originalTotal = lengths.reduce((sum, length) => sum + length, 0) || 1

  const out: string[] = []
  let next = 0
  let consumed = 0
  let cumulative = 0
  for (let index = 0; index < lines.length - 1; index++) {
    cumulative += lengths[index]!
    const target = (text.length * cumulative) / originalTotal
    const line: string[] = [words[next]!]
    consumed += words[next]!.length + 1
    next += 1
    // Keep taking words while the break still lands nearer the target, and
    // while enough words are left for every remaining line.
    while (next < words.length - (lines.length - 1 - index) && consumed + words[next]!.length / 2 <= target) {
      line.push(words[next]!)
      consumed += words[next]!.length + 1
      next += 1
    }
    out.push(line.join(' '))
  }
  out.push(words.slice(next).join(' '))
  return out.map((line, index) => (index === 0 ? line : indents[index] + line)).join('\n')
}

/**
 * A single `JsxText` child rewritten: its surrounding whitespace kept, its
 * trimmed span replaced. See this module's doc.
 */
function rewriteJsxText(child: JsxText, text: string, sourceFile: SourceFile): void {
  const source = child.getText()
  const leading = /^\s*/.exec(source)![0]
  const trailing = /\s*$/.exec(source.slice(leading.length))![0]
  const core = source.slice(leading.length, source.length - trailing.length)
  const start = child.getStart() + leading.length

  let spelled: string
  if (!isRawJsxTextSafe(text)) spelled = containerSpelling(text, sourceFile)
  // A line break the original single-line text did not have would change what
  // `white-space: pre-line` shows; a container says it exactly.
  else if (text.includes('\n')) spelled = core.includes('\n') ? text : containerSpelling(text, sourceFile)
  // No break of its own: re-wrapped over the original lines when there were
  // several, so no line below the element moves.
  else spelled = rewrapAcrossLines(text, core) ?? text
  sourceFile.replaceText([start, start + core.length], spelled)
}

export function setJsxText(params: SetJsxTextParams): void {
  const { file, line, col, text } = params
  const project = params.project ?? createProject()
  const sourceFile = loadSourceFile(project, file)
  const opening = findJsxElementAtLocationOrThrow(sourceFile, file, line, col)
  const path = `${file}:${line}:${col}`
  // Text going where there was none: raw when raw says it on one line.
  const spelledFresh = isRawJsxTextSafe(text) && !text.includes('\n') ? text : containerSpelling(text, sourceFile)

  if (Node.isJsxSelfClosingElement(opening)) {
    // Self-closing elements have no children slot — expand `<Foo ... />` into
    // `<Foo ...>text</Foo>`, preserving the attributes verbatim by stripping
    // only the trailing `/` before `>`. Nothing to say is nothing to expand.
    if (text.length === 0) return
    const tagName = opening.getTagNameNode().getText()
    const openingTagText = opening.getText().replace(/\s*\/\s*>$/, '>')
    opening.replaceWithText(`${openingTagText}${spelledFresh}</${tagName}>`)
    sourceFile.saveSync()
    return
  }

  const jsxElement = opening.getParentIfKindOrThrow(SyntaxKind.JsxElement)
  assertTextOnlyChildren(jsxElement, path)
  const openingEnd = jsxElement.getOpeningElement().getEnd()
  const closingStart = jsxElement.getClosingElement().getStart()
  const only = jsxElement.getJsxChildren()[0]

  if (text.length === 0) {
    // Nothing to say: the children go, and so does the layout that held them.
    sourceFile.replaceText([openingEnd, closingStart], '')
  } else if (only === undefined || (Node.isJsxText(only) && only.getText().trim().length === 0)) {
    sourceFile.replaceText([openingEnd, closingStart], spelledFresh)
  } else if (Node.isJsxText(only)) {
    rewriteJsxText(only, text, sourceFile)
  } else {
    // `{"…"}` / `{'…'}` — the author chose a container; keep it, in its quote.
    // (`assertTextOnlyChildren` admits no other expression.)
    const literal = only.getFirstChildByKindOrThrow(SyntaxKind.StringLiteral)
    sourceFile.replaceText([literal.getStart(), literal.getEnd()], jsStringSpelling(text, quoteOf(literal)))
  }

  sourceFile.saveSync()
}
