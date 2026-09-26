/**
 * Sets, merges, or REMOVES entries in a `style={{ ... }}` object-literal
 * attribute on the JSX element found at a source location, then writes the
 * change back to disk.
 *
 * `remove` (`style-03`) is the half that was missing. The caller's diff only
 * ever sent CHANGED keys and this codemod only ever merged, so clearing an
 * inline style produced no edit at all: the canvas updated, the save reported
 * success, the `style={{…}}` on disk kept the old declaration, and it came
 * straight back on the next reload. Removing the last property removes the
 * whole attribute — an empty `style={{}}` says nothing.
 *
 * ## A spread, an identifier, a call (P3-C, WB-17)
 *
 * These used to refuse `style-target`. JS object semantics give each of them
 * exactly one honest target for a SET, so they are written now:
 *
 * - `{{ ...base, color: 'red' }}` — a key written AFTER the last spread wins
 *   over anything the spread supplies. A set updates that key in place, or
 *   appends it (the end of the object is after every spread). A key written
 *   only BEFORE the spread is MOVED after it: left where it was it would be a
 *   duplicate property (TS1117), and its old value was about to be replaced
 *   by the user's anyway.
 * - `style={tile}` / `style={tone('warm')}` / `style={theme.card}` — wrapped
 *   as `style={{ ...tile, color: "blue" }}`, which keeps the binding and puts
 *   the new key on top of it.
 *
 * What still refuses: REMOVING a key from a wrapped expression (the key lives
 * inside it — there is nothing in this file to delete), wrapping an
 * expression that is not an object at all (`style="color:red"`, a template, a
 * number — spreading a string would scatter its characters), and overwriting
 * or removing a SHORTHAND key (`{ color }`), whose binding this codemod never
 * read. A removal of a key nothing in the object writes is a no-op, exactly
 * as before: the parser never reads a key out of a spread (see
 * `extractInlineStyles`), so the canvas never offered one to remove.
 *
 * ## Formatting (WB-10)
 *
 * A write changes the value and nothing around it. A string value is spelled
 * in the quote the object's own string values already use (the file's, for an
 * object with none — `stringSpelling.ts`), an existing value is replaced in
 * place, and an appended key follows the object's layout: on the same line in
 * a one-line object, and on its own line — indented like its siblings, with
 * the object's trailing-comma habit — in a multi-line one. It used to come
 * back double-quoted, and ts-morph's printer indented appended keys by its own
 * idea of the file, so one colour change rewrote lines the user never touched.
 *
 * See `locateJsxElement.ts` for the (line, col) → node resolution algorithm.
 */
import { Node, Project, type Expression, type ObjectLiteralElementLike, type ObjectLiteralExpression, type SourceFile } from 'ts-morph'
import { createProject, findJsxElementAtLocationOrThrow, loadSourceFile } from './locateJsxElement'
import { jsStringSpelling, preferredQuote, quoteOf, type Quote } from './stringSpelling'

export interface SetJsxStyleParams {
  file: string
  line: number
  col: number
  /** camelCase CSS property names → values (values may be `var(--token)` strings). */
  style: Record<string, string | number>
  /** camelCase CSS property names to DELETE from the object literal. */
  remove?: readonly string[]
  /** Optional pre-existing project to reuse (e.g. across multiple edits). */
  project?: Project
}

/**
 * Thrown when `setJsxStyle`'s target `style` attribute can't be written
 * honestly — a spread ATTRIBUTE, an initializer that is not an object at all,
 * a removal from a wrapped expression, or a shorthand key.
 * `path` is `<file>:<line>:<col>` of the target element.
 */
export class JsxStyleTargetError extends Error {
  readonly path: string
  /** The reason on its own, without the codemod prefix and the absolute path — what a person may read (WB-33). */
  readonly detail: string

  constructor(message: string, path: string) {
    super(`[ast-codemods/setJsxStyle] ${path}: ${message}`)
    this.name = 'JsxStyleTargetError'
    this.path = path
    this.detail = message
  }
}

const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/** Quote a property key only when it isn't a valid bare identifier. */
function buildPropertyName(key: string): string {
  return IDENTIFIER_RE.test(key) ? key : JSON.stringify(key)
}

/** Numbers serialize as-is; strings as JS string literals in `quote`. */
function buildPropertyValueText(value: string | number, quote: Quote): string {
  return typeof value === 'number' ? String(value) : jsStringSpelling(value, quote)
}

function buildEntriesText(style: Record<string, string | number>, quote: Quote): string[] {
  return Object.entries(style).map(([key, value]) => `${buildPropertyName(key)}: ${buildPropertyValueText(value, quote)}`)
}

/** Builds a full `style={{ ... }}` attribute initializer (braces included). */
function buildStyleInitializerText(style: Record<string, string | number>, quote: Quote): string {
  return `{{ ${buildEntriesText(style, quote).join(', ')} }}`
}

/** The quote `object`'s own string values are written in, or the file's when it has none. */
function objectQuote(object: ObjectLiteralExpression, sourceFile: SourceFile): Quote {
  for (const member of object.getProperties()) {
    const initializer = Node.isPropertyAssignment(member) ? member.getInitializer() : undefined
    if (initializer && Node.isStringLiteral(initializer)) return quoteOf(initializer)
  }
  return preferredQuote(sourceFile)
}

/**
 * The spread operand for a `style` expression that can evaluate to an
 * object — or `null` for one that cannot (a string, a template, a number, a
 * JSX element, a function), which is refused rather than spread. A
 * conditional or a cast is parenthesised; a reference or a call is not.
 */
function spreadOperandText(expression: Expression): string | null {
  if (
    Node.isIdentifier(expression) ||
    Node.isPropertyAccessExpression(expression) ||
    Node.isElementAccessExpression(expression) ||
    Node.isCallExpression(expression) ||
    Node.isParenthesizedExpression(expression) ||
    Node.isNonNullExpression(expression)
  ) {
    return expression.getText()
  }
  if (Node.isConditionalExpression(expression) || Node.isAsExpression(expression) || Node.isSatisfiesExpression(expression)) {
    return `(${expression.getText()})`
  }
  return null
}

/** The static key of an object-literal member, or `null` for a spread, a computed key, or a method. */
function memberKey(member: ObjectLiteralElementLike): string | null {
  if (!Node.isPropertyAssignment(member) && !Node.isShorthandPropertyAssignment(member)) return null
  const name = member.getNameNode()
  if (Node.isIdentifier(name)) return name.getText()
  if (Node.isStringLiteral(name)) return name.getLiteralValue()
  return null
}

/** Every member of `object` that writes `key`, each with its position among the object's members. */
function membersWriting(object: ObjectLiteralExpression, key: string): { member: ObjectLiteralElementLike; index: number }[] {
  return object
    .getProperties()
    .map((member, index) => ({ member, index }))
    .filter(({ member }) => memberKey(member) === key)
}

function lastSpreadIndex(object: ObjectLiteralExpression): number {
  return object.getProperties().reduce((last, member, index) => (Node.isSpreadAssignment(member) ? index : last), -1)
}

/** A `key: value` entry waiting to be appended — both halves already source text. */
interface PendingEntry {
  name: string
  initializer: string
}

/**
 * Merges `style` into, and deletes `remove` from, a plain object literal — see
 * the file doc for the spread rules. Returns the `key: value` entries still to
 * APPEND: appending is left to `appendEntries`, last, because it is a text
 * insertion that invalidates every node this function holds.
 */
function mergeIntoObjectLiteral(
  object: ObjectLiteralExpression,
  style: Record<string, string | number>,
  remove: readonly string[],
  path: string,
  quote: Quote,
): PendingEntry[] {
  const appends: PendingEntry[] = []
  for (const key of remove) {
    const writers = membersWriting(object, key)
    // A shorthand (`{ color }`): deleting it would drop a binding whose value
    // this codemod never read. Same fail-closed posture as the set path.
    if (writers.some(({ member }) => !Node.isPropertyAssignment(member))) {
      throw new JsxStyleTargetError(`style key "${key}" is not a plain "key: value" property — refusing to remove it`, path)
    }
    // Absent: an idempotent re-send (or a key only a spread supplies, which
    // the canvas never showed) — nothing in the file to delete.
    for (const { member } of writers.reverse()) member.remove()
  }

  for (const [key, value] of Object.entries(style)) {
    const valueText = buildPropertyValueText(value, quote)
    const writers = membersWriting(object, key)
    if (writers.some(({ member }) => !Node.isPropertyAssignment(member))) {
      // Shorthand property (`{ color }`) — fail closed rather than guess at
      // what overwriting a binding this codemod never read should mean.
      throw new JsxStyleTargetError(`style key "${key}" is not a plain "key: value" property — refusing to overwrite it`, path)
    }
    const spreadAt = lastSpreadIndex(object)
    const winner = writers.filter(({ index }) => index > spreadAt).at(-1)
    if (winner && Node.isPropertyAssignment(winner.member)) {
      winner.member.setInitializer(valueText)
      continue
    }
    // Written only before the last spread (or not at all): the value the
    // user set must come AFTER every spread to win, and one key written twice
    // is a TS1117 — so the earlier one moves rather than stays.
    for (const { member } of writers.reverse()) member.remove()
    appends.push({ name: buildPropertyName(key), initializer: valueText })
  }
  return appends
}

/**
 * Appends entries at the end of `object` — after every spread — in the
 * object's own layout (WB-10). A one-line object stays one line
 * (`addPropertyAssignment` would reflow `{ ...base, color: 'red' }` over
 * three). A multi-line one gets one line per entry, indented like its last
 * member and ending the way that member ends — with or without a trailing
 * comma. Only an EMPTY object is left to ts-morph, having no layout to copy.
 */
function appendEntries(object: ObjectLiteralExpression, entries: readonly PendingEntry[]): void {
  if (entries.length === 0) return
  const last = object.getProperties().at(-1)
  if (!last) {
    object.addPropertyAssignments([...entries])
    return
  }
  const sourceFile = object.getSourceFile()
  if (!object.getText().includes('\n')) {
    const text = entries.map(({ name, initializer }) => `, ${name}: ${initializer}`).join('')
    sourceFile.insertText(last.getEnd(), text)
    return
  }
  const fullText = sourceFile.getFullText()
  const lineStart = fullText.lastIndexOf('\n', last.getStart() - 1) + 1
  const indent = /^[ \t]*/.exec(fullText.slice(lineStart))![0]
  const afterLast = fullText.slice(last.getEnd(), object.getEnd())
  const trailingComma = /^\s*,/.test(afterLast)
  const lines = entries.map(({ name, initializer }) => `\n${indent}${name}: ${initializer}`)
  if (trailingComma) {
    sourceFile.insertText(last.getEnd() + afterLast.indexOf(',') + 1, lines.map((line) => `${line},`).join(''))
  } else {
    sourceFile.insertText(last.getEnd(), lines.map((line) => `,${line}`).join(''))
  }
}

export function setJsxStyle(params: SetJsxStyleParams): void {
  const { file, line, col, style } = params
  const remove = params.remove ?? []
  const project = params.project ?? createProject()
  const sourceFile = loadSourceFile(project, file)
  const element = findJsxElementAtLocationOrThrow(sourceFile, file, line, col)
  const path = `${file}:${line}:${col}`

  const existingAttribute = element.getAttribute('style')

  if (!existingAttribute) {
    // Nothing to remove from an attribute that does not exist, and nothing to
    // set either — a removal-only request on a bare element is a no-op, not a
    // reason to mint an empty `style={{}}`.
    if (Object.keys(style).length === 0) return
    element.addAttribute({ name: 'style', initializer: buildStyleInitializerText(style, preferredQuote(sourceFile)) })
    sourceFile.saveSync()
    return
  }

  if (!Node.isJsxAttribute(existingAttribute)) {
    // `getAttribute(name)` only matches spread attributes if `name` happens to
    // equal the literal text "...expr", which should never occur for a real
    // attribute name — guard against silently clobbering one anyway.
    throw new JsxStyleTargetError(
      'the "style" attribute is a spread attribute — cannot merge a literal style object into it',
      path,
    )
  }

  const initializer = existingAttribute.getInitializer()
  const expression = initializer && Node.isJsxExpression(initializer) ? initializer.getExpression() : undefined

  if (expression === undefined) {
    // Covers a valueless shorthand (`<Foo style />`) and a raw string literal
    // (`style="color:red"`, invalid at runtime but syntactically legal) — neither
    // is an object-literal expression this codemod can merge into.
    throw new JsxStyleTargetError(
      'the "style" attribute has no object-literal expression to merge into',
      path,
    )
  }

  if (!Node.isObjectLiteralExpression(expression)) {
    // WB-17 — an expression: wrap it, so the binding stays and the new keys
    // sit on top of it.
    if (remove.length > 0) {
      throw new JsxStyleTargetError(
        'the "style" attribute is an expression, not an object literal — a property it supplies cannot be removed here',
        path,
      )
    }
    const operand = spreadOperandText(expression)
    if (operand === null) {
      throw new JsxStyleTargetError(
        'the "style" attribute is not an object (a string, template, or other value) — refusing to overwrite it',
        path,
      )
    }
    if (Object.keys(style).length === 0) return
    existingAttribute.setInitializer(`{{ ...${operand}, ${buildEntriesText(style, preferredQuote(sourceFile)).join(', ')} }}`)
    sourceFile.saveSync()
    return
  }

  const appends = mergeIntoObjectLiteral(expression, style, remove, path, objectQuote(expression, sourceFile))

  // Every property gone: an empty `style={{}}` is noise the user did not
  // write, so the attribute goes with the last declaration in it.
  if (appends.length === 0 && expression.getProperties().length === 0) existingAttribute.remove()
  else appendEntries(expression, appends)

  sourceFile.saveSync()
}
