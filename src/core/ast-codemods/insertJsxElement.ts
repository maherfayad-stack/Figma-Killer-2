/**
 * insertJsxElement — the write behind "add a design-system component to the
 * canvas" on a studio-imported board. Writes a new JSX child into a parent
 * element in the user's source, together with the `import` that names it.
 *
 * WHY THIS EXISTS
 * ---------------
 * `struct-01` shipped `move` and `delete` and left `insert` as a blanket
 * refusal — a new node minted on the canvas carries a nanoid id, which can
 * never be written back, so accepting the gesture would have recreated the
 * silent no-op it had just removed. The missing half is exactly this codemod:
 * the editor does not mint a node at all, it asks the SOURCE to grow one and
 * then re-reads the file. The element the user sees afterwards is a real
 * parsed node with a real `rel:line:col` id, editable like any other, because
 * it came back through the same parse as everything else on the board.
 *
 * TWO WRITES, ONE TARGET
 * ----------------------
 * An insert touches two places in the file: the JSX child, and the import that
 * binds its tag name. That is not a violation of "exactly one honest target" —
 * they are two halves of one indivisible statement (a `<Button/>` with no
 * `Button` in scope is not valid code), and both are computed and spliced in
 * the same pass so the file is never left in the half-written state. What the
 * codemod refuses to do is guess: if the name is ALREADY bound in this file to
 * something that is not this import, it refuses (`binding-conflict`) rather
 * than shadowing the user's own symbol.
 *
 * BYTE-EXACTNESS, same standard as `moveJsxElement`/`deleteJsxElement`. The
 * AST only LOCATES; the write is a splice into the original bytes
 * (`jsxChildRange.ts`). Indentation is COPIED from a sibling wherever one
 * exists rather than assumed, so a file indented with tabs or four spaces
 * keeps its own style and no unrelated line is reformatted.
 */
import { Node, Project, type JsxElement, type JsxSelfClosingElement, type SourceFile } from 'ts-morph'
import { createProject, findJsxElementAtLocation, loadSourceFile } from './locateJsxElement'
import {
  resolveJsxChildRange,
  verbatimSourceText,
  writeVerbatimSource,
  type JsxChildRangeReason,
} from './jsxChildRange'

/** A prop written onto the new element. Only these three shapes have an unambiguous JSX spelling. */
export type InsertableJsxPropValue = string | number | boolean

export interface InsertJsxElementParams {
  file: string
  /** 1-based line/col of the PARENT element the child is added to (its tag-name start). */
  line: number
  col: number
  /** 1-based line/col of the sibling the new element is written against. Omit to append as the last child. */
  anchorLine?: number
  anchorCol?: number
  /** Which side of the anchor the new element lands on. Ignored without an anchor. */
  position?: 'before' | 'after'
  /** Tag name of the new element, e.g. `Button`. */
  name: string
  /** Props written onto the new element. Entries whose value is `undefined` are skipped. */
  props?: Record<string, InsertableJsxPropValue | undefined>
  /** Module the tag name is imported from, e.g. `@alm-design/design-system`. */
  importSpecifier: string
  /** Optional pre-existing project to reuse. */
  project?: Project
}

export type InsertJsxRefusalReason =
  | JsxChildRangeReason
  | 'not-a-container'
  | 'not-siblings'
  | 'binding-conflict'

export interface InsertJsxRefusal {
  reason: InsertJsxRefusalReason
  /** Human-readable, suitable for a toast. */
  message: string
}

export type InsertJsxElementResult = { ok: true } | { ok: false; refusal: InsertJsxRefusal }

export function insertJsxElement(params: InsertJsxElementParams): InsertJsxElementResult {
  const { file, line, col, name, importSpecifier } = params
  const project = params.project ?? createProject()
  const sourceFile = loadSourceFile(project, file)

  const parentOpening = findJsxElementAtLocation(sourceFile, line, col)
  if (!parentOpening) {
    return refuse(
      'not-found',
      `No JSX element is written at line ${line}, column ${col} any more — the file changed since the canvas last read it. Reload and try again.`,
    )
  }

  const binding = conflictingBinding(sourceFile, name, importSpecifier)
  if (binding) {
    return refuse(
      'binding-conflict',
      `This file already uses the name "${name}" for something else (${binding}), so adding the component here would shadow it. Rename one of them in the file first.`,
    )
  }

  const verbatim = verbatimSourceText(sourceFile, file)
  if (verbatim === null) {
    return refuse(
      'stale-source',
      'This file changed on disk since the canvas last read it. Reload the project and try again.',
    )
  }

  const jsx = renderJsxElement(name, params.props ?? {})
  const placement = resolvePlacement(sourceFile, verbatim, parentOpening, params, jsx)
  if (!placement.ok) return placement

  const importEdit = resolveImportEdit(sourceFile, verbatim, name, importSpecifier)

  // Both splices are computed against the ORIGINAL text, so the later one is
  // applied first — otherwise the earlier insert shifts the offset the later
  // one was measured at. Imports live at the top of a file and the JSX below
  // them, but the codemod does not rely on that: it sorts.
  const edits = [placement.edit, ...(importEdit ? [importEdit] : [])].sort((a, b) => b.start - a.start)
  let text = verbatim
  for (const edit of edits) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end)

  writeVerbatimSource(sourceFile, file, text)
  return { ok: true }
}

/** A byte range in the original text and what replaces it. An insert is a range of length zero. */
interface TextEdit {
  start: number
  end: number
  text: string
}

type PlacementResult = { ok: true; edit: TextEdit } | { ok: false; refusal: InsertJsxRefusal }

function refuse(reason: InsertJsxRefusalReason, message: string): { ok: false; refusal: InsertJsxRefusal } {
  return { ok: false, refusal: { reason, message } }
}

/**
 * Where the new element's bytes go, and with what surrounding whitespace.
 *
 * Four shapes, and the difference between them is entirely about whitespace
 * the user already wrote:
 *
 *  - **Against a whole-line anchor** — the new element gets its own line, at
 *    the anchor's own indentation.
 *  - **Against an inline anchor** (`<div><a/><b/></div>`) — the new element
 *    joins the line, separated by a single space.
 *  - **Appended to a parent that has children** — same two cases, resolved
 *    from the last child.
 *  - **Appended to an EMPTY parent** — the only case that rewrites existing
 *    bytes, and only ever whitespace: the run between `>` and `</` is replaced
 *    with a properly indented line. A self-closing parent (`<div />`) is
 *    reopened into a paired tag, which is the same idea one step further.
 */
function resolvePlacement(
  sourceFile: SourceFile,
  text: string,
  parentOpening: ReturnType<typeof findJsxElementAtLocation> & object,
  params: InsertJsxElementParams,
  jsx: string,
): PlacementResult {
  const parentIndent = lineIndentAt(text, parentOpening.getStart())

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
    const childIndent = parentIndent + indentUnit(text)
    return {
      ok: true,
      edit: {
        start: beforeSlash,
        end,
        text: `>\n${childIndent}${jsx}\n${parentIndent}</${tagName}>`,
      },
    }
  }

  const parentElement = parentOpening.getParent()
  if (!parentElement || !Node.isJsxElement(parentElement)) {
    return refuse('not-a-container', 'Studio could not resolve this element to something that can hold children.')
  }

  const anchorEdit = resolveAnchorPlacement(sourceFile, parentElement, params, jsx)
  if (anchorEdit) return anchorEdit

  const children = elementChildren(parentElement)
  const last = children[children.length - 1]
  if (last) {
    const range = resolveJsxChildRange(sourceFile, ...tagLocation(sourceFile, last))
    if (range.ok) return { ok: true, edit: insertBeside(range.range, 'after', jsx, text) }
  }

  // Empty parent: replace the whitespace-only run between the tags.
  const innerStart = parentOpening.getEnd()
  const innerEnd = parentElement.getClosingElement().getStart()
  const childIndent = parentIndent + indentUnit(text)
  const inner = text.slice(innerStart, innerEnd)
  if (inner.trim() !== '') {
    // Children exist but none of them resolved to a plain element (an
    // expression child, a bare text node). Append after them without touching
    // what is already there.
    return { ok: true, edit: { start: innerEnd, end: innerEnd, text: `\n${childIndent}${jsx}\n${parentIndent}` } }
  }
  return {
    ok: true,
    edit: { start: innerStart, end: innerEnd, text: `\n${childIndent}${jsx}\n${parentIndent}` },
  }
}

/** Placement against an explicit sibling anchor, or `null` when the caller gave none. */
function resolveAnchorPlacement(
  sourceFile: SourceFile,
  parentElement: JsxElement,
  params: InsertJsxElementParams,
  jsx: string,
): PlacementResult | null {
  const { anchorLine, anchorCol } = params
  if (anchorLine === undefined || anchorCol === undefined) return null

  const anchor = resolveJsxChildRange(sourceFile, anchorLine, anchorCol)
  if (!anchor.ok) return refuse(anchor.reason, anchor.message)
  if (anchor.range.parent !== parentElement) {
    return refuse(
      'not-siblings',
      'The element this would be written next to is not a child of the container it was dropped into, so there is no single place in the file to write it.',
    )
  }
  return {
    ok: true,
    edit: insertBeside(anchor.range, params.position ?? 'after', jsx, sourceFile.getFullText()),
  }
}

/** The zero-length edit that puts `jsx` immediately before or after an existing child's owned range. */
function insertBeside(
  range: { start: number; end: number; wholeLine: boolean },
  position: 'before' | 'after',
  jsx: string,
  text: string,
): TextEdit {
  if (range.wholeLine) {
    // `start` is the line start and `end` is one past the newline, so a whole
    // line (indentation + element + newline) inserted at either point lands
    // exactly where a hand-written sibling would.
    const indent = lineIndentAt(text, range.start + countLeadingWhitespace(text, range.start))
    const at = position === 'before' ? range.start : range.end
    return { start: at, end: at, text: `${indent}${jsx}\n` }
  }
  const at = position === 'before' ? range.start : range.end
  return { start: at, end: at, text: position === 'before' ? `${jsx} ` : ` ${jsx}` }
}

/** The element children of a JSX element, in source order — whitespace and expression children excluded. */
function elementChildren(element: JsxElement): (JsxElement | JsxSelfClosingElement)[] {
  const children: (JsxElement | JsxSelfClosingElement)[] = []
  for (const child of element.getJsxChildren()) {
    if (Node.isJsxElement(child) || Node.isJsxSelfClosingElement(child)) children.push(child)
  }
  return children
}

/** The 1-based `line, col` of a JSX element's tag name — the coordinate `resolveJsxChildRange` speaks. */
function tagLocation(sourceFile: SourceFile, element: JsxElement | JsxSelfClosingElement): [number, number] {
  const opening = Node.isJsxElement(element) ? element.getOpeningElement() : element
  const { line, column } = sourceFile.getLineAndColumnAtPos(opening.getTagNameNode().getStart())
  return [line, column]
}

/** `<Name a="1" b={2} c />` — the JSX spelling of a tag plus its literal props. */
function renderJsxElement(name: string, props: Record<string, InsertableJsxPropValue | undefined>): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined) continue
    if (typeof value === 'boolean') {
      // `<Button disabled />` for true; a false prop is simply not written,
      // which is what the absence of the attribute already means.
      if (value) parts.push(key)
      continue
    }
    parts.push(typeof value === 'number' ? `${key}={${value}}` : `${key}=${JSON.stringify(value)}`)
  }
  return parts.length > 0 ? `<${name} ${parts.join(' ')} />` : `<${name} />`
}

/**
 * The edit that puts `name` in scope from `specifier`, or `null` when it
 * already is.
 *
 * Three cases, cheapest first: the import declaration exists and already names
 * the binding (nothing to do); it exists and gains one more named import; it
 * does not exist and a whole line is added after the last import. The quote
 * character is copied from an existing import so a file written with double
 * quotes does not acquire a single-quoted line.
 */
function resolveImportEdit(
  sourceFile: SourceFile,
  text: string,
  name: string,
  specifier: string,
): TextEdit | null {
  const declarations = sourceFile.getImportDeclarations()
  const existing = declarations.find((d) => d.getModuleSpecifierValue() === specifier)

  if (existing) {
    const named = existing.getNamedImports()
    if (named.some((n) => (n.getAliasNode() ?? n.getNameNode()).getText() === name)) return null
    const lastNamed = named[named.length - 1]
    if (lastNamed) {
      const at = lastNamed.getEnd()
      return { start: at, end: at, text: `, ${name}` }
    }
    // A default- or namespace-only import: `import DS from 'x'` gains `, { name }`.
    const defaultImport = existing.getDefaultImport() ?? existing.getNamespaceImport()
    if (defaultImport) {
      const at = defaultImport.getEnd()
      return { start: at, end: at, text: `, { ${name} }` }
    }
    // A bare side-effect import (`import 'x'`) — leave it alone and add a
    // second, explicit declaration below rather than rewriting the user's line.
  }

  const quote = importQuoteChar(declarations)
  const line = `import { ${name} } from ${quote}${specifier}${quote}\n`
  const lastDeclaration = declarations[declarations.length - 1]
  if (!lastDeclaration) return { start: 0, end: 0, text: line }

  // Start of the line after the last import, so the new line joins the block.
  const newlineAfter = text.indexOf('\n', lastDeclaration.getEnd())
  const at = newlineAfter === -1 ? text.length : newlineAfter + 1
  return { start: at, end: at, text: line }
}

/** The quote character the file's existing imports use — `'` when there are none to copy. */
function importQuoteChar(declarations: readonly { getModuleSpecifier: () => Node }[]): string {
  const first = declarations[0]
  if (!first) return "'"
  return first.getModuleSpecifier().getText().startsWith('"') ? '"' : "'"
}

/**
 * How `name` is already bound in this file, when that binding is NOT the
 * import this insert wants — a local `function Button()`, a `const Button =`,
 * or an import of the same name from a different module. `undefined` when the
 * name is free, or already bound to exactly the right import.
 *
 * Reads declarations only, never references: the question is what the name
 * MEANS in this file, and a shadowing insert is the one outcome that would
 * silently change an element the user never touched.
 */
function conflictingBinding(sourceFile: SourceFile, name: string, specifier: string): string | undefined {
  for (const declaration of sourceFile.getImportDeclarations()) {
    const from = declaration.getModuleSpecifierValue()
    const names = [
      declaration.getDefaultImport()?.getText(),
      declaration.getNamespaceImport()?.getText(),
      ...declaration.getNamedImports().map((n) => (n.getAliasNode() ?? n.getNameNode()).getText()),
    ]
    if (!names.includes(name)) continue
    if (from === specifier) return undefined
    return `it is imported from "${from}"`
  }
  for (const fn of sourceFile.getFunctions()) {
    if (fn.getName() === name) return 'a function declared here'
  }
  for (const statement of sourceFile.getVariableDeclarations()) {
    if (statement.getName() === name) return 'a variable declared here'
  }
  for (const cls of sourceFile.getClasses()) {
    if (cls.getName() === name) return 'a class declared here'
  }
  return undefined
}

/** The leading whitespace of the line `pos` sits on. */
function lineIndentAt(text: string, pos: number): string {
  const lineStart = text.lastIndexOf('\n', pos - 1) + 1
  return text.slice(lineStart, lineStart + countLeadingWhitespace(text, lineStart))
}

function countLeadingWhitespace(text: string, from: number): number {
  let i = from
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i += 1
  return i - from
}

/**
 * One level of indentation, as this file writes it — a tab when the file is
 * tab-indented, otherwise the smallest non-zero space indent it uses (falling
 * back to two spaces). Copied rather than assumed so an insert never mixes a
 * second indentation style into a file.
 */
function indentUnit(text: string): string {
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
function trimTrailingBlankBack(text: string, pos: number): number {
  let i = pos
  while (i > 0 && (text[i - 1] === ' ' || text[i - 1] === '\t')) i -= 1
  return i
}
