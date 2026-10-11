/**
 * Sets one literal INSIDE a JSX attribute's inline list or object, then writes
 * the file back: `<Navbar segmentedControl={{ items: ['A', 'B'], value: 0 }} />`
 * -> `value: 1`, or `<Navbar chips={[{ label: 'Dates' }]} />` -> the first
 * chip gains `selected: true`.
 *
 * `setJsxProp` refuses a whole array or object on purpose (it would delete
 * the list). This is its counterpart for the one honest write inside one: the
 * attribute's initializer is walked by `path` — a key for an object literal, an
 * index for an array literal — and ONE scalar literal at the end is replaced.
 * Every byte outside that literal is the user's own.
 *
 * ## What lands, and what is refused by name
 *
 *  - The leaf is an existing string / number / boolean literal: replaced, in
 *    the quote the file already uses.
 *  - The last segment is a key the object does not have yet: the entry is
 *    appended to that object, in its own layout (one per line stays one per
 *    line, inline stays inline, a trailing comma stays one).
 *  - Anything on the way that is code — an identifier (`items={ITEMS}`), a call,
 *    a spread, a computed key, a conditional — refuses `binding-overwrite`:
 *    writing a literal over it would delete the binding. A path that names an
 *    entry the literal does not hold refuses with the path in the message.
 */
import { Node, Project, type Expression, type SourceFile } from 'ts-morph'
import { createProject, findJsxElementAtLocationOrThrow, loadSourceFile } from './locateJsxElement'
import { JsxPropTargetError } from './setJsxProp'
import { jsStringSpelling, preferredQuote, quoteOf, type Quote } from './stringSpelling'

export type PropPathSegment = string | number

export interface SetJsxPropPathParams {
  file: string
  line: number
  col: number
  prop: string
  path: readonly PropPathSegment[]
  value: string | number | boolean
  project?: Project
}

const IDENTIFIER_KEY = /^[A-Za-z_$][\w$]*$/

function strip(expression: Expression): Expression {
  let current = expression
  while (Node.isParenthesizedExpression(current)) current = current.getExpression()
  return current
}

function isScalarLiteral(node: Node): boolean {
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node) || Node.isNumericLiteral(node)) return true
  if (Node.isTrueLiteral(node) || Node.isFalseLiteral(node)) return true
  return Node.isPrefixUnaryExpression(node) && /^-\s*\d/.test(node.getText())
}

function scalarSpelling(value: string | number | boolean, quote: Quote): string {
  return typeof value === 'string' ? jsStringSpelling(value, quote) : String(value)
}

function keySpelling(key: string, quote: Quote): string {
  return IDENTIFIER_KEY.test(key) ? key : jsStringSpelling(key, quote)
}

function describe(path: readonly PropPathSegment[]): string {
  return path.map((segment) => (typeof segment === 'number' ? `[${segment}]` : `.${segment}`)).join('')
}

function notEditable(at: string, prop: string, path: readonly PropPathSegment[], reason: string): JsxPropTargetError {
  return new JsxPropTargetError(
    `"${prop}${describe(path)}" is ${reason}, so a typed value would not land in one place. Edit it in the code.`,
    at,
  )
}

/** The text of the key of an object-literal member, or `null` when it is not a plain `key: value` entry. */
function memberKey(member: Node): { name: string; initializer: Expression } | null {
  if (!Node.isPropertyAssignment(member)) return null
  const nameNode = member.getNameNode()
  const initializer = member.getInitializer()
  if (!initializer) return null
  if (Node.isIdentifier(nameNode)) return { name: nameNode.getText(), initializer }
  if (Node.isStringLiteral(nameNode) || Node.isNumericLiteral(nameNode)) return { name: nameNode.getLiteralText(), initializer }
  return null
}

export function setJsxPropPath(params: SetJsxPropPathParams): void {
  const { file, line, col, prop, path, value } = params
  const project = params.project ?? createProject()
  const sourceFile = loadSourceFile(project, file)
  const element = findJsxElementAtLocationOrThrow(sourceFile, file, line, col)
  const where = `${file}:${line}:${col}`

  const attribute = element.getAttribute(prop)
  const initializer = attribute && Node.isJsxAttribute(attribute) ? attribute.getInitializer() : undefined
  if (!initializer || !Node.isJsxExpression(initializer) || !initializer.getExpression()) {
    throw new JsxPropTargetError(
      `"${prop}" is not an inline list or object here, so there is nothing to edit inside it. Change it in the code.`,
      where,
    )
  }
  const quote = preferredQuote(sourceFile)
  let current: Expression = strip(initializer.getExpression()!)

  for (let depth = 0; depth < path.length; depth += 1) {
    const segment = path[depth]!
    const last = depth === path.length - 1
    const here = path.slice(0, depth + 1)
    if (typeof segment === 'number') {
      if (!Node.isArrayLiteralExpression(current)) throw notEditable(where, prop, here, 'not an inline list')
      const entry = current.getElements()[segment]
      if (!entry || Node.isSpreadElement(entry)) throw notEditable(where, prop, here, 'not an entry the list holds')
      current = strip(entry)
      continue
    }
    if (!Node.isObjectLiteralExpression(current)) throw notEditable(where, prop, here, 'not an inline object')
    let found: Expression | null = null
    for (const member of current.getProperties()) {
      const keyed = memberKey(member)
      if (keyed === null) throw notEditable(where, prop, here, 'an object with spread, shorthand or computed entries')
      if (keyed.name === segment) found = strip(keyed.initializer)
    }
    if (found !== null) {
      current = found
      continue
    }
    if (!last) throw notEditable(where, prop, here, 'not an entry the object holds')
    appendEntry(sourceFile, current, keySpelling(segment, quote), scalarSpelling(value, quote))
    sourceFile.saveSync()
    return
  }

  if (!isScalarLiteral(current)) throw notEditable(where, prop, path, 'set from code')
  const leafQuote = Node.isStringLiteral(current) ? quoteOf(current) : quote
  current.replaceWithText(scalarSpelling(value, leafQuote))
  sourceFile.saveSync()
}

/** Appends `key: value` to an object literal in the layout it already has. */
function appendEntry(sourceFile: SourceFile, object: Node, key: string, value: string): void {
  if (!Node.isObjectLiteralExpression(object)) return
  const members = object.getProperties()
  const entry = `${key}: ${value}`
  if (members.length === 0) {
    object.replaceWithText(`{ ${entry} }`)
    return
  }
  const first = members[0]!
  const lastMember = members[members.length - 1]!
  const multiline = first.getStartLineNumber() > object.getStartLineNumber()
  const fullText = sourceFile.getFullText()
  let end = lastMember.getEnd()
  let after = end
  while (after < fullText.length && /\s/.test(fullText[after]!)) after += 1
  const trailingComma = fullText[after] === ','
  if (trailingComma) end = after + 1
  const lineStart = fullText.lastIndexOf('\n', first.getStart() - 1) + 1
  const indent = fullText.slice(lineStart, first.getStart()).match(/^\s*/)![0]
  const text = multiline
    ? trailingComma
      ? `\n${indent}${entry},`
      : `,\n${indent}${entry}`
    : trailingComma
      ? ` ${entry},`
      : `, ${entry}`
  sourceFile.insertText(end, text)
}
