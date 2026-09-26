/**
 * editListItems — OD-8: a `.map` row's reorder, delete, duplicate and paste,
 * written as the matching change to the ARRAY LITERAL the `.map` iterates.
 *
 * WHY THE ARRAY
 * -------------
 * One piece of JSX renders every row, so the JSX has no position that is row
 * 2's alone. Element 2 of `const ROWS = [ … ]` is — the parser tied each row
 * to its element (`ListRowSource`, `@core/page-tree`) — and the literal is ONE
 * place: permuting, removing or copying its elements is exactly one honest
 * write. The address is the literal's own `[`, which no edit of its own
 * elements can move.
 *
 * THE BYTES
 * ---------
 * The AST only locates; the write is a splice of the file's own bytes, like
 * every structural codemod here (`jsxChildRange.ts`). Two layouts, decided by
 * what the literal already is:
 *
 *  - **One element per line** (every element starts its own line): each
 *    element owns its whole lines — its indentation, the comment lines above
 *    it, its comma and a comment after the comma. Those blocks are what move,
 *    so a comment travels with its element. The comma is the one byte that
 *    belongs to the POSITION, not the element: every block but the last has
 *    one, and the last keeps whatever the array had (a trailing comma or
 *    none). A blank line belongs to the element above it, so an undo puts
 *    it back with that element; a COPY does not repeat it.
 *  - **Inline** (`['a', 'b']`, or anything mixed): the elements themselves
 *    move, the separators between them stay where they are, and a trailing
 *    comma stays a trailing comma.
 *
 * A copy is a copy of those same bytes. When the row's React key reads a
 * field of its item (`key={item.id}`), the copy's field is rewritten to a
 * value no other element holds (`'pro'` → `'pro-copy'`, `3` → the next free
 * number), because two rows with one key is a bug in the user's app; a key
 * Studio cannot rewrite refuses (`duplicate-key`).
 *
 * WHAT IS REFUSED, and every refusal leaves the file byte-identical
 * ---------------------------------------------------------------------
 *  - `not-found` — no array literal starts at `line:col`.
 *  - `stale-source` — the bytes on disk are not the bytes parsed.
 *  - `list-changed` — the literal does not have `length` plain elements (it
 *    was edited since the board read it, or grew a spread) — never guess.
 *  - `bad-index` — an index outside the array, or an order that is not a
 *    permutation of it.
 *  - `duplicate-key` — see above.
 *  - `not-data` / `invalid-import` / `invalid-source` — an `insert`'s texts
 *    (⌘Z of a remove: the one op carrying client bytes). Each text must parse
 *    ON ITS OWN as exactly one array element, and compute nothing when the
 *    file loads: no call, `new`, tagged template, assignment, `await`, class
 *    or dynamic import outside a function body. A literal element in a module
 *    `const` runs the moment Vite imports the file (`sec-22`'s concern one
 *    level up), so bytes that would run code there are never written from the
 *    editor — the user's own undo or `git` is the way back for such a row.
 *    Imports must each be exactly one import declaration; the spliced file
 *    must add no syntax error.
 */
import { Node, Project, SyntaxKind, ts, type ArrayLiteralExpression, type Expression, type SourceFile } from 'ts-morph'
import type { ListItemOp, ListRowKey } from '@core/page-tree'
import { createProject, loadSourceFile } from './locateJsxElement'
import { applyTextEdits, verbatimSourceText, writeVerbatimSource, type TextEdit } from './jsxChildRange'
import { buildImportReinsertEdit, introducesSyntaxErrors, parsesAsOneImportDeclaration } from './reinsertJsxSource'

export interface EditListItemsParams {
  file: string
  /** 1-based position of the array literal's `[`. */
  line: number
  col: number
  /** How many elements the literal must have for this edit to be the one the caller planned. */
  length: number
  op: ListItemOp
  project?: Project
}

export type ListItemRefusalReason =
  | 'not-found'
  | 'stale-source'
  | 'list-changed'
  | 'bad-index'
  | 'duplicate-key'
  | 'not-data'
  | 'invalid-import'
  | 'invalid-source'

export interface ListItemRefusal {
  reason: ListItemRefusalReason
  message: string
}

/**
 * `removed` — for a `remove`, each removed element's text in ascending index
 * order, in the form an `insert` takes back (a whole-line block in a one-per-
 * line array, the element's own text in an inline one).
 */
export type EditListItemsResult = { ok: true; removed: string[] } | { ok: false; refusal: ListItemRefusal }

function refuse(reason: ListItemRefusalReason, message: string): { ok: false; refusal: ListItemRefusal } {
  return { ok: false, refusal: { reason, message } }
}

/** One element's bytes, split so it can be written at any position. */
interface ItemText {
  /** Block layout: from its line start to the element (indentation, comment lines). Inline: comments before it. */
  lead: string
  /** The element itself. */
  body: string
  /** Between the element and its comma (block layout only). */
  mid: string
  /** After the comma to the end of its last line, newline included (block layout only). */
  trail: string
}

interface ArrayLayout {
  block: boolean
  items: ItemText[]
  /** Block: [start of the first block, end of the last]. Inline: [first element's own start, last element's end]. */
  regionStart: number
  regionEnd: number
  /** Block: text between consecutive blocks (blank lines). Inline: the separators between elements. */
  gaps: string[]
  /** Block: whether the last element carries a comma (a trailing comma). */
  trailingComma: boolean
  /** Where an item goes in an EMPTY array — block: after the `[` line; inline: right after `[`. */
  emptyAt: number
  /** Leading whitespace a new block line takes. */
  indent: string
  /** The `]`'s own offset. */
  close: number
}

export function editListItems(params: EditListItemsParams): EditListItemsResult {
  const { file, line, col, length, op } = params
  const project = params.project ?? createProject()
  const sourceFile = loadSourceFile(project, file)
  const verbatim = verbatimSourceText(sourceFile, file)
  if (verbatim === null) {
    return refuse('stale-source', 'This file changed on disk since the canvas last read it. Reload the project and try again.')
  }
  const array = findArrayLiteralAt(sourceFile, line, col)
  if (!array) {
    return refuse('not-found', `No array is written at line ${line}, column ${col} any more — the file changed since the canvas last read it.`)
  }
  const elements = array.getElements()
  if (elements.length !== length || elements.some((el) => Node.isSpreadElement(el) || Node.isOmittedExpression(el))) {
    return refuse(
      'list-changed',
      'This list’s array is not the one the board read — it has a different number of items now. Nothing was changed; the board will catch up with the file.',
    )
  }
  const indexError = checkIndices(op, length)
  if (indexError) return refuse('bad-index', indexError)

  const layout = readLayout(verbatim, array)
  const planned = planItems(layout, elements, op, verbatim)
  if (!planned.ok) return planned
  const edits: TextEdit[] = [renderEdit(layout, planned.items)]
  if (op.kind === 'insert') {
    for (const importText of op.imports ?? []) {
      if (!parsesAsOneImportDeclaration(importText)) {
        return refuse('invalid-import', 'One of the imports this undo would restore is not valid on its own, so nothing was changed.')
      }
    }
    const importEdit = buildImportReinsertEdit(sourceFile, verbatim, op.imports ?? [])
    if (importEdit) edits.push(importEdit)
  }
  const candidate = applyTextEdits(verbatim, edits)
  if (introducesSyntaxErrors(file, verbatim, candidate)) {
    return refuse('invalid-source', 'This change would leave the file with a syntax error, so nothing was changed.')
  }
  writeVerbatimSource(sourceFile, file, candidate)
  const removed = op.kind === 'remove' ? op.indices.map((index) => renderItem(layout, layout.items[index]!, true)) : []
  return { ok: true, removed }
}

/** The array literal whose `[` is at `line:col`, or `undefined`. */
function findArrayLiteralAt(sourceFile: SourceFile, line: number, col: number): ArrayLiteralExpression | undefined {
  const lineCount = sourceFile.getEndLineNumber()
  if (line < 1 || line > lineCount || col < 1) return undefined
  const pos = sourceFile.compilerNode.getPositionOfLineAndCharacter(line - 1, col - 1)
  let node: Node | undefined = sourceFile.getDescendantAtPos(pos)
  while (node && !(Node.isArrayLiteralExpression(node) && node.getStart() === pos)) {
    if (node.getStart() !== pos) return undefined
    node = node.getParent()
  }
  return node && Node.isArrayLiteralExpression(node) ? node : undefined
}

/** Why `op` does not fit an array of `length`, or `null`. */
function checkIndices(op: ListItemOp, length: number): string | null {
  const inRange = (index: number, max: number) => Number.isInteger(index) && index >= 0 && index < max
  const distinct = (values: readonly number[]) => new Set(values).size === values.length
  switch (op.kind) {
    case 'reorder':
      return op.order.length === length && distinct(op.order) && op.order.every((i) => inRange(i, length))
        ? null
        : 'The new order does not name every item of this list exactly once.'
    case 'remove':
      return distinct(op.indices) && op.indices.every((i) => inRange(i, length)) ? null : 'An item to remove is not in this list.'
    case 'copy':
      return op.from.every((i) => inRange(i, length)) && inRange(op.at, length + 1) ? null : 'An item to copy is not in this list.'
    case 'insert': {
      const total = length + op.texts.length
      const ascending = op.at.every((at, k) => k === 0 || at > op.at[k - 1]!)
      return op.at.length === op.texts.length && ascending && op.at.every((i) => inRange(i, total))
        ? null
        : 'The positions to restore do not fit this list.'
    }
  }
}

const isBlank = (text: string) => /^[ \t\r\n]*$/.test(text)

/** Offset just past the next `\n` at or after `pos` (or the text's end). */
function lineEndAfter(text: string, pos: number): number {
  const newline = text.indexOf('\n', pos)
  return newline === -1 ? text.length : newline + 1
}

function lineStartOf(text: string, pos: number): number {
  return text.lastIndexOf('\n', pos - 1) + 1
}

/** Reads the literal's elements into movable pieces — see this module's doc for the two layouts. */
function readLayout(text: string, array: ArrayLiteralExpression): ArrayLayout {
  const open = array.getStart() + 1
  const close = array.getEnd() - 1
  const elements = array.getElements()
  const commas = new Map<number, number>() // element index → comma start
  let elementIndex = -1
  for (const child of elementList(array)) {
    if (child.getKind() === SyntaxKind.CommaToken) commas.set(elementIndex, child.getStart())
    else elementIndex += 1
  }

  const pieces = elements.map((element, i) => {
    const start = element.getStart()
    const end = element.getEnd()
    const leading = ts.getLeadingCommentRanges(text, element.getFullStart()) ?? []
    const ownStart = leading[0]?.pos ?? start
    const comma = commas.get(i)
    const afterComma = comma === undefined ? end : comma + 1
    const trailing = ts.getTrailingCommentRanges(text, afterComma) ?? []
    const trailEnd = trailing.length > 0 ? trailing[trailing.length - 1]!.end : afterComma
    return { start, end, ownStart, comma, afterComma, trailEnd }
  })

  const indentOf = (pos: number) => /^[ \t]*/.exec(text.slice(lineStartOf(text, pos)))![0]
  const bracketLineIndent = indentOf(array.getStart())
  if (pieces.length === 0) {
    const inner = text.slice(open, close)
    const block = inner.includes('\n')
    return {
      block,
      items: [],
      regionStart: open,
      regionEnd: open,
      gaps: [],
      trailingComma: true,
      emptyAt: block ? lineEndAfter(text, open) : open,
      indent: `${bracketLineIndent}  `,
      close,
    }
  }

  const block =
    pieces.every((piece, i) => text.slice(i === 0 ? open : pieces[i - 1]!.trailEnd, piece.ownStart).includes('\n')) &&
    text.slice(pieces[pieces.length - 1]!.trailEnd, close).includes('\n') &&
    pieces.every((piece) => isBlank(text.slice(piece.trailEnd, lineEndAfter(text, piece.trailEnd))))

  if (block) {
    const starts = pieces.map((piece) => lineStartOf(text, piece.ownStart))
    // A block runs to the next one, blank lines included; the last to the `]`
    // line, blank lines included, when nothing else sits between.
    const lastLineEnd = lineEndAfter(text, pieces[pieces.length - 1]!.trailEnd)
    const lastEnd = isBlank(text.slice(lastLineEnd, close)) ? lineStartOf(text, close) : lastLineEnd
    const ends = pieces.map((_, i) => (i < pieces.length - 1 ? starts[i + 1]! : Math.max(lastLineEnd, lastEnd)))
    const items = pieces.map((piece, i) => ({
      lead: text.slice(starts[i]!, piece.start),
      body: text.slice(piece.start, piece.end),
      mid: piece.comma === undefined ? '' : text.slice(piece.end, piece.comma),
      trail: text.slice(piece.afterComma, ends[i]!),
    }))
    return {
      block: true,
      items,
      regionStart: starts[0]!,
      regionEnd: ends[ends.length - 1]!,
      gaps: pieces.slice(1).map(() => ''),
      trailingComma: pieces[pieces.length - 1]!.comma !== undefined,
      emptyAt: starts[0]!,
      indent: indentOf(pieces[0]!.start),
      close,
    }
  }

  return {
    block: false,
    items: pieces.map((piece) => ({ lead: text.slice(piece.ownStart, piece.start), body: text.slice(piece.start, piece.end), mid: '', trail: '' })),
    regionStart: pieces[0]!.ownStart,
    regionEnd: pieces[pieces.length - 1]!.end,
    gaps: pieces.slice(1).map((piece, i) => text.slice(pieces[i]!.end, piece.ownStart)),
    trailingComma: false,
    emptyAt: open,
    indent: `${bracketLineIndent}  `,
    close,
  }
}

type PlannedItems = { ok: true; items: ItemText[] } | { ok: false; refusal: ListItemRefusal }

/** The elements, in their new order, the op leaves. */
function planItems(layout: ArrayLayout, elements: readonly Expression[], op: ListItemOp, text: string): PlannedItems {
  const items = layout.items
  switch (op.kind) {
    case 'reorder':
      return { ok: true, items: op.order.map((index) => items[index]!) }
    case 'remove': {
      const gone = new Set(op.indices)
      return { ok: true, items: items.filter((_, index) => !gone.has(index)) }
    }
    case 'copy': {
      const copies: ItemText[] = []
      const taken = new Set(op.key ? keyValues(elements, op.key) : [])
      for (const index of op.from) {
        const copy = copyItem(items[index]!, elements[index]!, op.key, taken, text)
        if (!copy.ok) return copy
        copies.push(copy.item)
      }
      return { ok: true, items: [...items.slice(0, op.at), ...copies, ...items.slice(op.at)] }
    }
    case 'insert': {
      const next = [...items]
      for (let k = 0; k < op.texts.length; k += 1) {
        const parsed = parseInsertText(op.texts[k]!, layout)
        if (!parsed.ok) return parsed
        next.splice(op.at[k]!, 0, parsed.item)
      }
      return { ok: true, items: next }
    }
  }
}

/** The single edit replacing the literal's elements with `items`. */
function renderEdit(layout: ArrayLayout, items: readonly ItemText[]): TextEdit {
  const empty = layout.items.length === 0
  const start = empty ? layout.emptyAt : layout.regionStart
  const end = empty ? layout.emptyAt : layout.regionEnd
  // Inline, all elements gone: the separators and a trailing comma go too (`['a',]` → `[]`).
  if (items.length === 0) return { start, end: layout.block ? end : layout.close, text: '' }
  const rendered = items.map((item, k) => renderItem(layout, item, k < items.length - 1 || layout.trailingComma))
  let out = rendered[0]!
  for (let k = 1; k < rendered.length; k += 1) {
    const gap = layout.gaps[k - 1] ?? (layout.block ? '' : (layout.gaps[0] ?? ', '))
    out += gap + rendered[k]!
  }
  return { start, end, text: out }
}

function renderItem(layout: ArrayLayout, item: ItemText, comma: boolean): string {
  if (!layout.block) return item.lead + item.body
  const trail = item.trail.endsWith('\n') ? item.trail : `${item.trail}\n`
  return `${item.lead}${item.body}${comma ? `${item.mid},` : ''}${trail}`
}

/** Every literal value `key.field` holds across the array — what a copy's key must not collide with. */
function keyValues(elements: readonly Expression[], key: ListRowKey): (string | number)[] {
  if (key.kind !== 'field') return []
  const values: (string | number)[] = []
  for (const element of elements) {
    const value = keyLiteral(element, key.field)
    if (value) values.push(value.value)
  }
  return values
}

/** The literal `field` holds in `element`, when it is a plain object literal whose `field` is a string or number. */
function keyLiteral(element: Node, field: string): { node: Node; value: string | number } | undefined {
  if (!Node.isObjectLiteralExpression(element)) return undefined
  const property = element.getProperty(field) ?? element.getProperty(`'${field}'`) ?? element.getProperty(`"${field}"`)
  if (!property || !Node.isPropertyAssignment(property)) return undefined
  const initializer = property.getInitializer()
  if (!initializer) return undefined
  if (Node.isStringLiteral(initializer) || Node.isNoSubstitutionTemplateLiteral(initializer)) {
    return { node: initializer, value: initializer.getLiteralValue() }
  }
  if (Node.isNumericLiteral(initializer)) return { node: initializer, value: initializer.getLiteralValue() }
  return undefined
}

type CopiedItem = { ok: true; item: ItemText } | { ok: false; refusal: ListItemRefusal }

/** A copy of `item`, its key field rewritten to a value no element holds. */
function copyItem(item: ItemText, element: Node, key: ListRowKey | undefined, taken: Set<string | number>, text: string): CopiedItem {
  if (!key || key.kind === 'none') return { ok: true, item: { ...item, trail: withoutTrailingBlankLines(item.trail) } }
  if (key.kind !== 'field') {
    return refuse('duplicate-key', 'This list’s rows are keyed by something Studio cannot make unique for a copy, so nothing was changed.')
  }
  const literal = keyLiteral(element, key.field)
  if (!literal) {
    return refuse(
      'duplicate-key',
      `Each row's React key is its item's \`${key.field}\`, and this item's \`${key.field}\` is not a plain value Studio can make unique for the copy. Add the item in code.`,
    )
  }
  const fresh = uniqueKey(literal.value, taken)
  taken.add(fresh)
  const token = text.slice(literal.node.getStart(), literal.node.getEnd())
  // A string gains its suffix INSIDE its own quotes, so its spelling (quote
  // style, escapes) stays the original's.
  const spelled =
    typeof fresh === 'number' ? String(fresh) : `${token.slice(0, -1)}${fresh.slice(String(literal.value).length)}${token.slice(-1)}`
  const offset = literal.node.getStart() - element.getStart()
  const body = item.body.slice(0, offset) + spelled + item.body.slice(offset + token.length)
  return { ok: true, item: { ...item, body, trail: withoutTrailingBlankLines(item.trail) } }
}

/** A block's trail without the blank lines after it — a copy does not repeat the spacing that followed its original. */
function withoutTrailingBlankLines(trail: string): string {
  const firstNewline = trail.indexOf('\n')
  return firstNewline === -1 ? trail : trail.slice(0, firstNewline + 1)
}

function uniqueKey(value: string | number, taken: ReadonlySet<string | number>): string | number {
  if (typeof value === 'number') {
    const numbers = [...taken].filter((v): v is number => typeof v === 'number')
    return Math.max(value, ...numbers) + 1
  }
  let candidate = `${value}-copy`
  for (let n = 2; taken.has(candidate); n += 1) candidate = `${value}-copy-${n}`
  return candidate
}

type ParsedInsert = { ok: true; item: ItemText } | { ok: false; refusal: ListItemRefusal }

/**
 * One `insert` text as an element of THIS array — shape-checked on its own
 * first (see this module's doc), then fitted to the array's layout: a text
 * taken out of a one-per-line array is a whole block and is written as one;
 * anything else is re-spelled for the layout it lands in.
 */
function parseInsertText(text: string, layout: ArrayLayout): ParsedInsert {
  const prefix = 'const __studioListItem = [\n'
  const suffix = '\n]\n'
  const scratch = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true })
  const sourceFile = scratch.createSourceFile('list-item-check.tsx', `${prefix}${text}${suffix}`)
  const notElement = refuse('not-data', 'What this undo would restore is not one item of this list, so nothing was changed.')
  if (scratch.getProgram().getSyntacticDiagnostics(sourceFile).length > 0) return notElement
  const statements = sourceFile.getStatements()
  const only = statements.length === 1 ? statements[0] : undefined
  if (!only || !Node.isVariableStatement(only) || only.getDeclarations().length !== 1) return notElement
  const init = only.getDeclarations()[0]!.getInitializer()
  if (!init || !Node.isArrayLiteralExpression(init) || init.getElements().length !== 1) return notElement
  const element = init.getElements()[0]!
  if (Node.isSpreadElement(element) || Node.isOmittedExpression(element)) return notElement
  if (computesOnLoad(element)) {
    return refuse(
      'not-data',
      'This row computes something when the file loads (a function call, for example), so Studio will not write it back from the editor. Use your editor’s undo or git to restore it.',
    )
  }
  const full = sourceFile.getFullText()
  const inner = prefix.length
  const start = element.getStart() - inner
  const end = element.getEnd() - inner
  const leading = ts.getLeadingCommentRanges(full, element.getFullStart()) ?? []
  const ownStart = (leading[0]?.pos ?? element.getStart()) - inner
  const body = text.slice(start, end)
  const comma = elementList(init).find((child) => child.getKind() === SyntaxKind.CommaToken)
  const afterBody = comma ? comma.getEnd() - inner : end
  if (!layout.block) return { ok: true, item: { lead: text.slice(Math.max(0, ownStart), start).trimStart(), body, mid: '', trail: '' } }
  const lead = text.slice(0, start)
  const isBlock = lead.length > 0 && /^[ \t]/.test(lead) && text.endsWith('\n')
  if (isBlock) {
    return { ok: true, item: { lead, body, mid: comma ? text.slice(end, comma.getStart() - inner) : '', trail: text.slice(Math.min(afterBody, text.length)) } }
  }
  const comments = text.slice(Math.max(0, ownStart), start).trim()
  return { ok: true, item: { lead: comments ? `${layout.indent}${comments}\n${layout.indent}` : layout.indent, body, mid: '', trail: '\n' } }
}

/** Kinds that run code when the expression is EVALUATED — i.e. when the file loads, for a module `const`. */
const COMPUTING_KINDS = new Set<SyntaxKind>([
  SyntaxKind.CallExpression,
  SyntaxKind.NewExpression,
  SyntaxKind.TaggedTemplateExpression,
  SyntaxKind.AwaitExpression,
  SyntaxKind.YieldExpression,
  SyntaxKind.DeleteExpression,
  SyntaxKind.ClassExpression,
  SyntaxKind.Decorator,
])

const ASSIGNMENT_OPERATORS = new Set<SyntaxKind>([
  SyntaxKind.EqualsToken,
  SyntaxKind.PlusEqualsToken,
  SyntaxKind.MinusEqualsToken,
  SyntaxKind.AsteriskEqualsToken,
  SyntaxKind.AsteriskAsteriskEqualsToken,
  SyntaxKind.SlashEqualsToken,
  SyntaxKind.PercentEqualsToken,
  SyntaxKind.LessThanLessThanEqualsToken,
  SyntaxKind.GreaterThanGreaterThanEqualsToken,
  SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  SyntaxKind.AmpersandEqualsToken,
  SyntaxKind.BarEqualsToken,
  SyntaxKind.CaretEqualsToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.AmpersandAmpersandEqualsToken,
  SyntaxKind.QuestionQuestionEqualsToken,
])

/** True when evaluating `element` runs anything — a function BODY is not evaluated, so what is inside one is not counted. */
function computesOnLoad(element: Node): boolean {
  let computes = false
  element.forEachDescendant((node, traversal) => {
    if (
      Node.isArrowFunction(node) ||
      Node.isFunctionExpression(node) ||
      Node.isMethodDeclaration(node) ||
      Node.isGetAccessorDeclaration(node) ||
      Node.isSetAccessorDeclaration(node)
    ) {
      traversal.skip()
      return
    }
    const kind = node.getKind()
    const increments =
      (Node.isPrefixUnaryExpression(node) || Node.isPostfixUnaryExpression(node)) &&
      (node.getOperatorToken() === SyntaxKind.PlusPlusToken || node.getOperatorToken() === SyntaxKind.MinusMinusToken)
    const assigns = Node.isBinaryExpression(node) && ASSIGNMENT_OPERATORS.has(node.getOperatorToken().getKind())
    if (COMPUTING_KINDS.has(kind) || increments || assigns) {
      computes = true
      traversal.stop()
    }
  })
  return computes || COMPUTING_KINDS.has(element.getKind())
}

/** The literal's elements and the commas between them, in order (its `SyntaxList` child). */
function elementList(array: ArrayLiteralExpression): Node[] {
  return array.getChildren().find((child) => child.getKind() === SyntaxKind.SyntaxList)?.getChildren() ?? []
}
