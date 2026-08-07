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
 * COMPONENTS AND INTRINSIC TAGS
 * -----------------------------
 * `importSpecifier` is what distinguishes the two things this codemod can
 * write, and the distinction is JSX's own: React reads `<div>` as the string
 * `"div"` and `<Button>` as the in-scope identifier `Button`.
 *
 *   - **With** an `importSpecifier`, `name` is a COMPONENT — the import above
 *     is written, and the binding-conflict check applies.
 *   - **Without** one, `name` is an INTRINSIC tag (`div`, `span`, `button`).
 *     There is nothing to import and no binding to conflict with, so both of
 *     those steps are skipped.
 *
 * The intrinsic path is not a convenience: without it there was no way to
 * write a layout element at all, so an agent composing a screen could add
 * design-system components but not the `<div>`s that arrange them — it could
 * create a page and then not build anything in it. The name is validated
 * (`isSafeIntrinsicTagName`) rather than trusted, because "no import" would
 * otherwise make a MISSPELLED component name (`<Buton />`) look like a
 * perfectly legal unknown element instead of the error it is, and because a
 * tag written into source runs the moment the user starts their dev server —
 * Studio's "parse, never execute" invariant protects the canvas from what it
 * READS, not the user's project from what Studio WRITES.
 *
 * BYTE-EXACTNESS, same standard as `moveJsxElement`/`deleteJsxElement`. The
 * AST only LOCATES; the write is a splice into the original bytes
 * (`jsxChildRange.ts`). Indentation is COPIED from a sibling wherever one
 * exists rather than assumed, so a file indented with tabs or four spaces
 * keeps its own style and no unrelated line is reformatted.
 */
import { Node, Project, type JsxElement, type JsxSelfClosingElement, type SourceFile } from 'ts-morph'
import { isSafeIntrinsicTagName, VOID_HTML_ELEMENTS } from '@core/utils/htmlTags'
import { createProject, findJsxElementAtLocation, loadSourceFile } from './locateJsxElement'
import {
  resolveJsxChildRange,
  verbatimSourceText,
  writeVerbatimSource,
  type JsxChildRangeReason,
} from './jsxChildRange'

/** A prop written onto the new element. Only these three shapes have an unambiguous JSX spelling. */
export type InsertableJsxPropValue = string | number | boolean

/**
 * One element in a subtree an insert writes. Identical in shape to the insert
 * itself minus the placement fields, and recursive through `children`.
 */
export interface InsertJsxNode {
  /** A component (`Button`) with an `importSpecifier`, an intrinsic tag (`div`) without one. */
  name: string
  props?: Record<string, InsertableJsxPropValue | undefined>
  importSpecifier?: string
  children?: InsertJsxChildren
}

/**
 * An element's content: literal text, or a list of nested elements.
 *
 * Text and elements are deliberately EXCLUSIVE rather than an interleaved
 * list. A leaf carries a label; a container carries elements. Mixed content
 * (`<p>Hello <b>you</b></p>`) is the one JSX shape whose text nodes have no
 * stable identity for the parser to hand back an editable node id for — the
 * same reason `setJsxText` refuses a mixed-content target
 * (`JsxTextTargetError`). Allowing it here would let an insert manufacture
 * source this pipeline cannot then edit.
 */
export type InsertJsxChildren = string | InsertJsxNode[]

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
  /** Tag name of the new element — a component (`Button`) with an `importSpecifier`, an intrinsic tag (`div`) without one. */
  name: string
  /** Props written onto the new element. Entries whose value is `undefined` are skipped. */
  props?: Record<string, InsertableJsxPropValue | undefined>
  /**
   * Module the tag name is imported from, e.g. `@alm-design/design-system`.
   * Omit to write an intrinsic HTML tag, which needs no import.
   */
  importSpecifier?: string
  /**
   * The new element's content — literal text (`<span>Sign in</span>`), or a
   * nested subtree written in the SAME call. Omit for an empty element.
   *
   * ## Why a whole subtree, and not one element per call
   *
   * An insert changes the file's line count, which invalidates every node id
   * decoded before it. Composing a screen one element per call therefore costs
   * a re-parse per element, and a ~30-node mobile screen becomes ~30 sequential
   * round trips — measured at over twenty minutes for a single screen, which is
   * what made "build five screens" not merely slow but impractical.
   *
   * Rendering the whole subtree into one splice removes the dependency
   * entirely: no intermediate node needs an id, because nothing reads one
   * between the levels. One call, one write, one re-parse.
   *
   * An expression child (`{count}`) is still not expressible — it would need a
   * scope this codemod cannot verify — and text is refused on a void element.
   */
  children?: InsertJsxChildren
  /** Optional pre-existing project to reuse. */
  project?: Project
}

export type InsertJsxRefusalReason =
  | JsxChildRangeReason
  | 'not-a-container'
  | 'not-siblings'
  | 'binding-conflict'
  | 'unsafe-tag'
  | 'void-element-children'

export interface InsertJsxRefusal {
  reason: InsertJsxRefusalReason
  /** Human-readable, suitable for a toast. */
  message: string
}

export type InsertJsxElementResult = { ok: true } | { ok: false; refusal: InsertJsxRefusal }

export function insertJsxElement(params: InsertJsxElementParams): InsertJsxElementResult {
  const { file, line, col, name, importSpecifier, children } = params
  const project = params.project ?? createProject()
  const sourceFile = loadSourceFile(project, file)

  // Validated for the WHOLE subtree before a single byte is written — a
  // refusal three levels down must leave the file untouched, not half-built.
  const invalid = validateSubtree({ name, props: params.props, importSpecifier, children })
  if (invalid) return invalid

  const parentOpening = findJsxElementAtLocation(sourceFile, line, col)
  if (!parentOpening) {
    return refuse(
      'not-found',
      `No JSX element is written at line ${line}, column ${col} any more — the file changed since the canvas last read it. Reload and try again.`,
    )
  }

  // Only a component name can collide: an intrinsic tag is a string to JSX,
  // never a reference to a binding, so a local `const div = …` is irrelevant
  // to `<div />` and refusing on it would be a false positive. Checked for
  // every component in the subtree, not just the root.
  const imports = collectSubtreeImports({ name, props: params.props, importSpecifier, children })
  for (const [componentName, specifier] of imports) {
    const binding = conflictingBinding(sourceFile, componentName, specifier)
    if (binding) {
      return refuse(
        'binding-conflict',
        `This file already uses the name "${componentName}" for something else (${binding}), so adding the component here would shadow it. Rename one of them in the file first.`,
      )
    }
  }

  const verbatim = verbatimSourceText(sourceFile, file)
  if (verbatim === null) {
    return refuse(
      'stale-source',
      'This file changed on disk since the canvas last read it. Reload the project and try again.',
    )
  }

  const placement = resolvePlacement(sourceFile, verbatim, parentOpening, params, (indent, unit) =>
    indentBlock(renderJsxNode({ name, props: params.props, importSpecifier, children }, unit), indent),
  )
  if (!placement.ok) return placement

  const importEdits = resolveImportEdits(sourceFile, verbatim, imports)

  // Every splice is computed against the ORIGINAL text, so the later ones are
  // applied first — otherwise an earlier insert shifts the offset a later one
  // was measured at. Imports live at the top of a file and the JSX below them,
  // but the codemod does not rely on that: it sorts.
  const edits = [placement.edit, ...importEdits].sort((a, b) => b.start - a.start)
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
  render: RenderJsx,
): PlacementResult {
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

  const anchorEdit = resolveAnchorPlacement(sourceFile, parentElement, params, render, unit)
  if (anchorEdit) return anchorEdit

  const children = elementChildren(parentElement)
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
  render: RenderJsx,
  unit: string,
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
    edit: insertBeside(anchor.range, params.position ?? 'after', render, unit, sourceFile.getFullText()),
  }
}

/** The zero-length edit that puts the rendered subtree immediately before or after an existing child's owned range. */
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

/**
 * Renders the subtree at a known base indentation. `indent` is the whitespace
 * the FIRST line will sit at (the caller writes that prefix itself, so the
 * returned string's first line is bare); `unit` is one indentation step, copied
 * from the file.
 */
type RenderJsx = (indent: string, unit: string) => string

/** Prefix every line after the first with `indent`, aligning a rendered block under its placement. */
function indentBlock(block: string, indent: string): string {
  return indent.length === 0 ? block : block.split('\n').join(`\n${indent}`)
}

/**
 * `<Name a="1" b={2} c />` — a tag plus its literal props; `<Name>text</Name>`
 * for a text child; and a multi-line block for a nested subtree.
 *
 * Relative indentation only: nested lines are indented by `unit` per level
 * from column zero, and `indentBlock` shifts the whole block to wherever
 * `resolvePlacement` decided it goes. That split is what lets placement and
 * rendering stay independent — the renderer never needs to know the parent's
 * column, and placement never needs to know the subtree's shape.
 *
 * Exported for `insertJsxIntoSlotProp.ts` (E2.4), which writes the identical
 * subtree shape into a component PROP instead of a JSX child list and has no
 * reason to re-implement this rendering.
 */
export function renderJsxNode(node: InsertJsxNode, unit: string): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(node.props ?? {})) {
    if (value === undefined) continue
    if (typeof value === 'boolean') {
      // `<Button disabled />` for true; a false prop is simply not written,
      // which is what the absence of the attribute already means.
      if (value) parts.push(key)
      continue
    }
    parts.push(typeof value === 'number' ? `${key}={${value}}` : `${key}=${JSON.stringify(value)}`)
  }
  const attrs = parts.length > 0 ? ` ${parts.join(' ')}` : ''
  const { name, children } = node

  if (children === undefined) return `<${name}${attrs} />`
  if (typeof children === 'string') return `<${name}${attrs}>${escapeJsxText(children)}</${name}>`
  // An empty array is an explicitly childless element — same output as no
  // `children` at all, rather than an empty paired tag nothing needs.
  if (children.length === 0) return `<${name}${attrs} />`

  const inner = children.map((child) => `${unit}${indentBlock(renderJsxNode(child, unit), unit)}`)
  return [`<${name}${attrs}>`, ...inner, `</${name}>`].join('\n')
}

/** Depth-first walk of a subtree, root included. */
function* walkSubtree(node: InsertJsxNode): Generator<InsertJsxNode> {
  yield node
  const { children } = node
  if (children === undefined || typeof children === 'string') return
  for (const child of children) yield* walkSubtree(child)
}

/**
 * Every `(componentName, importSpecifier)` the subtree needs in scope,
 * deduplicated. Intrinsic tags contribute nothing.
 *
 * Exported for `insertJsxIntoSlotProp.ts` — a slot fill needs the identical
 * "what imports does this subtree require" answer.
 */
export function collectSubtreeImports(root: InsertJsxNode): Map<string, string> {
  const required = new Map<string, string>()
  for (const node of walkSubtree(root)) {
    if (node.importSpecifier !== undefined) required.set(node.name, node.importSpecifier)
  }
  return required
}

/**
 * The first refusal anywhere in the subtree, or `undefined` when all of it is
 * writable. Runs before any byte is written so a bad grandchild cannot leave a
 * half-built element behind.
 *
 * Exported for `insertJsxIntoSlotProp.ts` — the tag-name/void-element rules
 * are exactly the same for a subtree written into a prop as for one written
 * into a child list; only the PLACEMENT differs between the two codemods.
 */
export function validateSubtree(root: InsertJsxNode): { ok: false; refusal: InsertJsxRefusal } | undefined {
  for (const node of walkSubtree(root)) {
    const { name, importSpecifier, children } = node

    // An intrinsic tag is the no-import case, so its name gets no validation
    // from an import resolving or failing to resolve — it has to be checked
    // here or not at all. See this module's "COMPONENTS AND INTRINSIC TAGS".
    if (importSpecifier === undefined && !isSafeIntrinsicTagName(name)) {
      return refuse(
        'unsafe-tag',
        /^[A-Z]/.test(name)
          ? `"${name}" starts with a capital letter, so JSX reads it as a component, not an HTML tag — pass importSpecifier to say where it is imported from.`
          : `"${name}" is not a tag Studio will write: it must be a well-formed HTML element name and must not be one that executes script or loads external resources.`,
      )
    }

    const hasContent = children !== undefined && (typeof children === 'string' || children.length > 0)
    if (hasContent && VOID_HTML_ELEMENTS.has(name.toLowerCase())) {
      return refuse(
        'void-element-children',
        `<${name}> is a void element and cannot hold children, so there is nowhere to write this content.`,
      )
    }
  }
  return undefined
}

/**
 * Make `text` safe to sit between two JSX tags.
 *
 * Only four characters can leave JSX text mode, and each is escaped as the
 * HTML entity React renders back to the original character, so the element's
 * rendered text is exactly what the caller asked for:
 *   - `<` would open a tag, `>` is invalid in JSX text
 *   - `{` `}` would open an expression container
 * A newline is not escaped but IS rejected upstream of nothing — it would
 * merely reflow, which JSX collapses to a single space, so it is left alone.
 */
function escapeJsxText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\{/g, '&#123;')
    .replace(/\}/g, '&#125;')
}

/**
 * The edits that put every `(name → specifier)` in `required` in scope.
 *
 * Per specifier, three cases, cheapest first: the import declaration exists and
 * already names the binding (nothing to do); it exists and gains one more named
 * import; it does not exist and a whole line is added after the last import.
 * The quote character is copied from an existing import so a file written with
 * double quotes does not acquire a single-quoted line.
 *
 * Every returned edit is measured against the ORIGINAL text and the caller
 * applies them in descending-offset order. That is why all the brand-new
 * declarations are emitted as ONE edit at a single offset rather than one edit
 * each: several edits sharing an identical `start` would be applied in an
 * unspecified relative order, and — being zero-length inserts at the same point
 * — could interleave. Grouping them keeps the written order deterministic
 * (specifier insertion order, which is the subtree's own depth-first order).
 */
function resolveImportEdits(
  sourceFile: SourceFile,
  text: string,
  required: ReadonlyMap<string, string>,
): TextEdit[] {
  if (required.size === 0) return []

  const declarations = sourceFile.getImportDeclarations()
  const quote = importQuoteChar(declarations)
  const edits: TextEdit[] = []
  /** Specifier → the names it must newly declare, in first-seen order. */
  const newDeclarations = new Map<string, string[]>()

  for (const [name, specifier] of required) {
    const existing = declarations.find((d) => d.getModuleSpecifierValue() === specifier)
    if (existing) {
      const named = existing.getNamedImports()
      if (named.some((n) => (n.getAliasNode() ?? n.getNameNode()).getText() === name)) continue
      const lastNamed = named[named.length - 1]
      if (lastNamed) {
        const at = lastNamed.getEnd()
        edits.push({ start: at, end: at, text: `, ${name}` })
        continue
      }
      // A default- or namespace-only import: `import DS from 'x'` gains `, { name }`.
      const defaultImport = existing.getDefaultImport() ?? existing.getNamespaceImport()
      if (defaultImport) {
        const at = defaultImport.getEnd()
        edits.push({ start: at, end: at, text: `, { ${name} }` })
        continue
      }
      // A bare side-effect import (`import 'x'`) — leave it alone and add a
      // second, explicit declaration below rather than rewriting the user's line.
    }
    const names = newDeclarations.get(specifier)
    if (names) names.push(name)
    else newDeclarations.set(specifier, [name])
  }

  if (newDeclarations.size > 0) {
    const lines = [...newDeclarations]
      .map(([specifier, names]) => `import { ${names.join(', ')} } from ${quote}${specifier}${quote}\n`)
      .join('')
    const lastDeclaration = declarations[declarations.length - 1]
    if (!lastDeclaration) {
      edits.push({ start: 0, end: 0, text: lines })
    } else {
      // Start of the line after the last import, so the new lines join the block.
      const newlineAfter = text.indexOf('\n', lastDeclaration.getEnd())
      const at = newlineAfter === -1 ? text.length : newlineAfter + 1
      edits.push({ start: at, end: at, text: lines })
    }
  }

  return edits
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
 *
 * Exported for `insertJsxIntoSlotProp.ts` — filling a slot with a component
 * asks the identical "would this shadow something already in scope" question.
 */
export function conflictingBinding(sourceFile: SourceFile, name: string, specifier: string): string | undefined {
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
 *
 * Exported for `insertJsxIntoSlotProp.ts` — a slot fill's nested children
 * should indent in the file's own style too.
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
function trimTrailingBlankBack(text: string, pos: number): number {
  let i = pos
  while (i > 0 && (text[i - 1] === ' ' || text[i - 1] === '\t')) i -= 1
  return i
}
