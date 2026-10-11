/**
 * transplantPropBake - G-1c, the pure half of "a move carries the values the
 * element reads from its component's props and from the `.map` row it sits in".
 *
 * A name like that is not a declaration the destination can import or copy: it
 * is a value somebody else hands the component. The move gives the destination
 * a `const name = <literal>` holding the value the board showed, and the
 * element's own markup stays byte-for-byte as it was. Two sources, both READ OFF
 * THE SOURCE TEXT - never evaluated, never taken from the browser:
 *
 *  - **A row of a list.** The element sits in `ROWS.map((item, i) => ...)`, and
 *    the parser stamped the row with the array literal it iterates (`ListRowSource`
 *    -> `RowRef`). Element `index` of that literal IS the item, so
 *    `const item = <that element's text>` and `const i = <index>` reproduce what
 *    the row read. The row is copied, never moved: the template and the array
 *    stay exactly as they are. The server re-derives which array the `.map`
 *    iterates from the AST and refuses when it is not the array the board named.
 *  - **A prop's own default.** `function Card({ tone = 'warm' })` read on a page
 *    that is rendered with no props shows `'warm'`. That is only true where
 *    nothing hands the component a different value, so the caller turns it on
 *    for an element written in the page's own file and never for one inlined out
 *    of a component (`propDefaults`).
 *
 * Whatever the value's text reads (an imported icon, a module constant) is
 * carried like any other free name by `transplantBindings.ts`; a value that
 * reads something only the origin component owns refuses by name there.
 */
import { Node, SyntaxKind, VariableDeclarationKind, type ArrayLiteralExpression, type SourceFile } from 'ts-morph'
import type { FunctionLike } from '@core/page-parser'
import { applyTextEdits, type TextEdit } from './jsxChildRange'
import { lineIndentAt, reindentBlock } from './jsxChildPlacement'
import { bindingNames, freeVariableReferenceRanges } from './subtreeFreeVariables'
import { isMapCallback } from './transplantStateCarry'

/** The `.map` row the element is a copy of: the array literal's own `[` and the row's place in it. */
export interface RowRef {
  arrayLine: number
  arrayCol: number
  index: number
  /** How many elements the board saw in the literal - the identity checked before anything is read. */
  length: number
}

/** What a baked name is initialised with: an expression of the origin file, or text of our own (a row index). */
export type BakedSource = { kind: 'node'; node: Node } | { kind: 'text'; text: string }

export type RowBinding =
  | { ok: true; sources: Map<string, BakedSource> }
  | { ok: false; message: string }

function unwrapValue(expr: Node): Node {
  let current = expr
  while (
    Node.isParenthesizedExpression(current) ||
    Node.isAsExpression(current) ||
    Node.isSatisfiesExpression(current) ||
    Node.isNonNullExpression(current) ||
    Node.isTypeAssertion(current)
  ) {
    current = current.getExpression()
  }
  return current
}

function constArrayOf(declaration: Node | undefined): ArrayLiteralExpression | undefined {
  if (!declaration || !Node.isVariableDeclaration(declaration)) return undefined
  const list = declaration.getParent()
  if (!Node.isVariableDeclarationList(list) || list.getDeclarationKind() !== VariableDeclarationKind.Const) return undefined
  const init = declaration.getInitializer()
  const value = init ? unwrapValue(init) : undefined
  return value && Node.isArrayLiteralExpression(value) ? value : undefined
}

/** The array literal a `.map` receiver names: written inline, or a `const` of the component's body or of the module. */
function arrayLiteralOf(receiver: Node, component: FunctionLike | undefined, source: SourceFile): ArrayLiteralExpression | undefined {
  const expr = unwrapValue(receiver)
  if (Node.isArrayLiteralExpression(expr)) return expr
  if (!Node.isIdentifier(expr)) return undefined
  const name = expr.getText()
  const body = component?.getBody()
  if (body && Node.isBlock(body)) {
    for (const statement of body.getStatements()) {
      if (!Node.isVariableStatement(statement)) continue
      const declaration = statement.getDeclarations().find((candidate) => bindingNames(candidate.getNameNode()).has(name))
      if (declaration) return constArrayOf(declaration)
    }
  }
  return constArrayOf(source.getVariableDeclaration(name))
}

/**
 * The item and index names of the `.map` callback around `subtree`, each tied
 * to what it was for THIS row. A mismatch with what the board named - another
 * array, a different length, a spread - is a changed file, reported as such.
 */
export function resolveRowBindings(subtree: Node, component: FunctionLike | undefined, row: RowRef): RowBinding {
  const stale = (why: string): RowBinding => ({
    ok: false,
    message: `The list this row came from has changed since the canvas last read it (${why}). Reload the project and try again.`,
  })
  const callback = subtree.getAncestors().find((ancestor) => isMapCallback(ancestor))
  if (!callback || !(Node.isArrowFunction(callback) || Node.isFunctionExpression(callback))) return stale('the element is no longer inside a .map()')
  const call = callback.getParent()
  const callee = call && Node.isCallExpression(call) ? call.getExpression() : undefined
  if (!callee || !Node.isPropertyAccessExpression(callee)) return stale('the .map() call changed')

  const array = arrayLiteralOf(callee.getExpression(), component, subtree.getSourceFile())
  if (!array) return stale('it no longer maps over an array written in this file')
  const at = array.getSourceFile().getLineAndColumnAtPos(array.getStart())
  if (at.line !== row.arrayLine || at.column !== row.arrayCol) return stale('it maps over a different array')
  const elements = array.getElements()
  if (elements.length !== row.length || row.index >= elements.length) return stale('the array has a different number of items')
  const element = elements[row.index]!
  if (Node.isSpreadElement(element) || Node.isOmittedExpression(element)) return stale('the array spreads another list')

  const sources = new Map<string, BakedSource>()
  const [itemParameter, indexParameter] = callback.getParameters()
  const itemName = itemParameter?.getNameNode()
  if (itemName && Node.isIdentifier(itemName)) sources.set(itemName.getText(), { kind: 'node', node: element })
  const indexName = indexParameter?.getNameNode()
  if (indexName && Node.isIdentifier(indexName)) sources.set(indexName.getText(), { kind: 'text', text: String(row.index) })
  // A third parameter (the array itself) or a destructured item has no single
  // literal to bake: it stays out of `sources`, and reading it refuses by name.
  return { ok: true, sources }
}

/** The default a component's destructured parameter gives `name` (`{ tone = 'warm' }`), or `undefined`. */
export function propDefaultOf(component: FunctionLike, name: string): Node | undefined {
  const pattern = component.getParameters()[0]?.getNameNode()
  if (!pattern || !Node.isObjectBindingPattern(pattern)) return undefined
  const element = pattern.getElements().find((candidate) => !candidate.getDotDotDotToken() && candidate.getName() === name)
  return element?.getInitializer()
}

/**
 * `const as = <value>` as it is written at the destination: the source
 * expression's own bytes with `renames` applied to the names it reads, re-indented
 * to `toIndent`. The first line carries no indent - the caller places it at a
 * statement start that already has one.
 */
export function bakedStatementText(
  source: BakedSource,
  as: string,
  originText: string,
  renames: ReadonlyMap<string, string>,
  toIndent: string,
): string {
  if (source.kind === 'text') return `const ${as} = ${source.text}`
  const start = source.node.getStart()
  const edits: TextEdit[] = []
  for (const [name, replacement] of renames) {
    for (const range of freeVariableReferenceRanges(source.node, name)) {
      edits.push({ start: range.start - start, end: range.end - start, text: replacement })
    }
  }
  const value = applyTextEdits(originText.slice(start, source.node.getEnd()), edits)
  return `const ${as} = ${reindentBlock(value, lineIndentAt(originText, start), toIndent)}`
}

/** Whether a default is DATA: no function or class anywhere in it. A function prop is behaviour, and refuses by name. */
export function isDataValue(node: Node): boolean {
  const isCode = (candidate: Node): boolean => Node.isArrowFunction(candidate) || Node.isFunctionExpression(candidate) || Node.isClassExpression(candidate)
  return !isCode(node) && node.getDescendants().every((descendant) => !isCode(descendant)) && !node.getFirstDescendantByKind(SyntaxKind.FunctionExpression)
}
