/**
 * unrollMapExpression — G-9 / OD-24: "Unroll list". Rewrites
 * `{ROWS.map((row) => <li>{row.label}</li>)}` over an array LITERAL written in
 * the same file into the N elements it renders, one per array item, with the
 * item's plain values written where the callback read them:
 *
 *   {ROWS.map((row, i) => <li key={row.id}>{row.label}</li>)}
 *   →  <li>Alpha</li>
 *      <li>Beta</li>
 *
 * WHY IT EXISTS. One piece of JSX renders every row, so a wrap, a group, a
 * move into another container, or an edit to a node INSIDE a row has no place
 * in the source that is that row's alone (`list-row`). Writing the rows out as
 * real siblings gives each one its own source location; the store then replays
 * the gesture the user tried against the new elements. It is explicit, menu-only
 * and lossy by design: the list stops being data-driven. The array stays in the
 * file (it may feed other lists, and deleting the user's data is not ours to
 * decide); ⌘Z is the undo journal's `restore`.
 *
 * WHAT IT WILL UNROLL — exactly what it can prove, nothing guessed:
 *  - the `.map` is written directly as a JSX child (`{…}` inside an element or
 *    fragment), with ONE inline arrow/function-expression callback whose
 *    parameters are plain identifiers and whose body is the JSX it returns
 *    (concise, or a block holding nothing but `return <jsx>`);
 *  - the receiver is an array literal, or a `const` array literal in this
 *    file's scope chain (never imported, never a prop, never computed);
 *  - every item is plain DATA: strings, numbers, booleans, `null`, and objects
 *    and arrays of those. An item that calls, spreads, or reads another
 *    binding would change meaning when copied into the callback's scope;
 *  - the item and index parameters are only READ, and no inner scope redeclares
 *    their names.
 *
 * HOW A REFERENCE IS WRITTEN. `row.label` where the item holds the string
 * `'Alpha'` becomes the text `Alpha` as a JSX child, `"Alpha"` as an attribute,
 * and `'Alpha'` anywhere else; a number reads as its digits; the index reads as
 * the row's position. A reference that stops short of a primitive (`pick(row)`,
 * `{...row}`) is replaced by the item's own source text. The row's `key`
 * attribute is dropped: static siblings need none, and its only job was
 * telling the rows apart.
 *
 * THE BYTES. The AST only locates; the write is a splice of the file's own
 * bytes (`jsxChildRange.ts`), and it refuses when the text on disk is not the
 * text that was parsed. Every refusal leaves the file byte-identical.
 */
import {
  Node,
  SyntaxKind,
  type ArrayLiteralExpression,
  type ArrowFunction,
  type CallExpression,
  type FunctionExpression,
  type ParameterDeclaration,
  type Project,
} from 'ts-morph'
import { createdJsxLocationsIn, type CreatedJsxLocation } from './createdJsxLocation'
import { applyTextEdits, ownedTextRange, verbatimSourceText, writeVerbatimSource, type TextEdit } from './jsxChildRange'
import { createProject, findJsxElementAtLocation, loadSourceFile } from './locateJsxElement'
import { introducesSyntaxErrors } from './syntaxRegression'
import { ELEMENT_GONE_MESSAGE, STALE_SOURCE_MESSAGE, SYNTAX_REGRESSION_MESSAGE } from '@core/utils/refusalCopy'

/** A list this long is data, not a layout: it is not written out by hand. */
export const MAX_UNROLL_ITEMS = 100

export interface UnrollMapExpressionParams {
  file: string
  /** 1-based tag-name position of the ROW ROOT the callback returns (the id of any row's root, without its `#n`). */
  line: number
  col: number
  /** 1-based position of the array literal's `[` the board read — the identity this edit checks. */
  array: { line: number; col: number }
  /** How many items the literal had when the board read it. */
  length: number
  project?: Project
}

export type UnrollRefusalReason =
  | 'not-found'
  | 'stale-source'
  | 'not-a-list'
  | 'not-a-child'
  | 'list-changed'
  | 'not-literal'
  | 'unsupported-callback'
  | 'unsupported-params'
  | 'shadowed-param'
  | 'param-assigned'
  | 'too-long'
  | 'multi-line-value'
  | 'invalid-source'

export interface UnrollRefusal {
  reason: UnrollRefusalReason
  message: string
}

export type UnrollMapExpressionResult =
  | {
      ok: true
      /** The tag-name position of each written row, in order — verified against the re-parsed file. Empty if they could not be confirmed. */
      created: CreatedJsxLocation[]
    }
  | { ok: false; refusal: UnrollRefusal }

function refuse(reason: UnrollRefusalReason, message: string): { ok: false; refusal: UnrollRefusal } {
  return { ok: false, refusal: { reason, message } }
}

/** A value read out of an array item: the only things a reference may be replaced with. */
type DataValue =
  | { kind: 'string'; value: string; text: string }
  | { kind: 'number'; text: string }
  | { kind: 'boolean' | 'null' | 'undefined'; text: string }
  | { kind: 'object'; props: Map<string, DataValue>; text: string }
  | { kind: 'array'; items: DataValue[]; text: string }

export function unrollMapExpression(params: UnrollMapExpressionParams): UnrollMapExpressionResult {
  const { file, line, col } = params
  const project = params.project ?? createProject()
  const sourceFile = loadSourceFile(project, file)
  const verbatim = verbatimSourceText(sourceFile, file)
  if (verbatim === null) {
    return refuse('stale-source', STALE_SOURCE_MESSAGE)
  }

  const opening = findJsxElementAtLocation(sourceFile, line, col)
  if (!opening) {
    return refuse('not-found', ELEMENT_GONE_MESSAGE)
  }
  const root = Node.isJsxSelfClosingElement(opening) ? opening : opening.getParentOrThrow()

  // The row root is the thing the callback returns.
  const callback = callbackReturning(root)
  if (!callback) {
    return refuse('not-a-list', 'This element is not the whole row a .map() callback returns, so there is no list to write out. Select the whole row.')
  }
  const call = callback.getParent()
  if (!call || !Node.isCallExpression(call) || call.getArguments().length !== 1 || call.getArguments()[0] !== callback) {
    return refuse('not-a-list', 'This row is not drawn by a plain .map() with one callback. Rewrite it that way in the code.')
  }
  const callee = call.getExpression()
  if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== 'map') {
    return refuse('not-a-list', 'This row is not drawn by a .map() call. Select a row of a list.')
  }

  const container = jsxChildContainer(call)
  if (!container) {
    return refuse(
      'not-a-child',
      'This list sits inside a condition or another expression, so there is no place in the markup to write its rows. Move the list into the markup in the code.',
    )
  }
  const innerStart = container.expression.getStart()
  const innerEnd = container.expression.getEnd()
  const containerStart = container.node.getStart()
  const containerEnd = container.node.getEnd()
  if (verbatim.slice(containerStart + 1, innerStart).trim() !== '' || verbatim.slice(innerEnd, containerEnd - 1).trim() !== '') {
    return refuse('unsupported-callback', 'A comment sits inside the braces of this list, and writing the rows out would drop it. Move the comment out in the code.')
  }

  const array = receiverArray(callee.getExpression())
  if (!array.ok) return array
  const arrayNode = array.node
  const position = sourceFile.getLineAndColumnAtPos(arrayNode.getStart())
  const elements = arrayNode.getElements()
  if (position.line !== params.array.line || position.column !== params.array.col || elements.length !== params.length) {
    return refuse(
      'list-changed',
      "This list's array has a different number of items than the board read. Reload the project and try again.",
    )
  }
  if (elements.length > MAX_UNROLL_ITEMS) {
    return refuse('too-long', `This list has ${elements.length} items, and Studio writes out at most ${MAX_UNROLL_ITEMS}. Keep a list that long as data.`)
  }
  const items: DataValue[] = []
  for (const [index, element] of elements.entries()) {
    const value = readData(element)
    if (!value) {
      return refuse(
        'not-literal',
        `Item ${index + 1} of this list is not a plain value (it calls something, spreads or reads a variable). Replace it with a plain value in the code.`,
      )
    }
    items.push(value)
  }

  const names = parameterNames(callback)
  if (!names.ok) return names
  const body = callback.getBody()
  for (const name of [names.item, names.index]) {
    if (name === null) continue
    if (declaresName(body, name)) {
      return refuse('shadowed-param', `Something inside this row declares its own "${name}", which would be confused with the list item. Rename it in the code.`)
    }
  }

  const references = collectReferences(root, names)
  if (!references.ok) return references

  // The row's React key goes: static siblings need none.
  const keyRemoval = rootKeyRemoval(opening)

  const rootStart = root.getStart()
  const rootText = verbatim.slice(rootStart, root.getEnd())
  const rows: string[] = []
  for (const [index, item] of items.entries()) {
    const edits: TextEdit[] = []
    if (keyRemoval) edits.push({ start: keyRemoval.start - rootStart, end: keyRemoval.end - rootStart, text: '' })
    for (const reference of references.found) {
      if (keyRemoval && reference.node.getStart() >= keyRemoval.start && reference.node.getEnd() <= keyRemoval.end) continue
      const edit = referenceEdit(reference, reference.kind === 'item' ? item : { kind: 'number', text: String(index) })
      if (!edit.ok) return edit
      edits.push({ start: edit.start - rootStart, end: edit.end - rootStart, text: edit.text })
    }
    rows.push(applyTextEdits(rootText, edits))
  }

  // Where the rows go: one per line when the list owned its line(s), end to end otherwise.
  const lineStart = verbatim.lastIndexOf('\n', containerStart - 1) + 1
  const containerIndent = /^[ \t]*/.exec(verbatim.slice(lineStart))![0]
  const rootLineStart = verbatim.lastIndexOf('\n', rootStart - 1) + 1
  const rootIndent = /^[ \t]*/.exec(verbatim.slice(rootLineStart))![0]
  const reindented = rows.map((row) => (rootIndent === containerIndent || spansLinesInText(root) ? row : reindent(row, rootIndent, containerIndent)))
  const owned = ownedTextRange(verbatim, containerStart, containerEnd)
  const replacement = owned.wholeLine ? reindented.map((row) => `${containerIndent}${row}\n`).join('') : reindented.join('')

  const candidate = applyTextEdits(verbatim, [{ start: owned.start, end: owned.end, text: replacement }])
  if (introducesSyntaxErrors(file, verbatim, candidate)) {
    return refuse('invalid-source', SYNTAX_REGRESSION_MESSAGE)
  }
  writeVerbatimSource(sourceFile, file, candidate)

  const created = createdJsxLocationsIn(sourceFile, owned.start, owned.start + replacement.length)
  return { ok: true, created: created.length === items.length ? created : [] }
}

/** The function whose returned JSX is `root` — concise body, or the lone `return` of a block. */
function callbackReturning(root: Node): ArrowFunction | FunctionExpression | null {
  let cursor: Node = root
  for (let parent = cursor.getParent(); parent && Node.isParenthesizedExpression(parent); parent = cursor.getParent()) cursor = parent
  let owner = cursor.getParent()
  if (owner && Node.isReturnStatement(owner)) {
    const block = owner.getParent()
    if (!block || !Node.isBlock(block) || block.getStatements().length !== 1) return null
    owner = block.getParent()
  }
  if (!owner || !(Node.isArrowFunction(owner) || Node.isFunctionExpression(owner))) return null
  return owner
}

/** The `{…}` a call is the whole content of, when that container is a child of a JSX element or fragment. */
function jsxChildContainer(call: CallExpression): { node: Node; expression: Node } | null {
  let expression: Node = call
  for (let parent = expression.getParent(); parent && Node.isParenthesizedExpression(parent); parent = expression.getParent()) expression = parent
  const container = expression.getParent()
  if (!container || !Node.isJsxExpression(container) || container.getDotDotDotToken()) return null
  const owner = container.getParent()
  return owner && (Node.isJsxElement(owner) || Node.isJsxFragment(owner)) ? { node: container, expression } : null
}

function unwrap(node: Node): Node {
  let current = node
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

/** The array literal the `.map` iterates: written inline, or a `const` of this file's scope chain. */
function receiverArray(receiver: Node): { ok: true; node: ArrayLiteralExpression } | ReturnType<typeof refuse> {
  const expr = unwrap(receiver)
  if (Node.isArrayLiteralExpression(expr)) return { ok: true, node: expr }
  if (!Node.isIdentifier(expr)) {
    return refuse('not-literal', 'This list is computed by the code rather than written out as an array in this file. Write the array out in the code.')
  }
  const name = expr.getText()
  for (let scope: Node | undefined = expr.getParent(); scope; scope = scope.getParent()) {
    if (Node.isFunctionLikeDeclaration(scope) || Node.isArrowFunction(scope) || Node.isFunctionExpression(scope)) {
      if (scope.getParameters().some((parameter) => bindingNames(parameter.getNameNode()).includes(name))) {
        return refuse('not-literal', `${name} is handed to this component from outside, so its items are not written in this file. Write the array in this file.`)
      }
    }
    const statements = Node.isSourceFile(scope) || Node.isBlock(scope) ? scope.getStatements() : null
    if (!statements) continue
    for (const statement of statements) {
      if (!Node.isVariableStatement(statement)) continue
      for (const declaration of statement.getDeclarations()) {
        if (!bindingNames(declaration.getNameNode()).includes(name)) continue
        const init = declaration.getInitializer()
        const value = init ? unwrap(init) : undefined
        if (statement.getDeclarationKind() !== 'const' || !value || !Node.isArrayLiteralExpression(value)) {
          return refuse('not-literal', `${name} is not a plain array written out in this file (it is reassignable or computed). Make it a plain const array.`)
        }
        return { ok: true, node: value }
      }
    }
  }
  return refuse('not-literal', `${name} is imported or declared outside this file, so its items are not written here. Move the array into this file.`)
}

function bindingNames(name: Node): string[] {
  if (Node.isIdentifier(name)) return [name.getText()]
  return name.getDescendantsOfKind(SyntaxKind.BindingElement).flatMap((element) => bindingNames(element.getNameNode()))
}

/** An item/array value that is plain data, or `null`. */
function readData(node: Node): DataValue | null {
  const expr = unwrap(node)
  if (Node.isStringLiteral(expr) || Node.isNoSubstitutionTemplateLiteral(expr)) {
    return { kind: 'string', value: expr.getLiteralValue(), text: expr.getText() }
  }
  if (Node.isNumericLiteral(expr)) return { kind: 'number', text: expr.getText() }
  if (Node.isPrefixUnaryExpression(expr) && expr.getOperatorToken() === SyntaxKind.MinusToken && Node.isNumericLiteral(expr.getOperand())) {
    return { kind: 'number', text: expr.getText() }
  }
  if (expr.getKind() === SyntaxKind.TrueKeyword || expr.getKind() === SyntaxKind.FalseKeyword) return { kind: 'boolean', text: expr.getText() }
  if (expr.getKind() === SyntaxKind.NullKeyword) return { kind: 'null', text: 'null' }
  if (Node.isIdentifier(expr) && expr.getText() === 'undefined') return { kind: 'undefined', text: 'undefined' }
  if (Node.isObjectLiteralExpression(expr)) {
    const props = new Map<string, DataValue>()
    for (const property of expr.getProperties()) {
      if (!Node.isPropertyAssignment(property)) return null
      const key = property.getNameNode()
      if (!(Node.isIdentifier(key) || Node.isStringLiteral(key) || Node.isNumericLiteral(key))) return null
      const initializer = property.getInitializer()
      const value = initializer ? readData(initializer) : null
      if (!value) return null
      props.set(Node.isStringLiteral(key) ? key.getLiteralValue() : key.getText(), value)
    }
    return { kind: 'object', props, text: expr.getText() }
  }
  if (Node.isArrayLiteralExpression(expr)) {
    const items: DataValue[] = []
    for (const element of expr.getElements()) {
      const value = readData(element)
      if (!value) return null
      items.push(value)
    }
    return { kind: 'array', items, text: expr.getText() }
  }
  return null
}

function parameterNames(callback: { getParameters(): ParameterDeclaration[] }): { ok: true; item: string | null; index: string | null } | ReturnType<typeof refuse> {
  const parameters = callback.getParameters()
  if (parameters.length > 2) return refuse('unsupported-params', "This list's callback takes more than an item and an index. Reduce it to `(item, index) =>` in the code.")
  const names: (string | null)[] = []
  for (const parameter of parameters) {
    const name = parameter.getNameNode()
    if (!Node.isIdentifier(name) || parameter.getInitializer() || parameter.isRestParameter()) {
      return refuse('unsupported-params', "This list's callback destructures or defaults its item. Use a plain `(item, index) =>` callback in the code.")
    }
    names.push(name.getText())
  }
  return { ok: true, item: names[0] ?? null, index: names[1] ?? null }
}

/** True when anything under `body` declares a binding called `name` (a nested function's parameter, a `const`, …). */
function declaresName(body: Node, name: string): boolean {
  return body.getDescendantsOfKind(SyntaxKind.Identifier).some((id) => {
    if (id.getText() !== name) return false
    const parent = id.getParent()
    if (!parent) return false
    return (
      (Node.isParameterDeclaration(parent) && parent.getNameNode() === id) ||
      (Node.isVariableDeclaration(parent) && parent.getNameNode() === id) ||
      (Node.isBindingElement(parent) && parent.getNameNode() === id) ||
      (Node.isFunctionDeclaration(parent) && parent.getNameNode() === id) ||
      (Node.isClassDeclaration(parent) && parent.getNameNode() === id) ||
      (Node.isFunctionExpression(parent) && parent.getNameNode() === id)
    )
  })
}

interface Reference {
  node: Node
  kind: 'item' | 'index'
}

/** Every read of the item/index parameter inside `root`, or the refusal for a write to one. */
function collectReferences(root: Node, names: { item: string | null; index: string | null }): { ok: true; found: Reference[] } | ReturnType<typeof refuse> {
  const found: Reference[] = []
  for (const id of root.getDescendantsOfKind(SyntaxKind.Identifier)) {
    const text = id.getText()
    const kind = text === names.item ? 'item' : text === names.index ? 'index' : null
    if (!kind || !isReference(id)) continue
    let top: Node = id
    for (let parent = top.getParent(); parent && (Node.isPropertyAccessExpression(parent) || Node.isElementAccessExpression(parent)) && parent.getExpression() === top; parent = top.getParent()) top = parent
    if (isWriteTarget(top)) return refuse('param-assigned', `This row changes "${text}", which a written-out row cannot do. Remove the assignment in the code.`)
    found.push({ node: id, kind })
  }
  return { ok: true, found }
}

/** An identifier that READS a binding, as opposed to naming a property, attribute or tag. */
function isReference(id: Node): boolean {
  const parent = id.getParent()
  if (!parent) return false
  if (Node.isPropertyAccessExpression(parent)) return parent.getExpression() === id
  if (Node.isPropertyAssignment(parent)) return parent.getInitializer() === id
  if (Node.isJsxAttribute(parent) || Node.isPropertySignature(parent) || Node.isMethodDeclaration(parent)) return false
  if (Node.isQualifiedName(parent)) return parent.getLeft() === id
  if (Node.isJsxOpeningElement(parent) || Node.isJsxSelfClosingElement(parent) || Node.isJsxClosingElement(parent)) return false
  if (Node.isTypeReference(parent) || Node.isBindingElement(parent) || Node.isParameterDeclaration(parent) || Node.isVariableDeclaration(parent)) return false
  return true
}

function isWriteTarget(top: Node): boolean {
  const parent = top.getParent()
  if (!parent) return false
  if (Node.isBinaryExpression(parent) && parent.getLeft() === top) {
    const kind = parent.getOperatorToken().getKind()
    return kind >= SyntaxKind.FirstAssignment && kind <= SyntaxKind.LastAssignment
  }
  if (Node.isPrefixUnaryExpression(parent) || Node.isPostfixUnaryExpression(parent)) {
    const operator = parent.getOperatorToken()
    return operator === SyntaxKind.PlusPlusToken || operator === SyntaxKind.MinusMinusToken
  }
  return Node.isDeleteExpression(parent) || ((Node.isForInStatement(parent) || Node.isForOfStatement(parent)) && parent.getInitializer() === top)
}

/** The bytes of the row root's `key` attribute and the whitespace before it, or `null` when there is none. */
function rootKeyRemoval(opening: Node): { start: number; end: number } | null {
  if (!Node.isJsxOpeningElement(opening) && !Node.isJsxSelfClosingElement(opening)) return null
  const attributes = opening.getAttributes()
  const index = attributes.findIndex((attribute) => Node.isJsxAttribute(attribute) && attribute.getNameNode().getText() === 'key')
  if (index < 0) return null
  // `<Row<T> key=…>`: the key stays rather than guess where the type arguments end.
  if (index === 0 && opening.compilerNode.typeArguments) return null
  const previousEnd = index > 0 ? attributes[index - 1]!.getEnd() : opening.getTagNameNode().getEnd()
  return { start: previousEnd, end: attributes[index]!.getEnd() }
}

/** The replacement for one reference: the byte range it covers and the text that goes there. */
function referenceEdit(reference: Reference, value: DataValue): { ok: true; start: number; end: number; text: string } | ReturnType<typeof refuse> {
  // Follow `.a.b` / `['a']` / `[0]` / `.length` as far as the data goes.
  let top: Node = reference.node
  let current = value
  for (;;) {
    const parent = top.getParent()
    if (!parent) break
    let next: DataValue | undefined
    if (Node.isPropertyAccessExpression(parent) && parent.getExpression() === top) next = member(current, parent.getName())
    else if (Node.isElementAccessExpression(parent) && parent.getExpression() === top) {
      const argument = parent.getArgumentExpression()
      if (argument && (Node.isStringLiteral(argument) || Node.isNumericLiteral(argument))) {
        next = member(current, Node.isStringLiteral(argument) ? argument.getLiteralValue() : argument.getText())
      }
    }
    if (!next) break
    current = next
    top = parent
  }

  const parent = top.getParent()
  if ((current.kind === 'object' || current.kind === 'array') && current.text.includes('\n')) {
    return refuse('multi-line-value', 'A row passes a whole multi-line item along, which cannot be copied into each row without reformatting. Split the item into fields in the code.')
  }

  // `{row.label}` as a child / `title={row.label}` as an attribute: the braces go when the value reads as plain text.
  const braces = parent && Node.isJsxExpression(parent) && !parent.getDotDotDotToken() ? parent : null
  if (braces) {
    const owner = braces.getParent()
    if (owner && (Node.isJsxElement(owner) || Node.isJsxFragment(owner))) {
      const raw = rawJsxText(current)
      if (raw !== null) return { ok: true, start: braces.getStart(), end: braces.getEnd(), text: raw }
    } else if (owner && Node.isJsxAttribute(owner) && current.kind === 'string' && isPlainAttributeText(current.value)) {
      return { ok: true, start: braces.getStart(), end: braces.getEnd(), text: `"${current.value}"` }
    }
  }

  const wrap = needsParens(top, current)
  const text = wrap ? `(${current.text})` : current.text
  const shorthand = top.getParent()
  if (shorthand && Node.isShorthandPropertyAssignment(shorthand) && top === reference.node) {
    return { ok: true, start: top.getStart(), end: top.getEnd(), text: `${top.getText()}: ${text}` }
  }
  return { ok: true, start: top.getStart(), end: top.getEnd(), text }
}

function member(value: DataValue, key: string): DataValue | undefined {
  if (value.kind === 'object') return value.props.get(key)
  if (value.kind === 'array') {
    if (key === 'length') return { kind: 'number', text: String(value.items.length) }
    return /^\d+$/.test(key) ? value.items[Number(key)] : undefined
  }
  return undefined
}

/** Text that reads the same as a JSX child as it did as a string/number value, or `null` when braces are needed. */
function rawJsxText(value: DataValue): string | null {
  if (value.kind === 'number') return /^-?\d+(\.\d+)?$/.test(value.text) ? value.text : null
  if (value.kind !== 'string') return null
  const text = value.value
  return text.length === 0 || text !== text.trim() || /[\n\r{}<>&'"]/.test(text) ? null : text
}

function isPlainAttributeText(text: string): boolean {
  return !/["&\\\n\r]/.test(text)
}

/** An expression that must be parenthesised where `value` replaces `node` (`12.toFixed`, `a - -5`, `{a:1}.b`). */
function needsParens(node: Node, value: DataValue): boolean {
  const parent = node.getParent()
  if (!parent) return false
  const asObject = (Node.isPropertyAccessExpression(parent) || Node.isElementAccessExpression(parent)) && parent.getExpression() === node
  const asCallee = Node.isCallExpression(parent) && parent.getExpression() === node
  if (value.kind === 'object' || value.kind === 'array' || value.kind === 'number') {
    if (asObject || asCallee) return true
  }
  if (value.kind === 'number' && value.text.startsWith('-')) {
    return Node.isBinaryExpression(parent) || Node.isPrefixUnaryExpression(parent) || Node.isPostfixUnaryExpression(parent)
  }
  return false
}

/** True when `root` holds a template literal whose text spans lines — re-indenting would change the string. */
function spansLinesInText(root: Node): boolean {
  return [...root.getDescendantsOfKind(SyntaxKind.NoSubstitutionTemplateLiteral), ...root.getDescendantsOfKind(SyntaxKind.TemplateExpression)].some((literal) =>
    literal.getText().includes('\n'),
  )
}

/** Moves the second and later lines of `row` from the callback's indentation to the list's. */
function reindent(row: string, from: string, to: string): string {
  return row
    .split('\n')
    .map((line, index) => (index > 0 && line.startsWith(from) ? to + line.slice(from.length) : line))
    .join('\n')
}
