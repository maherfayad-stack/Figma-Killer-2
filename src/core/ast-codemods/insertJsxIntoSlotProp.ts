/**
 * insertJsxIntoSlotProp — E2.4, the write behind "put something in an empty
 * (or already-filled) slot" on a studio-imported page-as-component
 * (`STUDIO-FIGMA-PARITY-PLAN.md` §8, Track E). A sibling of `setJsxProp`, not
 * a widening of it — `setJsxProp`'s `buildInitializerText` exists to write
 * SCALARS safely (a string/number/boolean attribute) and must not learn to
 * emit JSX. This module owns the JSX-valued half of the same question:
 * "what does the call site's PROP attribute say".
 *
 * THE FOUR SHAPES A SLOT PROP CAN BE IN, AND WHAT EACH ONE WRITES
 * -----------------------------------------------------------------
 *   - **Absent** — the call site never passed this prop at all
 *     (`<Sheet title="Where to?" />`, no `header`). `addAttribute` writes
 *     `header={<NewThing/>}` — a single JSX value, the exact shape
 *     `captureSlotProps` already reads with zero parser change (pre-E2.3).
 *   - **A single element/self-closing element** (`header={<Icon/>}`) —
 *     WRAPS both the existing value and the new one in a fragment:
 *     `header={<><Icon/><NewThing/></>}`. This is the shape E2.3's parser
 *     change exists for: a `JsxFragment`-valued slot round-trips into a
 *     `studio.slot` container whose id is the fragment's OWN location, not a
 *     minted one — see that module's handoff for why a minted id would make
 *     `refuseMintedNodeInsert` kill this exact insert and blame the wrong
 *     thing.
 *   - **Already a fragment** (`header={<><Icon/><Label/></>}`, e.g. from a
 *     PREVIOUS call to this same codemod) — appends the new element as one
 *     more fragment child, alongside the ones already there.
 *   - **Anything else** (an identifier, a call, a ternary, a plain string,
 *     a valueless shorthand, an empty expression container) — refuses
 *     `slot-ambiguous`. There is no way to tell from source text alone
 *     whether that expression currently means "nothing" or is a real
 *     binding the insert would silently blow away, so this codemod never
 *     guesses. Same posture `setJsxStyle`/`setJsxClassName` already take
 *     for a `style`/`className` shape they don't recognize.
 *
 * `propName === 'children'` IS NOT AN ATTRIBUTE AT ALL
 * ------------------------------------------------------
 * A component's default slot is its ordinary JSX child list, not a prop —
 * `<Sheet><Icon/></Sheet>`, never `<Sheet children={<Icon/>} />`. So this one
 * case delegates the WHOLE call straight to `insertJsxElement`, which already
 * knows how to place a subtree among a container's real children (including
 * against an anchor sibling) and already writes a whole subtree per call —
 * one element per call was measured at over twenty minutes for a single
 * 30-node screen, and that budget applies here too.
 *
 * REUSE, NOT A PARALLEL IMPLEMENTATION
 * --------------------------------------
 * The subtree shape (`InsertJsxNode`), its renderer (`renderJsxNode`), its
 * validation (`validateSubtree` — unsafe tag names, a void element asked to
 * hold children), its import bookkeeping (`collectSubtreeImports`), and its
 * binding-conflict check (`conflictingBinding`) are ALL `insertJsxElement`'s
 * own exports, imported here rather than re-implemented. Only the PLACEMENT
 * differs between the two codemods — a child position vs. an attribute value
 * — so only placement gets its own code.
 *
 * NOT BYTE-SPLICE, ON PURPOSE
 * ------------------------------
 * `insertJsxElement`/`moveJsxElement`/`deleteJsxElement` promise byte-exact
 * output because a structural CHILD-LIST edit sits among siblings whose own
 * formatting must not move. Writing an ATTRIBUTE's value has no such
 * neighbour to disturb — the same reasoning `setJsxProp`/`setJsxStyle`/
 * `setJsxClassName` already rely on — so this codemod uses ts-morph's own
 * structural manipulation (`addAttribute`/`setInitializer`/`addNamedImport`)
 * throughout, for both the attribute and the imports it needs. The one
 * exception is the `children` delegation above, which inherits
 * `insertJsxElement`'s byte-splice guarantee because IT is doing the write.
 *
 * A FILLED FRAGMENT IS RE-INDENTED, NOT BYTE-PRESERVED
 * --------------------------------------------------------
 * Every existing fragment child's own JSX text moves verbatim (`.getText()`,
 * never re-parsed or rewritten) but the WHITESPACE around it is rebuilt from
 * scratch at the attribute's own indentation — writing a new child into a
 * fragment inherently changes it, so there is no "original formatting" left
 * to preserve at the fragment's outer level the way a sibling in a child list
 * has. This is deliberately not held to the byte-exactness standard those
 * structural codemods are.
 */
import { Node, QuoteKind, type JsxAttribute, type JsxFragment, type Project, type SourceFile } from 'ts-morph'
import { createProject, findJsxElementAtLocation, loadSourceFile } from './locateJsxElement'
import {
  collectSubtreeImports,
  conflictingBinding,
  indentUnit,
  insertJsxElement,
  renderJsxNode,
  validateSubtree,
  type InsertJsxChildren,
  type InsertJsxRefusalReason,
  type InsertableJsxPropValue,
} from './insertJsxElement'

/** The subtree written into the slot — identical shape to `insertJsxElement`'s own `InsertJsxNode`. */
export interface InsertJsxIntoSlotPropNode {
  name: string
  props?: Record<string, InsertableJsxPropValue | undefined>
  importSpecifier?: string
  children?: InsertJsxChildren
}

export interface InsertJsxIntoSlotPropParams {
  file: string
  /** 1-based line/col of the CALL SITE element's tag-name start — the same location convention every codemod in this module shares. */
  line: number
  col: number
  /**
   * The slot's prop name (`'header'`) — or the literal string `'children'`,
   * which delegates this whole call to `insertJsxElement` instead (see this
   * module's own doc).
   */
  propName: string
  /** The subtree written into the slot. */
  node: InsertJsxIntoSlotPropNode
  /** Only consulted when `propName === 'children'` — passed straight through to `insertJsxElement`. */
  anchorLine?: number
  anchorCol?: number
  position?: 'before' | 'after'
  /** Optional pre-existing project to reuse. */
  project?: Project
}

export type InsertSlotRefusalReason = InsertJsxRefusalReason | 'slot-ambiguous' | 'spread-attribute'

export interface InsertSlotRefusal {
  reason: InsertSlotRefusalReason
  /** Human-readable, suitable for a toast. */
  message: string
}

export type InsertJsxIntoSlotPropResult = { ok: true } | { ok: false; refusal: InsertSlotRefusal }

function refuse(reason: InsertSlotRefusalReason, message: string): { ok: false; refusal: InsertSlotRefusal } {
  return { ok: false, refusal: { reason, message } }
}

export function insertJsxIntoSlotProp(params: InsertJsxIntoSlotPropParams): InsertJsxIntoSlotPropResult {
  const { file, line, col, propName, node } = params

  // Validated before any lookup happens, same ordering `insertJsxElement`
  // uses — a bad grandchild refuses before touching the file at all.
  const invalid = validateSubtree(node)
  if (invalid) return invalid

  const project = params.project ?? createProject()
  // New import declarations synthesized below (`addRequiredImports`) follow
  // this setting rather than the file's existing style, matching every other
  // codemod in this module that synthesizes a fresh import declaration
  // (`extractComponentCopy.ts`, `extractSubtreeToComponent.ts`).
  project.manipulationSettings.set({ quoteKind: QuoteKind.Single })
  const sourceFile = loadSourceFile(project, file)

  if (propName === 'children') {
    // The default slot is the element's ordinary child list, not an
    // attribute at all — see this module's own doc for why this delegates
    // wholesale rather than reimplementing placement.
    return insertJsxElement({
      file,
      line,
      col,
      ...(params.anchorLine !== undefined && params.anchorCol !== undefined
        ? { anchorLine: params.anchorLine, anchorCol: params.anchorCol, position: params.position ?? 'after' }
        : {}),
      name: node.name,
      props: node.props,
      ...(node.importSpecifier === undefined ? {} : { importSpecifier: node.importSpecifier }),
      ...(node.children === undefined ? {} : { children: node.children }),
      project,
    })
  }

  const element = findJsxElementAtLocation(sourceFile, line, col)
  if (!element) {
    return refuse(
      'not-found',
      `No JSX element is written at line ${line}, column ${col} any more — the file changed since the canvas last read it. Reload and try again.`,
    )
  }

  const imports = collectSubtreeImports(node)
  for (const [componentName, specifier] of imports) {
    const binding = conflictingBinding(sourceFile, componentName, specifier)
    if (binding) {
      return refuse(
        'binding-conflict',
        `This file already uses the name "${componentName}" for something else (${binding}), so filling this slot would shadow it. Rename one of them in the file first.`,
      )
    }
  }

  const unit = indentUnit(sourceFile.getFullText())
  const newNodeText = renderJsxNode(node, unit)

  const existingAttribute = element.getAttribute(propName)

  if (!existingAttribute) {
    element.addAttribute({ name: propName, initializer: `{${newNodeText}}` })
  } else if (!Node.isJsxAttribute(existingAttribute)) {
    // `getAttribute(name)` only matches a spread attribute if `name` happens
    // to equal the literal text "...expr", which should never occur for a
    // real prop name — guard against silently clobbering one anyway, same
    // defensive posture `setJsxStyle`/`setJsxClassName` already take.
    return refuse(
      'spread-attribute',
      `The "${propName}" prop is a spread attribute — Studio can't tell what it currently holds, so it won't guess whether inserting here is safe.`,
    )
  } else {
    const outcome = fillExistingSlotAttribute(existingAttribute, propName, newNodeText, unit)
    if (!outcome.ok) return outcome
  }

  addRequiredImports(sourceFile, imports)
  sourceFile.saveSync()
  return { ok: true }
}

/**
 * Writes into an ALREADY-PRESENT slot attribute — the "single element" and
 * "already a fragment" cases from this module's own doc, plus the
 * `slot-ambiguous` refusal for everything else.
 */
function fillExistingSlotAttribute(
  attribute: JsxAttribute,
  propName: string,
  newNodeText: string,
  unit: string,
): InsertJsxIntoSlotPropResult {
  const initializer = attribute.getInitializer()
  const expr = initializer && Node.isJsxExpression(initializer) ? initializer.getExpression() : undefined
  if (!expr) {
    return refuse(
      'slot-ambiguous',
      `The "${propName}" prop has no JSX value to insert alongside (a valueless shorthand, a plain string, or an empty expression container) — Studio won't guess what that currently means.`,
    )
  }

  const fullText = attribute.getSourceFile().getFullText()
  const indent = lineIndent(fullText, attribute.getStart())
  const childIndent = indent + unit

  if (Node.isJsxFragment(expr)) {
    const childrenTexts = [...existingFragmentChildrenTexts(expr), newNodeText]
    attribute.setInitializer(buildFragmentInitializer(childrenTexts, indent, childIndent))
    return { ok: true }
  }
  if (Node.isJsxElement(expr) || Node.isJsxSelfClosingElement(expr)) {
    attribute.setInitializer(buildFragmentInitializer([expr.getText(), newNodeText], indent, childIndent))
    return { ok: true }
  }
  return refuse(
    'slot-ambiguous',
    `The "${propName}" prop is set to an expression ("${expr.getText()}") rather than JSX markup — Studio can't tell whether that currently means "empty" or is a real binding, so it refuses rather than guess.`,
  )
}

/** The element children of an existing fragment, verbatim — whitespace/expression children excluded. */
function existingFragmentChildrenTexts(fragment: JsxFragment): string[] {
  const texts: string[] = []
  for (const child of fragment.getJsxChildren()) {
    if (Node.isJsxElement(child) || Node.isJsxSelfClosingElement(child)) texts.push(child.getText())
  }
  return texts
}

/**
 * `{<>\n  <A/>\n  <B/>\n</>}` — every child on its own line at `childIndent`,
 * closed at `indent`. See this module's own doc for why this rebuilds the
 * fragment's whitespace from scratch instead of preserving it byte-for-byte.
 */
function buildFragmentInitializer(childrenTexts: readonly string[], indent: string, childIndent: string): string {
  const lines = childrenTexts.map((text) => `${childIndent}${indentBlock(text, childIndent)}`)
  return `{<>\n${lines.join('\n')}\n${indent}</>}`
}

/** Prefix every line after the first with `indent` — the first line already sits at the caller's own prefix. */
function indentBlock(block: string, indent: string): string {
  return indent.length === 0 ? block : block.split('\n').join(`\n${indent}`)
}

/** The leading whitespace of the line `pos` sits on. */
function lineIndent(text: string, pos: number): string {
  const lineStart = text.lastIndexOf('\n', pos - 1) + 1
  let i = lineStart
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i += 1
  return text.slice(lineStart, i)
}

/**
 * Structural (non-byte-splice) import merge: an existing declaration for the
 * same specifier gains a named import if it doesn't already have this name; a
 * new specifier gets a whole new declaration. Mirrors
 * `extractComponentCopy.ts`'s `repointImport`/`extractSubtreeToComponent.ts`'s
 * `addReconciledImports` in spirit, but simpler — those two also have to
 * MIRROR an import from a source binding's own declaration; this one only
 * ever writes the `(name, specifier)` pairs the caller's subtree already
 * names explicitly, so there is no binding to trace.
 */
function addRequiredImports(sourceFile: SourceFile, required: ReadonlyMap<string, string>): void {
  for (const [name, specifier] of required) {
    const existing = sourceFile.getImportDeclarations().find((d) => d.getModuleSpecifierValue() === specifier)
    if (existing) {
      const already = existing.getNamedImports().some((n) => (n.getAliasNode() ?? n.getNameNode()).getText() === name)
      if (!already) existing.addNamedImport(name)
      continue
    }
    sourceFile.addImportDeclaration({ moduleSpecifier: specifier, namedImports: [name] })
  }
}
