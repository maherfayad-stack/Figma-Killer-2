/**
 * Replaces a JSX element's TEXT CHILDREN with a new string, then writes the
 * change back to disk.
 *
 * FAILS CLOSED on any element/expression children other than plain text
 * (nested elements, icon+label mixes, non-literal expressions) — this codemod
 * only ever rewrites a "leaf text" node, never a structural subtree, so it
 * never silently destroys JSX it can't safely reason about.
 *
 * See `locateJsxElement.ts` for the (line, col) → node resolution algorithm.
 */
import { Node, Project, SyntaxKind, type JsxElement } from 'ts-morph'
import { createProject, findJsxElementAtLocationOrThrow, loadSourceFile } from './locateJsxElement'

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

export function setJsxText(params: SetJsxTextParams): void {
  const { file, line, col, text } = params
  const project = params.project ?? createProject()
  const sourceFile = loadSourceFile(project, file)
  const opening = findJsxElementAtLocationOrThrow(sourceFile, file, line, col)
  const path = `${file}:${line}:${col}`

  // Written as a `{JSON.stringify(text)}` expression container rather than raw
  // JSX text: it reuses ordinary JS string escaping and sidesteps JSX-entity
  // escaping of `<`, `>`, `{`, `}`, `&` that raw JSX text would require.
  const textExpression = `{${JSON.stringify(text)}}`

  if (Node.isJsxSelfClosingElement(opening)) {
    // Self-closing elements have no children slot — expand `<Foo ... />` into
    // `<Foo ...>{"text"}</Foo>`, preserving the attributes verbatim by
    // stripping only the trailing `/` before `>`.
    const tagName = opening.getTagNameNode().getText()
    const openingTagText = opening.getText().replace(/\s*\/\s*>$/, '>')
    opening.replaceWithText(`${openingTagText}${textExpression}</${tagName}>`)
    sourceFile.saveSync()
    return
  }

  const jsxElement = opening.getParentIfKindOrThrow(SyntaxKind.JsxElement)
  assertTextOnlyChildren(jsxElement, path)

  // Preserve the opening/closing tag text VERBATIM (sliced from source) so
  // attributes and formatting aren't reflowed by the printer.
  const openingTagText = jsxElement.getOpeningElement().getText()
  const closingTagText = jsxElement.getClosingElement().getText()
  jsxElement.replaceWithText(`${openingTagText}${textExpression}${closingTagText}`)

  sourceFile.saveSync()
}
